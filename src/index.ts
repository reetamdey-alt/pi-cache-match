import type {
	AfterProviderResponseEvent,
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent/extensions/types";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	resolveConfig,
	safeString,
	hashString,
	type CacheMatchConfig,
} from "./config.ts";
import { emptyParentHash, hashBlock } from "./fingerprint.ts";
import {
	buildSegmentInfo,
	normalizeVolatileContent,
	renderMessagesToPrompt,
} from "./prompt.ts";
import { splitIntoBlocks, Tokenizer } from "./tokenize.ts";
import type {
	AgentCascadeStats,
	BackendId,
	CacheBreakReason,
	CacheMatchEvent,
	CacheMatchObservation,
	CacheMatchPrediction,
	CallType,
	CompletionContext,
	Confidence,
} from "./types.ts";

function getBackend(model: string, provider?: string): BackendId {
	const p = (provider || "").toLowerCase();
	const m = (model || "").toLowerCase();
	if (p.includes("anthropic") || m.includes("claude")) return "anthropic";
	if (p.includes("openai") || m.includes("gpt") || m.includes("o1") || m.includes("o3")) return "openai";
	if (p.includes("bedrock")) return "bedrock";
	if (p.includes("vllm")) return "vllm";
	if (p.includes("sglang")) return "sglang";
	return "unknown_backend";
}

function getCacheNamespace(orgId: string, appId: string, sessionId: string, cacheSalt: string): string {
	// When the user hasn't set PI_CACHE_MATCH_SALT, the salt is random per process.
	// Include it in the hash ONLY when the caller explicitly configured one;
	// otherwise derive the namespace deterministically from (org|app|session) so
	// the cache namespace is stable across pi processes (per doc §21.2 cross-process
	// MVP requirement — separate pi --continue runs should still match lineage).
	const saltPart = cacheSalt.startsWith("salt-") ? "" : `|${cacheSalt}`;
	return hashString(`ns|${orgId}|${appId}|${sessionId}${saltPart}`).slice(0, 16);
}

function getExtraCacheKeys(ctx: ExtensionContext): Record<string, string> {
	const keys: Record<string, string> = {};
	if (ctx.model?.id) keys.model = safeString(ctx.model.id, 64);
	if (ctx.model?.provider) keys.provider = safeString(ctx.model.provider, 64);
	return keys;
}

function extractSessionInfo(branch: unknown[]): { sessionId: string; messages: AgentMessage[] } {
	let sessionId = "sess_unknown";
	const messages: AgentMessage[] = [];
	for (const entry of branch) {
		const record = entry as Record<string, unknown> | null;
		if (!record || typeof record !== "object") continue;
		if (record.type === "session" && typeof record.id === "string") {
			sessionId = safeString(record.id, 128) || sessionId;
		}
		if (record.type === "message" && record.message) {
			messages.push(record.message as AgentMessage);
		}
	}
	return { sessionId, messages };
}

interface CallFrame {
	callId: string;
	parentCallId: string;
	/** "agent" frames come from agent_start; "turn" frames come from turn_start.
	 * Depth used for doc §9.1 callType attribution = number of "agent" frames only. */
	kind: "agent" | "turn";
}

interface PredictionRecord {
	prediction: CacheMatchPrediction;
	blockHashes: string[];
	canonicalBlockHashes: string[];
	pending: boolean;
	createdAt: number;
}

interface SessionState {
	sessionId: string;
	turnId: string;
	rootCallId: string;
	callStack: CallFrame[];
	callIndex: number;
	stats: {
		byModel: Record<string, AgentCascadeStats>;
		byCallType: Record<string, AgentCascadeStats>;
		byBreakReason: Record<string, AgentCascadeStats>;
	};
	lastEvent?: CacheMatchEvent;
	lastMatch?: CacheMatchPrediction;
	/** Doc §21: LRU-bounded cache index — key = cacheKeyRoot or `${cacheKeyRoot}#canonical`. */
	latestFingerprints: Map<string, { blockHashes: string[]; updatedAt: number }>;
	/** Prevents re-seeding the call ordinal from the shard more than once per process. */
	callIndexSeededFromShard?: boolean;
	/** Pending prediction awaiting usage via message_end. */
	pendingPrediction?: PredictionRecord;
	/** Latest usage + latency observed from message_end stream. */
	lastUsage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
	lastUsageAt?: number;
	lastTurnIndex?: number;
	/** Doc §12.4: remember the strongest prior prefix match we saw under each root,
	 * so a sudden drop to zero can be flagged as cache clobbering. */
	bestMatchByRoot: Map<string, number>;
}

export default function (pi: ExtensionAPI) {
	let config: CacheMatchConfig | undefined;
	let tokenizer: Tokenizer | undefined;
	let state: SessionState | undefined;
	let telemetryDir = "";

	/** §23.3-style debug logger — writes to stderr ONLY when PI_CACHE_MATCH_DEBUG=1.
	 * Default off. Never leaks prompt content; only structural markers. */
	function dbg(tag: string, kv: Record<string, unknown> = {}): void {
		const cfg = config;
		if (!cfg?.debugMode) return;
		try {
			const parts = Object.entries(kv).map(([k, v]) => `${k}=${String(v)}`);
			// eslint-disable-next-line no-console
			console.error(`[pi-cache-match] ${tag}${parts.length > 0 ? " " + parts.join(" ") : ""}`);
		} catch {
			/* never break the agent */
		}
	}

	function ensureConfig(): CacheMatchConfig {
		config ??= resolveConfig(process.cwd());
		tokenizer ??= new Tokenizer(config);
		telemetryDir = config.telemetryDir;
		return config;
	}

	function ensureState(_ctx?: ExtensionContext): SessionState {
		if (!state) {
			state = {
				sessionId: "sess_unknown",
				turnId: `turn_${"sess_unknown"}`,
				rootCallId: `call_${"sess_unknown"}`,
				callStack: [],
				callIndex: 0,
				stats: { byModel: {}, byCallType: {}, byBreakReason: {} },
				latestFingerprints: new Map(),
				bestMatchByRoot: new Map(),
			};
		}
		return state;
	}

	/** Doc §21.2: cross-process fingerprint persistence.
	 * Pi launches a fresh process per turn; the in-memory Map is useless across turns.
	 * Persist the last-known block hash chain per cacheKeyRoot to a JSONL shard so a
	 * new pi process can resume matching.
	 *
	 * Storage is one JSON-line per (cacheKeyRoot, kind) write, with the LATEST line
	 * for each key being authoritative. Loaded lazily on first access per state. */
	function persistencePath(cfg: CacheMatchConfig): string {
		// Store the cross-process shard INSIDE telemetryDir — conveniently co-resident
		// — but give it a name the telemetry readers can filter out (suffix "-index").
		return join(cfg.telemetryDir, "_fingerprint-index.jsonl");
	}

	function loadPersistedFingerprints(st: SessionState, cfg: CacheMatchConfig): void {
		if (st.latestFingerprints.size > 0) return; // already loaded or populated this process
		const file = persistencePath(cfg);
		try {
			if (!existsSync(file)) return;
			const raw = readFileSync(file, "utf8");
			const latest = new Map<string, { blockHashes: string[]; updatedAt: number }>();
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const rec = JSON.parse(line) as { k?: string; h?: string[]; t?: number };
					if (typeof rec.k === "string" && Array.isArray(rec.h)) {
						latest.set(rec.k, { blockHashes: rec.h, updatedAt: typeof rec.t === "number" ? rec.t : 0 });
					}
				} catch {
					/* skip corrupt line */
				}
			}
			// Enforce LRU budget from the start: keep the newest maxSessionIndexEntries keys.
			const sorted = [...latest.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
			for (const [k, v] of sorted.slice(0, cfg.maxSessionIndexEntries)) {
				st.latestFingerprints.set(k, v);
			}
		} catch {
			/* persistence is best-effort */
		}
	}

	function persistFingerprint(cfg: CacheMatchConfig, key: string, blockHashes: string[]): void {
		try {
			mkdirSync(cfg.telemetryDir, { recursive: true });
			const file = persistencePath(cfg);
			writeFileSync(
				file,
				`${JSON.stringify({ k: key, h: blockHashes, t: Date.now() })}\n`,
				{ flag: "a" },
			);
			// Compact when the shard has grown past ~4x the LRU budget — rewrite with
			// only the newest entry per key. Prevents unbounded growth over many sessions.
			const stat = statSync(file, { throwIfNoEntry: false });
			if (stat && stat.size > cfg.maxSessionIndexEntries * 512) {
				compactFingerprintShard(cfg);
			}
		} catch {
			/* persistence is best-effort */
		}
	}

	function compactFingerprintShard(cfg: CacheMatchConfig): void {
		const file = persistencePath(cfg);
		try {
			if (!existsSync(file)) return;
			const raw = readFileSync(file, "utf8");
			const latest = new Map<string, { blockHashes: string[]; t: number }>();
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const rec = JSON.parse(line) as { k?: string; h?: string[]; t?: number };
					if (typeof rec.k === "string" && Array.isArray(rec.h)) {
						latest.set(rec.k, { blockHashes: rec.h, t: typeof rec.t === "number" ? rec.t : 0 });
					}
				} catch {
					/* skip */
				}
			}
			const sorted = [...latest.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, cfg.maxSessionIndexEntries);
			const out = sorted.map(([k, v]) => JSON.stringify({ k, h: v.blockHashes, t: v.t })).join("\n");
			if (out) writeFileSync(file, out + "\n");
		} catch {
			/* best-effort */
		}
	}

	/** Doc §21.1 LRU touch — Map preserves insertion order, so re-insert to bump recency. */
	function fingerprintGet(
		st: SessionState,
		key: string,
	): { blockHashes: string[]; updatedAt: number } | undefined {
		const hit = st.latestFingerprints.get(key);
		if (!hit) return undefined;
		st.latestFingerprints.delete(key);
		st.latestFingerprints.set(key, hit);
		return hit;
	}

	/** Doc §21.1 LRU set — evict oldest when over budget. */
	function fingerprintSet(
		st: SessionState,
		key: string,
		value: { blockHashes: string[]; updatedAt: number },
		budget: number,
	): void {
		if (st.latestFingerprints.has(key)) st.latestFingerprints.delete(key);
		st.latestFingerprints.set(key, value);
		while (st.latestFingerprints.size > budget) {
			const oldest = st.latestFingerprints.keys().next().value;
			if (oldest === undefined) break;
			st.latestFingerprints.delete(oldest);
		}
	}

	function nextCallId(): string {
		return "call_" + Math.random().toString(36).slice(2, 12);
	}

	// ─── prompt reconstruction ────────────────────────────────────────────────

	interface ReconstructedPrompt {
		text: string;
		source: "provider_payload" | "session_history" | "empty";
		messageCount: number;
		systemPromptLen: number;
		rawMessages: AgentMessage[];
	}

	/**
	 * Try to pull the real provider request body from before_provider_request's payload.
	 * This is the only place pi hands us the exact string[] that hit the wire.
	 * Shape (all major providers): { messages: [{role, content}, ...], system?: string|array, model: string }.
	 */
	function promptFromPayload(payload: unknown): ReconstructedPrompt | undefined {
		if (!payload || typeof payload !== "object") return undefined;
		const p = payload as Record<string, unknown>;
		const rawMessages = Array.isArray(p.messages) ? (p.messages as unknown[]) : undefined;
		if (!rawMessages || rawMessages.length === 0) return undefined;
		const systemPromptRaw = p.system;
		let systemPrompt = "";
		if (typeof systemPromptRaw === "string") systemPrompt = systemPromptRaw;
		else if (Array.isArray(systemPromptRaw)) {
			systemPrompt = (systemPromptRaw as Array<Record<string, unknown>>)
				.map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
				.filter(Boolean)
				.join("\n");
		}
		// Doc §15: tool_list_change is a cache-break class. Include a hash of the
		// sorted tool names+schemas in the prompt — otherwise the extension can't
		// tell a "same messages, different tools" replay apart from a real repeat.
		// (The hash is not content; it's safe to embed without violating §13.)
		const toolsRaw = p.tools;
		let toolsHeader: string | undefined;
		if (Array.isArray(toolsRaw) && toolsRaw.length > 0) {
			const toolsSummary = toolsRaw
				.map((t) => {
					const r = t as Record<string, unknown>;
					const name = typeof r?.name === "string" ? r.name : "";
					const schemaKey = JSON.stringify(r?.input_schema ?? r?.parameters ?? {});
					return `${name}#${hashString(schemaKey)}`;
				})
				.sort()
				.join("|");
			toolsHeader = `<|im_start|>tools ${toolsSummary}<|im_end|>\n`;
		}
		const parts: string[] = [];
		if (systemPrompt.trim().length > 0) parts.push(`<|im_start|>system\n${systemPrompt}<|im_end|>\n`);
		if (toolsHeader) parts.push(toolsHeader);
		for (const raw of rawMessages) {
			if (!raw || typeof raw !== "object") continue;
			const m = raw as Record<string, unknown>;
			const role = typeof m.role === "string" ? m.role : "user";
			const content = m.content;
			if (typeof content === "string") {
				parts.push(`<|im_start|>${role}\n${content}<|im_end|>\n`);
			} else if (Array.isArray(content)) {
				const textParts: string[] = [];
				for (const c of content) {
					if (c && typeof c === "object") {
						const cc = c as Record<string, unknown>;
						if (cc.type === "text" && typeof cc.text === "string") textParts.push(cc.text);
						else if (cc.type === "tool_use" && typeof cc.name === "string")
							textParts.push(`<tool_call name="${cc.name}">${JSON.stringify(cc.input ?? {})}</tool_call>`);
						else if (cc.type === "tool_result" && typeof cc.content === "string") textParts.push(cc.content);
					}
				}
				parts.push(`<|im_start|>${role}\n${textParts.join("\n")}<|im_end|>\n`);
			}
		}
		return {
			text: parts.join(""),
			source: "provider_payload",
			messageCount: rawMessages.length,
			systemPromptLen: systemPrompt.length,
			rawMessages: rawMessages as AgentMessage[],
		};
	}

	function promptFromSessionHistory(ctx: ExtensionContext): ReconstructedPrompt | undefined {
		const branch = ctx.sessionManager?.getBranch?.();
		const { messages } = extractSessionInfo(Array.isArray(branch) ? (branch as unknown[]) : []);
		if (messages.length === 0) return undefined;
		const systemPrompt = ctx.getSystemPrompt?.() ?? "";
		return {
			text: renderMessagesToPrompt(systemPrompt, messages),
			source: "session_history",
			messageCount: messages.length,
			systemPromptLen: systemPrompt.length,
			rawMessages: messages,
		};
	}

	// ─── beforeCompletion hook (design doc §9.1) ──────────────────────────────

	function beforeCompletion(ctx: ExtensionContext, payload?: unknown): CacheMatchPrediction | undefined {
		const cfg = ensureConfig();
		const st = ensureState(ctx);
		dbg("beforeCompletion", { has_payload: payload !== undefined });
		const branch = ctx.sessionManager?.getBranch?.();
		const fromManager = (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
		const { sessionId: branchSessionId } = extractSessionInfo(Array.isArray(branch) ? (branch as unknown[]) : []);
		const sessionId =
			typeof fromManager === "string" && fromManager.length > 0 ? safeString(fromManager, 128) : branchSessionId;
		st.sessionId = sessionId;

		const model = safeString(ctx.model?.id) || "unknown";
		const provider = safeString(ctx.model?.provider) || undefined;
		const backend = getBackend(model, provider);

		// Prefer real wire data from before_provider_request; fall back to recon
		const recon = (payload !== undefined ? promptFromPayload(payload) : undefined) ?? promptFromSessionHistory(ctx);
		dbg("recon", { source: recon?.source ?? "none", len: recon?.text.length ?? 0 });
		if (!recon || recon.text.length === 0) return undefined;

		const actualPrompt = recon.text;
		const canonicalPrompt = normalizeVolatileContent(actualPrompt);

		const actualTokenIds = (tokenizer ??= new Tokenizer(cfg)).encode(actualPrompt, { model }).tokenIds;
		const canonicalTokenIds = (tokenizer ??= new Tokenizer(cfg)).encode(canonicalPrompt, { model }).tokenIds;
		const { fullBlocks: actualBlocks, partialBlock: actualTail } = splitIntoBlocks(actualTokenIds, cfg.blockSizeTokens);
		const { fullBlocks: canonicalBlocks, partialBlock: canonicalTail } = splitIntoBlocks(canonicalTokenIds, cfg.blockSizeTokens);

		const cacheNamespace = getCacheNamespace(cfg.orgId, cfg.appId, sessionId, cfg.cacheSalt);
		// NOTE: callIndex is assigned further below, AFTER loadPersistedFingerprints —
		// the cross-process ordinal seed has to read the shard before we pre-increment.
		const extraCacheKeys = getExtraCacheKeys(ctx);
		const callId = nextCallId();
		const parentCallId = st.callStack.length > 0 ? st.callStack[st.callStack.length - 1].callId : undefined;
		const cacheKeyRoot = hashString(`root|${cfg.orgId}|${cfg.appId}|${sessionId}|${model}|${cacheNamespace}`);

		// Doc §9.1 callType: depth is number of ACTIVE agent frames (kind === "agent"),
		// so a root agent's own turn is depth 1, a subagent inside is depth 2, etc.
		const agentDepth = st.callStack.filter((f) => f.kind === "agent").length;
		const rootFrame = st.callStack.find((f) => f.kind === "agent");

		// Chain-hash actual blocks
		const blockHashes: string[] = [];
		let parentHash: string = emptyParentHash;
		for (const block of actualBlocks) {
			parentHash = hashBlock({
				fingerprintVersion: cfg.fingerprintVersion,
				model,
				tokenizerVersion: cfg.tokenizerVersion,
				templateVersion: cfg.templateVersion,
				cacheNamespace,
				parentHash,
				tokenIds: block,
				extraCacheKeys,
			});
			blockHashes.push(parentHash);
		}
		// Chain-hash canonical blocks
		const canonicalBlockHashes: string[] = [];
		parentHash = emptyParentHash;
		for (const block of canonicalBlocks) {
			parentHash = hashBlock({
				fingerprintVersion: cfg.fingerprintVersion,
				model,
				tokenizerVersion: cfg.tokenizerVersion,
				templateVersion: cfg.templateVersion,
				cacheNamespace,
				parentHash,
				tokenIds: block,
				extraCacheKeys,
			});
			canonicalBlockHashes.push(parentHash);
		}

		// Cross-process: load any previously persisted fingerprints (§21.2 MVP shard).
		loadPersistedFingerprints(st, cfg);

		// Resume the per-session call ordinal across process restarts. Pi/pi-mono
		// CLI launches a fresh extension process per turn (each CLI invocation runs
		// one turn then exits), so a purely in-memory counter restarts at 0 every
		// turn — telemetry then shows `call_index=0` for every turn of a long
		// session. The fingerprint shard is the only state that survives across
		// processes, so piggyback the ordinal on it via a reserved loopback key.
		// The value is session-scoped (keyed under this cacheKeyRoot) — a DIFFERENT
		// session has a different cacheKeyRoot and correctly starts at 0. Within a
		// process the first call reads the shard; subsequent calls use the
		// in-memory counter, which is already ahead.
		if (!st.callIndexSeededFromShard) {
			st.callIndexSeededFromShard = true;
			const persistedOrdinal = fingerprintGet(st, `${cacheKeyRoot}#call`);
			if (persistedOrdinal && persistedOrdinal.blockHashes.length === 1) {
				// Base-36 encoded, so a real block hash (16-hex) can never collide with
		// this slot's contents in the LCP comparator — parse failures simply skip.
		const shardValue = Number.parseInt(persistedOrdinal.blockHashes[0]!, 36);
				if (Number.isFinite(shardValue) && shardValue >= st.callIndex) {
					st.callIndex = shardValue;
				}
			}
		}
		const callIndex = st.callIndex++;

		// Prefix LCP match against the last stored lineage for this cacheKeyRoot
		const previous = fingerprintGet(st, cacheKeyRoot);
		let matchedBlocks = 0;
		let matchedFrom: "actual" | "canonical" | "none" = "none";
		if (previous && previous.blockHashes.length > 0) {
			const min = Math.min(previous.blockHashes.length, blockHashes.length);
			for (let i = 0; i < min; i++) {
				if (previous.blockHashes[i] === blockHashes[i]) matchedBlocks++;
				else break;
			}
			if (matchedBlocks > 0) matchedFrom = "actual";
		}
		// Canonical twin check
		let canonicalMatchedBlocks = 0;
		if (previous && previous.blockHashes.length > 0) {
			const prevCanonicalEntry = fingerprintGet(st, `${cacheKeyRoot}#canonical`);
			if (prevCanonicalEntry && prevCanonicalEntry.blockHashes.length > 0) {
				const minC = Math.min(prevCanonicalEntry.blockHashes.length, canonicalBlockHashes.length);
				for (let i = 0; i < minC; i++) {
					if (prevCanonicalEntry.blockHashes[i] === canonicalBlockHashes[i]) canonicalMatchedBlocks++;
					else break;
				}
				// Canonical is a diagnostic track — only claim it when it strictly
			// beat actual. On ties, report "actual" — honest signal that the wire
			// prompt itself matched, volatility normalization wasn't the differentiator.
			if (canonicalMatchedBlocks > matchedBlocks) {
				matchedFrom = "canonical";
			}
			}
		}

		const matched = Math.max(matchedBlocks, canonicalMatchedBlocks);
		const predictedMatchedTokens = matched * cfg.blockSizeTokens;
		// Doc §7.1: emit both token- and block-level match %s. They intentionally
		// CAN differ: the trailing partial block never matches (backends only cache
		// full blocks), so block_match_pct divides by full-block count while
		// token_match_pct divides by the true token total.
		const blockMatchPct = blockHashes.length > 0 ? matched / blockHashes.length : 0;
		const tokenMatchPct = actualTokenIds.length > 0 ? predictedMatchedTokens / actualTokenIds.length : 0;
		// Doc §20 pseudocode's authoritative definition:
		//   predictedMatchedPct = matchedTokens / totalTokens
		// Block-level percentage is the backend-faithful figure; token-level is the
		// doc-canonical primary metric (§7.1 "Token-level percentage is easier for
		// humans and dashboards"). The doc is internally split: §20 pseudocode returns
		// token pct as `predictedMatchPct` while §18's routing-score MVP says
		// `cache_affinity_score = predicted_match_pct`. We resolve by making BOTH true:
		//   predicted_match_pct = token_match_pct  (doc-canonical per §§7.1 & 20)
		//   cache_affinity_score = block_match_pct (backend-faithful per §11.4/§18 intent)
		const predictedMatchPct = tokenMatchPct;
		const canonicalMatched = canonicalMatchedBlocks * cfg.blockSizeTokens;
		const volatilityDeltaTokens = Math.max(canonicalMatched - predictedMatchedTokens, 0);

		// Doc §12.4 cache clobbering: if this root previously matched ≥ X tokens and now
		// sees 0 (with lineage present), flag it so observability can alert on the regression.
		const priorBest = st.bestMatchByRoot.get(cacheKeyRoot) ?? 0;
		const cacheClobberingDetected = matchedBlocks === 0 && priorBest >= 4 * cfg.blockSizeTokens;
		const cacheClobberingExpectedTokens = cacheClobberingDetected ? priorBest : undefined;
		if (matched > priorBest) st.bestMatchByRoot.set(cacheKeyRoot, matched * cfg.blockSizeTokens);

		// ─── cache-break diagnosis (design doc §17/§18) ─────────────────────
		let firstMismatchBlockIndex: number | undefined;
		let firstMismatchMessageIndex: number | undefined;
		let firstMismatchRegion: string | undefined;
		let suspectedBreakReason: CacheBreakReason = null;
		let diagnosisNote: string | undefined;

		if (previous && previous.blockHashes.length > 0 && matchedBlocks < blockHashes.length) {
			firstMismatchBlockIndex = matchedBlocks;
			const segments = buildSegmentInfo(recon.rawMessages, []);
			const seg = segments[Math.min(matchedBlocks, Math.max(segments.length - 1, 0))];
			// Doc §17/§18: distinguish "append" (a pure prefix extension) from a genuine
			// rewrite. Append is the common, benign case — it must NOT surface as
			// `history_rewrite` because it signals the model only ADDED new content.
			// Signature: matchedBlocks covers the entirety of the PREVIOUS lineage
			// (so the prior prompt is fully a prefix of the current one). The chained
			// fingerprint breaks at the FIRST token-byte that diverges, and the previous
			// prompt almost never ends on an exact block boundary — the block straddling
			// the old/new junction holds bytes from both the previous tail and the new
			// head, so its hash differs even when nothing was rewritten. An honest
			// append therefore matches previous.blockHashes.length - 1 blocks (the
			// last full block of the previous prompt is sacrificed to cover the
			// straddling junction) or more.
			const isAppend = matchedBlocks >= previous.blockHashes.length - 1;
			// Doc §17 system_prompt_change: the leading region (system prompt +
			// tools header) is rendered BEFORE messages[0]. When recon.source is
			// "session_history" there is no dedicated prompt segment in rawMessages,
			// so buildSegmentInfo can never produce seg.source === "prompt" — the
			// break is only visible as blockHashes[0] diverging while the first
			// user-visible message region (seg[0]) is still intact. Detect it
			// structurally: 0 matched blocks + rendered system-prompt prefix.
			if (!isAppend && matchedBlocks === 0 && previous.blockHashes[0] !== blockHashes[0]
				&& recon.systemPromptLen > 0) {
				suspectedBreakReason = "system_prompt_change";
				diagnosisNote = "leading prompt region (system prompt / tools header) changed";
				firstMismatchMessageIndex = 0;
				firstMismatchRegion = "system";
			} else if (seg && !isAppend) {
				firstMismatchMessageIndex = seg.messageIndex;
				firstMismatchRegion = seg.regionLabel;
				if (seg.source === "prompt") suspectedBreakReason = "system_prompt_change";
				else if (seg.toolNames.length > 0) {
					const normalizedSegRole = normalizeVolatileContent(seg.regionLabel);
					if (normalizedSegRole.includes("[TIMESTAMP]")) {
						suspectedBreakReason = "volatility";
						diagnosisNote = "timestamps in tool outputs are the likely break";
					} else {
						suspectedBreakReason = "history_rewrite";
						diagnosisNote = `tool output changed in ${seg.regionLabel}`;
					}
				} else {
					suspectedBreakReason = "history_rewrite";
					diagnosisNote = `messages diverged at ${seg.regionLabel}`;
				}
			} else if (isAppend) {
				// Nothing to blame — mark the region index (where new content starts)
				// but leave suspectedBreakReason null / diagnosisNote explaining the
				// growth. The doc doesn't demand a reason for appends.
				if (seg) {
					firstMismatchMessageIndex = seg.messageIndex;
					firstMismatchRegion = seg.regionLabel;
				}
				// 'history_rewrite' deliberately NOT set here: an append keeps the
				// lineage intact, asserting a rewrite would be a false-positive.
				diagnosisNote = `prompt grew by ${blockHashes.length - matchedBlocks} trailing block(s)`;
			}
			if (matchedBlocks === 0 && previous.blockHashes[0] !== blockHashes[0]
				&& suspectedBreakReason === null) {
				suspectedBreakReason = "session_restart";
				diagnosisNote = "first block differs from previous cache entry";
			}
		}

		// ─── confidence model (design doc §22 tokenizer-quality table) ────
		// Confidence is a property of HOW the token stream was produced, not of
		// warmup state. Doc's grade map:
		//   backend token IDs              → high
		//   local exact model tokenizer    → high
		//   local compatible tokenizer     → medium
		//   approximate char/token heuristic → low
		// Session-history reconstruction degrades one notch because the reconstruction
		// can diverge from the true wire bytes even with a perfect tokenizer. Lacking a
		// prior fingerprint does NOT change confidence — the tokenizer quality didn't
		// change; only the prediction outcome did. (Doc §22's low-confidence bucket is
		// the correct signal for "this is an estimate.")
		const confidenceReasons: string[] = [];
		let confidence: Confidence = "high";
		if (recon.source === "session_history") {
			confidence = "medium";
			confidenceReasons.push("prompt reconstructed from session history, not wire payload");
		}
		if ((tokenizer?.getConfidence() ?? "low") === "low") {
			confidence = "low";
			confidenceReasons.push("approximate char/token heuristic tokenizer (doc §22 → low)");
		}
		if (!previous) {
			confidenceReasons.push("no prior fingerprint for this cache root (informational, not a confidence signal)");
		}

		// ─── build the prediction record ────────────────────────────────────
		const callType: CallType =
			agentDepth >= 2 ? "subagent" : agentDepth === 1 ? "root_user_turn" : "agent_turn";

		const prediction: CacheMatchPrediction = {
			callId,
			parentCallId,
			// root_call_id = outermost agent frame; falls back to this call when no frames.
			rootCallId: rootFrame?.callId ?? callId,
			callType,
			agentId: cfg.agentId,
			subagentId: callType === "subagent" ? callId : undefined,
			// trace_id = always the outermost agent's call id so the cascade can be
			// re-grouped by trace. Falls back to callId when there's no agent frame.
			traceId: rootFrame?.callId ?? callId,
			appId: cfg.appId,
			orgId: cfg.orgId,
			sessionId,
			turnId: st.turnId,
			callIndex,
			cacheKeyRoot,
			cacheNamespace,
			provider,
			backend,
			model,
			depth: agentDepth,
			timestamp: new Date().toISOString(),
			templateVersion: cfg.templateVersion,
			tokenizerVersion: cfg.tokenizerVersion,
			templateHash: cfg.templateVersion ? cfg.templateVersion : "",
			tokenizerHash: cfg.tokenizerVersion ? cfg.tokenizerVersion : "",
			fingerprintVersion: cfg.fingerprintVersion,
			totalPromptTokens: actualTokenIds.length,
			totalFullBlocks: actualBlocks.length,
			partialBlockTokens: actualTail ? actualTail.length : 0,
			blockSizeTokens: cfg.blockSizeTokens,
			predictedMatchedBlocks: matchedBlocks,
			predictedMatchedTokens,
			predictedMatchPct,
			tokenMatchPct,
			blockMatchPct,
			matchedFrom,
			canonicalMatchedTokens: canonicalMatched,
			// Canonical pct compares canonical-vs-canonical; dividing by the ACTUAL
		// block count would mix two tokenisations and silently skew the ratio when
		// volatility normalization changes the prompt length.
		canonicalMatchedPct: canonicalBlockHashes.length > 0 ? canonicalMatchedBlocks / canonicalBlockHashes.length : 0,
			volatilityDeltaTokens,
			firstMismatchBlockIndex,
			firstMismatchMessageIndex,
			firstMismatchRegion,
			suspectedBreakReason: cacheClobberingDetected ? "history_rewrite" : suspectedBreakReason,
			diagnosisNote: cacheClobberingDetected
				? `cache clobbering: expected ~${cacheClobberingExpectedTokens} tokens, matched 0`
				: diagnosisNote,
			cacheClobberingDetected: cacheClobberingDetected || undefined,
			cacheClobberingExpectedTokens,
			confidence,
			confidenceReasons,
		};

		// Store fingerprints for the next call (lineage). LRU-bounded. Persist for cross-process.
		fingerprintSet(st, cacheKeyRoot, { blockHashes, updatedAt: Date.now() }, cfg.maxSessionIndexEntries);
		fingerprintSet(st, `${cacheKeyRoot}#canonical`, { blockHashes: canonicalBlockHashes, updatedAt: Date.now() }, cfg.maxSessionIndexEntries);
		persistFingerprint(cfg, cacheKeyRoot, blockHashes);
		persistFingerprint(cfg, `${cacheKeyRoot}#canonical`, canonicalBlockHashes);
		// Carry the session-scoped call ordinal to the next process through the
		// same shard. The "hash" slot carries the NEXT ordinal in base-36 (never a
		// real block hash — fingerprints are 16-hex), and the reader treats it as
		// metadata, never as an LCP candidate.
		fingerprintSet(
			st,
			`${cacheKeyRoot}#call`,
			{ blockHashes: [st.callIndex.toString(36)], updatedAt: Date.now() },
			cfg.maxSessionIndexEntries,
		);
		persistFingerprint(cfg, `${cacheKeyRoot}#call`, [st.callIndex.toString(36)]);

		prediction.storeForNext = (key: string, blocks: { blockHashes: string[]; updatedAt: number }) => {
			fingerprintSet(st, key, blocks, cfg.maxSessionIndexEntries);
		};

		// Save as pending prediction so afterCompletion can pair with backend truth
		st.pendingPrediction = {
			prediction,
			blockHashes,
			canonicalBlockHashes,
			pending: true,
			createdAt: Date.now(),
		};

		st.lastMatch = prediction;
		return prediction;
	}

	// ─── afterCompletion — observe-only, reads stream-provided usage ───────────
	// Called from message_end (where pi's actual `usage` is exposed) and from
	// after_provider_response (status + headers only).

	function afterCompletionFromMessageEnd(
		ctx: ExtensionContext,
		event: MessageEndEvent,
	): CacheMatchObservation | undefined {
		const st = ensureState(ctx);
		const pending = st.pendingPrediction;
		if (!pending || !pending.pending) return undefined;

		const message = event.message as unknown as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") return undefined;
		const usageRec = message.usage as Record<string, unknown> | undefined;

		const usageInput = typeof usageRec?.input === "number" ? usageRec.input : undefined;
		const usageOutput = typeof usageRec?.output === "number" ? usageRec.output : undefined;
		const usageCacheRead = typeof usageRec?.cacheRead === "number" ? usageRec.cacheRead : undefined;
		const usageCacheWrite = typeof usageRec?.cacheWrite === "number" ? usageRec.cacheWrite : undefined;

		pending.pending = false;
		st.lastUsage = {
			input: usageInput,
			output: usageOutput,
			cacheRead: usageCacheRead,
			cacheWrite: usageCacheWrite,
			totalTokens: typeof usageRec?.totalTokens === "number" ? usageRec.totalTokens : undefined,
			cost: usageRec?.cost as SessionState["lastUsage"] extends { cost?: infer C } ? C : never,
		};
		st.lastUsageAt = Date.now();

		const observation: CacheMatchObservation = {
			backendObserved: usageCacheRead !== undefined,
			backendPrefixCacheHits: usageCacheRead !== undefined ? String(usageCacheRead) : "",
			backendPrefixCacheQueries: usageInput !== undefined ? String(usageInput) : "",
			backendPrefixCacheHitPct:
				usageCacheRead !== undefined && usageInput !== undefined && usageInput > 0
					? usageCacheRead / usageInput
					: undefined,
			backendPromptTokensCached: usageCacheRead !== undefined ? String(usageCacheRead) : "",
			backendActualCachedReadTokens: usageCacheRead,
			backendActualCacheHitPct:
				usageCacheRead !== undefined && usageInput !== undefined && usageInput + usageCacheRead > 0
					? usageCacheRead / (usageInput + usageCacheRead)
					: undefined,
			usageInput,
			usageOutput,
			usageCacheRead,
			usageCacheWrite,
			predictionActualDelta:
				usageCacheRead !== undefined && pending.prediction.predictedMatchedTokens > 0
					? usageCacheRead - pending.prediction.predictedMatchedTokens
					: undefined,
		};
		return observation;
	}

	function afterCompletionFromProviderResponse(
		_ctx: ExtensionContext,
		event: AfterProviderResponseEvent,
	): CacheMatchObservation | undefined {
		// after_provider_response only carries status + headers.
		// We capture the observed status so the appended event carries real wire info,
		// but leave usage fields to message_end.
		const st = ensureState();
		const pending = st.pendingPrediction;
		if (!pending || !pending.pending) return undefined;
		// Don't clear pending here — message_end will do that with real usage.
		// We just annotate the prediction that the provider responded.
		// Status/headers are not currently surfaced on the telemetry event — if needed
		// the schema can grow `http_status`/`headers_subset`. For now we keep the event minimal.
		void event;
		return undefined;
	}

	// ─── emit + rollup ───────────────────────────────────────────────────────

	function emitEvent(
		prediction: CacheMatchPrediction,
		observation: CacheMatchObservation | undefined,
	): CacheMatchEvent | undefined {
		const cfg = ensureConfig();
		const st = ensureState();
		const affinityScore = prediction.blockMatchPct; // backend-faithful per §18 intent; see comment where predictedMatchPct is set
		const cacheMatchSource = observation?.backendObserved ? "hybrid" : "pi_prediction";
		const event: CacheMatchEvent = {
			schema_version: "pi.cache_match.completion.v1",
			event_name: cfg.eventName,
			timestamp: prediction.timestamp,
			org_id: cfg.orgId,
			app_id: cfg.appId,
			agent_id: cfg.agentId,
			subagent_id: prediction.subagentId,
			trace_id: prediction.traceId,
			call_id: prediction.callId,
			parent_call_id: prediction.parentCallId,
			root_call_id: prediction.rootCallId,
			call_type: prediction.callType,
			depth: prediction.depth,
			session_id: prediction.sessionId,
			turn_id: prediction.turnId,
			call_index: prediction.callIndex,
			model: prediction.model,
			provider: prediction.provider,
			backend: prediction.backend,
			template_version: prediction.templateVersion,
			tokenizer_version: prediction.tokenizerVersion,
			template_hash: prediction.templateHash ?? "",
			tokenizer_hash: prediction.tokenizerHash ?? "",
			fingerprint_version: prediction.fingerprintVersion,
			cache_namespace: prediction.cacheNamespace,
			cache_key_root: prediction.cacheKeyRoot,
			block_size_tokens: prediction.blockSizeTokens,
			total_prompt_tokens: prediction.totalPromptTokens,
			total_full_blocks: prediction.totalFullBlocks,
			partial_block_tokens: prediction.partialBlockTokens,
			predicted_matched_blocks: prediction.predictedMatchedBlocks,
			predicted_matched_tokens: prediction.predictedMatchedTokens,
			predicted_match_pct: prediction.predictedMatchPct,
			token_match_pct: prediction.tokenMatchPct,
			block_match_pct: prediction.blockMatchPct,
			matched_from: prediction.matchedFrom,
			canonical_matched_tokens: prediction.canonicalMatchedTokens,
			canonical_matched_pct: prediction.canonicalMatchedPct,
			volatility_delta_tokens: prediction.volatilityDeltaTokens,
			first_mismatch_block_index: prediction.firstMismatchBlockIndex,
			first_mismatch_message_index: prediction.firstMismatchMessageIndex,
			first_mismatch_region: prediction.firstMismatchRegion,
			suspected_break_reason: prediction.suspectedBreakReason,
			diagnosis_note: prediction.diagnosisNote,
			cache_clobbering_detected: prediction.cacheClobberingDetected,
			cache_clobbering_expected_tokens: prediction.cacheClobberingExpectedTokens,
			cache_affinity_score: affinityScore,
			recommended_cache_stickiness: affinityScore >= 0.8 ? "high" : affinityScore >= 0.4 ? "medium" : "low",
			predicted_prefill_savings_tokens: prediction.predictedMatchedTokens,
			confidence: prediction.confidence,
			confidence_reasons: prediction.confidenceReasons,
			ttft_ms: observation?.ttftMs,
			prefill_ms: observation?.prefillMs,
			decode_ms: observation?.decodeMs,
			total_latency_ms: observation?.totalLatencyMs,
			usage_input: observation?.usageInput,
			usage_output: observation?.usageOutput,
			usage_cache_read: observation?.usageCacheRead,
			usage_cache_write: observation?.usageCacheWrite,
			prediction_actual_delta: observation?.predictionActualDelta,
			backend_metrics_available: observation?.backendObserved ?? false,
			cache_match_source: cacheMatchSource,
		};

		appendEvent(event, cfg.orgId, cfg.appId, cfg.agentId);
		st.lastEvent = event;
		return event;
	}

	function appendEvent(event: CacheMatchEvent, orgId: string, appId: string, agentId: string): CacheMatchEvent {
		const file = telemetryDir ? join(telemetryDir, `${orgId}-${appId}-${agentId}.jsonl`) : undefined;
		if (!file) return event;
		try {
			mkdirSync(telemetryDir, { recursive: true });
			writeFileSync(file, `${JSON.stringify(event)}\n`, { flag: "a" });
		} catch (_e) {
			/* telemetry durability is best-effort; never break the agent */
		}
		return event;
	}

	function recordRollup(prediction: CacheMatchPrediction, observation: CacheMatchObservation | undefined) {
		const st = ensureState();
		const model = prediction.model || "unknown";
		const callType = prediction.callType || "agent_turn";

		const upsert = (bucket: Record<string, AgentCascadeStats>, key: string) => {
			const entry = bucket[key] ?? {
				totalCalls: 0,
				avgPredictedMatchPct: 0,
				matchPctSamples: [],
				avgAffinityScore: 0,
				totalPromptTokens: 0,
				totalMatchedTokens: 0,
				totalMissTokens: 0,
				lowConfidenceCalls: 0,
				breakReasons: {},
			};
			entry.totalCalls++;
			entry.totalPromptTokens += prediction.totalPromptTokens;
			entry.totalMatchedTokens += prediction.predictedMatchedTokens;
			entry.totalMissTokens += Math.max(prediction.totalPromptTokens - prediction.predictedMatchedTokens, 0);
			entry.avgPredictedMatchPct =
				(entry.avgPredictedMatchPct * (entry.totalCalls - 1) + prediction.predictedMatchPct) / entry.totalCalls;
			// Doc §24: keep a bounded sample ring so p50/p95 can be computed.
			entry.matchPctSamples.push(prediction.predictedMatchPct);
			if (entry.matchPctSamples.length > 512) entry.matchPctSamples.shift();
			if (entry.matchPctSamples.length >= 1) {
				const sorted = [...entry.matchPctSamples].sort((a, b) => a - b);
				entry.p50MatchPct = sorted[Math.floor((sorted.length - 1) * 0.5)];
				entry.p95MatchPct = sorted[Math.floor((sorted.length - 1) * 0.95)];
			}
			if (observation?.backendActualCacheHitPct !== undefined) {
				entry.avgActualHitPct =
					(entry.avgActualHitPct === undefined
						? observation.backendActualCacheHitPct
						: (entry.avgActualHitPct * (entry.totalCalls - 1) + observation.backendActualCacheHitPct) / entry.totalCalls);
			}
			entry.avgAffinityScore =
				(entry.avgAffinityScore * (entry.totalCalls - 1) + prediction.predictedMatchPct) / entry.totalCalls;
			if (prediction.suspectedBreakReason)
				entry.breakReasons[prediction.suspectedBreakReason] = (entry.breakReasons[prediction.suspectedBreakReason] ?? 0) + 1;
			if (prediction.confidence === "low") entry.lowConfidenceCalls++;
			bucket[key] = entry;
		};

		upsert(st.stats.byModel, model);
		upsert(st.stats.byCallType, callType);
		if (prediction.suspectedBreakReason) upsert(st.stats.byBreakReason, prediction.suspectedBreakReason);
	}

	// ─── helpers for /commands ──────────────────────────────────────────────

	function lastPrediction(): CacheMatchPrediction | undefined {
		return state?.lastMatch;
	}

	// ─── event wiring ────────────────────────────────────────────────────────

	// before_provider_request fires on pi ≥0.84; older pi builds don't emit it.
	// When it's missing, fall back to message_end → reconstruct from session history.
	pi.on("before_provider_request", async (event: BeforeProviderRequestEvent, ctx) => {
		try {
			beforeCompletion(ctx, event.payload);
			// Observe-only — we never mutate the payload (design doc §8.3 non-responsibilities).
			return undefined;
		} catch (_e) {
			/* best-effort observability, never break the agent */
			return undefined;
		}
	});

	// after_provider_response carries only status + headers — not usage.
	// Usage is delivered on message_end by pi's normal stream pipeline.
	pi.on("after_provider_response", async (event: AfterProviderResponseEvent, ctx) => {
		try {
			afterCompletionFromProviderResponse(ctx, event);
			return undefined;
		} catch (_e) {
			return undefined;
		}
	});

	// message_end carries the final AssistantMessage with `usage` (pi's actual wire counters).
	pi.on("message_end", async (event: MessageEndEvent, ctx) => {
		const role = (event.message as unknown as Record<string, unknown> | undefined)?.role;
		// User/tool messages never correspond to a completion call — do not
		// run the fallback beforeCompletion on them, and do not consume pending.
		if (role !== "assistant") {
			dbg("message_end", { role: String(role), skipped: "non_assistant" });
			return undefined;
		}
		// On pi builds that never fire before_provider_request (e.g. 0.55.x),
		// the prediction has to be built HERE from session history instead.
		// This makes the extension work across pi versions.
		if (!state?.pendingPrediction?.pending) {
			try {
				beforeCompletion(ctx);
			} catch {
				/* best-effort */
			}
		}

		try {
			const pending = state?.pendingPrediction;
			dbg("message_end", { role: String(role), has_pending: Boolean(pending?.pending) });
			if (!pending || !pending.pending) return undefined;
			const observation = afterCompletionFromMessageEnd(ctx, event);
			if (!observation) return undefined;
			const out = emitEvent(pending.prediction, observation);
			if (out) recordRollup(pending.prediction, observation);
			return undefined;
		} catch (_e) {
			return undefined;
		}
	});

	// ─── agent / turn lifecycle — call cascade attribution ──────────────────

	pi.on("agent_start", async (_event, ctx) => {
		const st = ensureState(ctx);
		const parent = st.callStack.length > 0 ? st.callStack[st.callStack.length - 1].callId : "";
		st.callStack.push({ callId: nextCallId(), parentCallId: parent, kind: "agent" });
		// Keep rootCallId pointing at the OUTERMOST agent frame for session-scoped
		// fallbacks (used by commands when no completion has run yet).
		if (!st.rootCallId || st.callStack.filter((f) => f.kind === "agent").length === 1) {
			st.rootCallId = st.callStack[st.callStack.length - 1].callId;
		}
		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		const st = ensureState(ctx);
		// Pop the most recent "agent" frame (walking from the top down past any
		// turn frames that may have leaked un-popped).
		for (let i = st.callStack.length - 1; i >= 0; i--) {
			if (st.callStack[i].kind === "agent") {
				st.callStack.splice(i, 1);
				break;
			}
		}
		return undefined;
	});

	pi.on("turn_start", async (event, ctx) => {
		const st = ensureState(ctx);
		if (typeof event.turnIndex === "number") {
			st.turnId = `turn_${st.sessionId}#${event.turnIndex}`;
			st.lastTurnIndex = event.turnIndex;
		}
		const parent = st.callStack.length > 0 ? st.callStack[st.callStack.length - 1].callId : st.rootCallId;
		st.callStack.push({ callId: nextCallId(), parentCallId: parent, kind: "turn" });
		return undefined;
	});

	pi.on("turn_end", async (_event, ctx) => {
		const st = ensureState(ctx);
		// Pop the most recent "turn" frame.
		for (let i = st.callStack.length - 1; i >= 0; i--) {
			if (st.callStack[i].kind === "turn") {
				st.callStack.splice(i, 1);
				break;
			}
		}
		return undefined;
	});

	// ─── session lifecycle ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const st = ensureState(ctx);
		// Prefer the authoritative session id from the session manager itself
		// (present on both pi 0.55.x and 0.84.x); fall back to scanning branch entries.
		const fromManager = (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
		if (typeof fromManager === "string" && fromManager.length > 0) {
			st.sessionId = safeString(fromManager, 128);
			if (st.turnId.startsWith("turn_sess_unknown")) st.turnId = `turn_${st.sessionId}#${st.lastTurnIndex ?? 0}`;
		} else {
			const branch = ctx.sessionManager?.getBranch?.() as unknown[] | undefined;
			if (branch && branch.length > 0) {
				for (const entry of branch) {
					const r = entry as Record<string, unknown>;
					if (r?.type === "session" && r?.id) {
						st.sessionId = safeString(r.id, 128) || st.sessionId;
						break;
					}
				}
			}
		}
		if (!st.rootCallId || st.rootCallId.startsWith("call_sess_")) st.rootCallId = `call_${st.sessionId}`;
		return undefined;
	});

	// ─── commands ─────────────────────────────────────────────────────────────

	pi.registerCommand("cache-match", {
		description: "Show predicted cache match %, affinities, and cache-break diagnostics for the current session",
		handler: async (_args, ctx) => {
			const last = lastPrediction();
			if (!last) {
				ctx.ui.notify("No cache-match data yet for this session.", "info");
				return;
			}
			const lines: string[] = [
				`### Cache Match — ${last.agentId} — ${last.callId}`,
				``,
				`**Predicted match:** ${(last.predictedMatchPct * 100).toFixed(1)}% (${last.predictedMatchedTokens} / ${last.totalPromptTokens} tokens)`,
				`**Blocks:** ${last.predictedMatchedBlocks} of ${last.totalFullBlocks} (block size ${last.blockSizeTokens})`,
				`**Affinity score:** ${last.predictedMatchPct.toFixed(3)}`,
				`**Session:** ${last.sessionId}`,
				`**Model:** ${last.model} · **Backend:** ${last.backend || "unknown"}`,
				`**Confidence:** ${last.confidence}${last.confidenceReasons.length > 0 ? ` (${last.confidenceReasons.join("; ")})` : ""}`,
			];
			if (last.firstMismatchBlockIndex !== undefined) {
				lines.push(
					`**Cache-break:** block ${last.firstMismatchBlockIndex}${last.firstMismatchRegion ? ` (${last.firstMismatchRegion})` : ""} — ${last.suspectedBreakReason || "unstable metadata"}`,
				);
			}
			if (last.canonicalMatchedPct !== undefined && last.canonicalMatchedPct > last.predictedMatchPct) {
				lines.push(`**Canonical match:** ${(last.canonicalMatchedPct * 100).toFixed(1)}% (volatility-normalised)`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("cache-match-agent", {
		description: "Show per-agent / per-model cache efficiency rollups for the current session",
		handler: async (_args, ctx) => {
			const st = ensureState(ctx);
			if (!st.lastEvent) {
				ctx.ui.notify("No cache-match data yet for this session.", "info");
				return;
			}
			const lines: string[] = [`### Agent Cache Efficiency — ${st.sessionId}`, ``];
			for (const [model, stats] of Object.entries(st.stats.byModel)) {
				if (stats.totalCalls === 0) continue;
				lines.push(
					`**Model ${model}**: avg ${(stats.avgPredictedMatchPct * 100).toFixed(1)}%, affinity ${stats.avgAffinityScore.toFixed(3)}, ${stats.totalCalls} calls, prompt tokens ${stats.totalPromptTokens}`,
				);
			}
			for (const [callType, stats] of Object.entries(st.stats.byCallType)) {
				if (stats.totalCalls === 0) continue;
				lines.push(`**Call type ${callType}**: avg ${(stats.avgPredictedMatchPct * 100).toFixed(1)}%, ${stats.totalCalls} calls`);
			}
			if (Object.keys(st.stats.byBreakReason).length > 0) {
				lines.push("", `**Break reasons:**`);
				for (const [reason, stats] of Object.entries(st.stats.byBreakReason)) {
					lines.push(`  - ${reason}: ${stats.totalCalls} calls`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
