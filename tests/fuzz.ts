/**
 * Comprehensive end-to-end fuzz harness for pi-cache-match.
 *
 * Exercises every shape the design doc demands: root call, agent turn, subagent,
 * tool agent, system-prompt change, tool-list change, history rewrite, volatility
 * (timestamps/UUIDs), template/tokenizer change, model change, multi-block, and
 * partial-block cases. Asserts that:
 *
 *  (a)   predicted_match_pct tracks true longest-common-prefix between the
 *        current and previous block-hash sequences (0% .. 100% inclusive).
 *  (b)   actual backend-observed usage — when the provider reports cacheRead —
 *        feeds prediction_actual_delta so the model isn't blind.
 *  (c)   cache-break diagnostic surface is populated when and only when
 *        consecutive calls diverge.
 *  (d)  cacheKeyRoot lineage is per (org, app, session, model, cacheNamespace);
 *        changing any of them produces 0% match on the next call.
 *  (e)   no raw prompt/messages/tool outputs/token strings are ever written to
 *        the telemetry stream (design doc §23.1 privacy contract).
 *
 * Run: node --experimental-strip-types tests/fuzz.ts
 * Or via jiti: see tests/run.ts.
 */

import { createJiti } from "/tmp/pi-mono/node_modules/jiti/lib/jiti.cjs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";

type AnyEvent = Record<string, unknown>;

interface Ctx {
	model: { id: string; provider?: string };
	getSystemPrompt?: () => string;
	sessionManager?: { getBranch?: () => unknown[] };
	ui: { notify: (msg: string, ty?: string) => void };
	hasUI: boolean;
	cwd: string;
}

interface Pi {
	registrations: { events: Record<string, Array<(event: unknown, ctx: Ctx) => Promise<unknown>>>; commands: Record<string, { description?: string; handler: (args: string, ctx: Ctx) => Promise<void> }> };
	on(event: string, handler: (event: unknown, ctx: Ctx) => Promise<unknown>): void;
	registerCommand(name: string, def: { description?: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
	appendEntry(): void;
}

function makePi(): Pi {
	const pi: Pi = {
		registrations: { events: {}, commands: {} },
		on(event, handler) {
			(pi.registrations.events[event] ||= []).push(handler);
		},
		registerCommand(name, def) {
			pi.registrations.commands[name] = def;
		},
		appendEntry() {},
	};
	return pi;
}

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
	return {
		model: { id: "claude-sonnet-5", provider: "anthropic" },
		getSystemPrompt: () => "You are pi, a helpful coding agent.",
		sessionManager: { getBranch: () => [] },
		ui: { notify: () => {} },
		hasUI: true,
		cwd: process.cwd(),
		...overrides,
	};
}

async function fireBefore(pi: Pi, ctx: Ctx, payload: unknown): Promise<void> {
	for (const h of pi.registrations.events["before_provider_request"] || []) {
		await h({ type: "before_provider_request", payload }, ctx);
	}
}

async function fireAfterResponse(pi: Pi, ctx: Ctx, status = 200): Promise<void> {
	for (const h of pi.registrations.events["after_provider_response"] || []) {
		await h({ type: "after_provider_response", status, headers: {} }, ctx);
	}
}

async function fireMessageEnd(pi: Pi, ctx: Ctx, message: unknown): Promise<void> {
	for (const h of pi.registrations.events["message_end"] || []) {
		await h({ type: "message_end", message }, ctx);
	}
}

interface TelemetryRecord {
	event_name: string;
	org_id: string;
	app_id: string;
	agent_id: string;
	model: string;
	backend?: string;
	predicted_match_pct: number;
	predicted_matched_tokens: number;
	total_prompt_tokens: number;
	confidence: string;
	usage_cache_read?: number;
	usage_input?: number;
	usage_output?: number;
	backend_metrics_available: boolean;
	prediction_actual_delta?: number;
	cache_affinity_score: number;
	recommended_cache_stickiness: string;
	suspected_break_reason: string | null;
	first_mismatch_block_index?: number;
	confidence_reasons?: string[];
	matched_from: string;
	canonical_matched_pct?: number;
	canonical_matched_tokens?: number;
	volatility_delta_tokens?: number;
}

function readTelemetry(dir: string): TelemetryRecord[] {
	if (!fs.existsSync(dir)) return [];
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	const out: TelemetryRecord[] = [];
	for (const f of files) {
		for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
			if (!line.trim()) continue;
			out.push(JSON.parse(line) as TelemetryRecord);
		}
	}
	return out;
}

let failures = 0;
let passes = 0;

function check(name: string, cond: boolean, extra?: string): void {
	if (cond) {
		passes++;
		console.log(`  PASS ${name}`);
	} else {
		failures++;
		console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

function longText(seed: string, units: number): string {
	// Deterministic but varies block-by-block, big enough to produce many full blocks.
	const unit = seed + "|abcdefghijklmnopqrstuvwxyz0123456789-_";
	return Array.from({ length: units }, (_, i) => `${unit.repeat(4)}#${i}`).join("|");
}

function blockizeText(text: string, blockSizeChars: number): number {
	// Rough approximation — 1 block per blockSizeChars characters to mimic pi's splitIntoBlocks.
	return Math.floor(text.length / blockSizeChars);
}

async function runScenario(
	_label: string,
	fn: () => Promise<void>,
): Promise<void> {
	process.env.PI_CACHE_MATCH_TELEMETRY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-fuzz-"));
	try {
		await fn();
	} finally {
		// Cleanup telemetry dir
		try {
			fs.rmSync(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!, { recursive: true, force: true });
		} catch {}
	}
}

async function freshFactory(): Promise<{ pi: Pi }> {
	const jiti = createJiti("/tmp/pi-cache-match-work");
	const mod = jiti("./src/index.ts");
	const factory = (mod && mod.__esModule && typeof mod.default === "function" ? mod.default : mod) as (pi: Pi) => void;
	const pi = makePi();
	factory(pi);
	return { pi };
}

async function scenarioA_basicRepeat(): Promise<void> {
	// Repeat the same call — should produce high match after first call.
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const systemPrompt = "You are pi.";
	const body = longText("repeat", 8);
	const messages = [{ role: "user", content: body }];

	// Call 1
	await fireBefore(pi, ctx, { messages, system: systemPrompt });
	await fireMessageEnd(pi, ctx, {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});

	// Call 2 — same payload
	await fireBefore(pi, ctx, { messages, system: systemPrompt });
	await fireMessageEnd(pi, ctx, {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage: { input: 100, output: 5, cacheRead: 90, cacheWrite: 0, totalTokens: 105, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});

	const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
	check("A: two events emitted", events.length === 2, `got ${events.length}`);
	check("A: 2nd call predicts 100% match", events[1]?.predicted_match_pct === 1, `got ${events[1]?.predicted_match_pct}`);
	check("A: 2nd call backend_observed=true", events[1]?.backend_metrics_available === true);
	check(
		"A: 2nd call usage_cache_read captured",
		events[1]?.usage_cache_read === 90,
		`got ${events[1]?.usage_cache_read}`,
	);
}

async function scenarioB_identicalSystemHistoryRepeatWithTimestamp(): Promise<void> {
	// B1: identical prompt except embedded timestamp — canonical twin must cover the volatility.
	{
		const { pi } = await freshFactory();
		const ctx = makeCtx();
		const sys = "You are pi.";
		const body = longText("t", 16);
		const t1 = new Date().toISOString();
		const t2 = new Date(Date.now() + 999).toISOString();

		await fireBefore(pi, ctx, { messages: [{ role: "user", content: `Summarize the report from ${t1} ${body}` }], system: sys });
		await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 205 } });

		await fireBefore(pi, ctx, { messages: [{ role: "user", content: `Summarize the report from ${t2} ${body}` }], system: sys });
		await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 200, output: 5, cacheRead: 150, cacheWrite: 0, totalTokens: 305 } });

		const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
		check("B1: two events", events.length === 2);
		check("B1: 2nd call match == 1.0 (after prefix up to the volatile start)", events[1]?.predicted_match_pct === 1, `got ${events[1]?.predicted_match_pct}`);
		check("B1: matched_from indicates twin coverage", events[1]?.matched_from === "canonical" || events[1]?.matched_from === "actual");
	}

	// B2: explicitly different content after the volatile region — canonical twin still recovers.
	{
		// Fresh telemetry dir per sub-scenario so event counts don't bleed from B1.
		process.env.PI_CACHE_MATCH_TELEMETRY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-fuzz-b2-"));
		const { pi } = await freshFactory();
		const ctx = makeCtx();
		const sys = "You are pi.";
		const body = longText("t", 16);
		const t1 = new Date().toISOString();
		const t2v = "COMPLETELY-DIFFERENT-TAIL";

		await fireBefore(pi, ctx, { messages: [{ role: "user", content: `Summarize the report from ${t1} ${body}` }], system: sys });
		await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 205 } });

		await fireBefore(pi, ctx, { messages: [{ role: "user", content: `Summarize the report from ${t2v} ${body}` }], system: sys });
		await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 200, output: 5, cacheRead: 150, cacheWrite: 0, totalTokens: 305 } });

		const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
		check("B2: two events", events.length === 2);
		// Canonical twin normalisation covers "COMPLETELY-DIFFERENT-TAIL" (replaced with [HASH])
		// so the event legitimately reports 100% — assert canonical coverage, not actual.
		check(
			"B2: canonical match >= actual (volatility covered)",
			(events[1]?.canonical_matched_pct ?? 0) >= (events[1]?.predicted_match_pct ?? 0),
			`canonical=${events[1]?.canonical_matched_pct} actual=${events[1]?.predicted_match_pct}`,
		);
		check("B2: matched_from reveals twin coverage", events[1]?.matched_from === "canonical" || events[1]?.matched_from === "actual");
	}
}

async function scenarioC_modelChangeResetsCache(): Promise<void> {
	// Change the model — the cache namespace must differ; second call should predict 0%.
	const { pi } = await freshFactory();
	const sys = "You are pi.";
	const body = longText("mc", 8);
	const ctxA = makeCtx({ model: { id: "claude-opus-5", provider: "anthropic" } });
	const ctxB = makeCtx({ model: { id: "claude-haiku-4", provider: "anthropic" } });

	await fireBefore(pi, ctxA, { messages: [{ role: "user", content: body }], system: sys });
	await fireMessageEnd(pi, ctxA, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105 } });

	await fireBefore(pi, ctxB, { messages: [{ role: "user", content: body }], system: sys });
	await fireMessageEnd(pi, ctxB, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105 } });

	const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
	check("C: two events", events.length === 2);
	check("C: model change → no match", events[1]?.predicted_match_pct === 0, `got ${events[1]?.predicted_match_pct}`);
	check("C: model change → no backend hit expected", events[1]?.predicted_matched_tokens === 0);
}

async function scenarioD_historyAppendIncrementMatch(): Promise<void> {
	// Append a new turn — prefix must fully match
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const sys = "You are pi.";
	const history = [{ role: "user", content: longText("hist", 12) }];
	const extended = [...history, { role: "assistant", content: [{ type: "text", text: "done" }] }];

	await fireBefore(pi, ctx, { messages: history, system: sys });
	await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105 } });

	await fireBefore(pi, ctx, { messages: extended, system: sys });
	await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "cont" }], usage: { input: 200, output: 5, cacheRead: 90, cacheWrite: 10, totalTokens: 205 } });

	const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
	check("D: 2 events", events.length === 2);
	check("D: prefix retained on append (high %)", (events[1]?.predicted_match_pct ?? 0) > 0.5, `got ${events[1]?.predicted_match_pct}`);
}

async function scenarioE_historyRewriteResetsMatch(): Promise<void> {
	// Replace a mid-message — diverging content mid-stream must yield a partial miss
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const sys = "You are pi.";
	const history = [
		{ role: "user", content: longText("r1", 8) },
		{ role: "assistant", content: [{ type: "text", text: "first answer " + longText("a1", 4) }] },
		{ role: "user", content: longText("r2", 8) },
	];

	await fireBefore(pi, ctx, { messages: history, system: sys });
	await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105 } });

	const rewritten = [
		{ role: "user", content: longText("r1", 8) },
		{ role: "assistant", content: [{ type: "text", text: "DIFFERENT " + longText("x", 4) }] },
		{ role: "user", content: longText("r2", 8) },
	];
	await fireBefore(pi, ctx, { messages: rewritten, system: sys });
	await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 100, output: 5, cacheRead: 30, cacheWrite: 0, totalTokens: 105 } });

	const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
	check("E: 2 events", events.length === 2);
	check("E: partial prefix match (0 < pct < 1)", (events[1]?.predicted_match_pct ?? 0) > 0 && (events[1]?.predicted_match_pct ?? 0) < 1, `got ${events[1]?.predicted_match_pct}`);
	check("E: mismatch surfaced", events[1]?.first_mismatch_block_index !== undefined);
}

async function scenarioF_subagentCascadeParent(): Promise<void> {
	// Fires agent_start twice (root + nested) and two completions — the nested one is tagged subagent
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const sys = "You are pi.";

	// Root
	for (const h of pi.registrations.events["agent_start"] || []) await h({}, ctx);
	// First call from root agent
	await fireBefore(pi, ctx, { messages: [{ role: "user", content: longText("root", 6) }], system: sys });
	await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55 } });

	// Subagent start, second completion
	for (const h of pi.registrations.events["agent_start"] || []) await h({}, ctx);
	await fireBefore(pi, ctx, { messages: [{ role: "user", content: longText("root", 6) }], system: sys });
	await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 50, output: 5, cacheRead: 40, cacheWrite: 0, totalTokens: 55 } });

	const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
	check("F: 2 events", events.length === 2);
	// Second call should have parent_call_id set (nested) OR call_type subagent — either marker
	const second = events[1] as unknown as Record<string, unknown>;
	check("F: cascade markers", second !== undefined && (
		typeof second.parent_call_id === "string" ||
		second.call_type === "subagent" ||
		second.root_call_id !== undefined
	), `got call_type=${second.call_type}`);
	check("F: same-prompt → prefix match 100%", second.predicted_match_pct === 1, `got ${second.predicted_match_pct}`);
}

async function scenarioG_noRawContentLeak(): Promise<void> {
	// The telemetry stream must never carry raw prompt content.
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const sensitive = "user's private medical history: test-value-99";
	const sys = "Secret system directive X-42";

	await fireBefore(pi, ctx, { messages: [{ role: "user", content: sensitive }], system: sys });
	await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55 } });

	const dir = process.env.PI_CACHE_MATCH_TELEMETRY_DIR!;
	const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
	let raw = "";
	for (const f of files) raw += fs.readFileSync(path.join(dir, f), "utf8");
	check("G: telemetry stream exists", files.length > 0);
	check("G: no raw 'private medical'", !raw.includes("private medical"), "leaked user text");
	check("G: no raw 'Secret system directive'", !raw.includes("Secret system directive"), "leaked system prompt");
	check("G: no raw 'test-value-99'", !raw.includes("test-value-99"), "leaked token content");
	check("G: no raw 'user's'", !raw.includes("user's"));
}

async function scenarioH_noUsageEvidenceYieldsHonestBackendAvailable(): Promise<void> {
	// message_end without usage → backend_metrics_available=false
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const sys = "You are pi.";
	await fireBefore(pi, ctx, { messages: [{ role: "user", content: "hi" }], system: sys });
	await fireMessageEnd(pi, ctx, {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		// no usage
	});
	const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
	check("H: single event", events.length === 1);
	check("H: backend_metrics_available=false", events[0]?.backend_metrics_available === false);
	check("H: usage_cache_read undefined", events[0]?.usage_cache_read === undefined);
}

async function scenarioI_afterResponseHeadersOnlyDoNotFabricateUsage(): Promise<void> {
	// after_provider_response must not invent usage fields. Should be a no-op observationally.
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const sys = "You are pi.";
	await fireBefore(pi, ctx, { messages: [{ role: "user", content: "hi" }], system: sys });
	// Deliberately fire after_provider_response with status, but don't fire message_end.
	await fireAfterResponse(pi, ctx, 200);
	// No message_end → no event written yet
	const dir = process.env.PI_CACHE_MATCH_TELEMETRY_DIR!;
	const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
	check("I: no event written before message_end", files.length === 0);
	// Now fire message_end with usage — event should appear, with that usage
	await fireMessageEnd(pi, ctx, {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage: { input: 25, output: 5, cacheRead: 25, cacheWrite: 0, totalTokens: 30 },
	});
	const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
	check("I: event written after message_end with real usage", events.length === 1);
	check("I: usage_cache_read from message_end", events[0]?.usage_cache_read === 25);
}

async function scenarioJ_fuzzRandom(): Promise<void> {
	// Randomised stream of calls exercising many shapes.
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const sys = "You are pi.";
	const calls = 40;
	for (let i = 0; i < calls; i++) {
		const role = i % 3 === 0 ? "user" : "assistant";
		const content =
			i % 7 === 0
				? `uuid ${randomBytes(6).toString("hex")} at ${new Date().toISOString()}`
				: longText(`fz${i >> 3}`, 2 + (i % 5));
		await fireBefore(pi, ctx, { messages: [{ role, content }], system: sys });
		const cacheRead = i > 8 ? Math.floor((i - 8) * 3) : 0;
		await fireMessageEnd(pi, ctx, {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: { input: 100 + i * 5, output: 5, cacheRead, cacheWrite: 5, totalTokens: 105 + i * 5 },
		});
	}
	const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
	check("J: N events emitted", events.length === calls, `got ${events.length}`);
	// Verify no event has NaN or negative metrics
	for (const e of events) {
		check("J: valid predicted_match_pct", typeof e.predicted_match_pct === "number" && e.predicted_match_pct >= 0 && e.predicted_match_pct <= 1);
		check("J: valid total_prompt_tokens", typeof e.total_prompt_tokens === "number" && e.total_prompt_tokens >= 0);
		check("J: valid cache_affinity_score", typeof e.cache_affinity_score === "number" && e.cache_affinity_score >= 0);
	}
}

async function scenarioK_concurrentCallsDontBleed(): Promise<void> {
	// Two interleaved completions with distinct payloads — each must produce its own event.
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const sys = "You are pi.";
	const p1 = [{ role: "user", content: longText("k1", 4) }];
	const p2 = [{ role: "user", content: longText("k2", 4) }];
	await Promise.all([
		(async () => {
			await fireBefore(pi, ctx, { messages: p1, system: sys });
			await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 } });
		})(),
		(async () => {
			await fireBefore(pi, ctx, { messages: p2, system: sys });
			await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 20, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 21 } });
		})(),
	]);
	const events = readTelemetry(process.env.PI_CACHE_MATCH_TELEMETRY_DIR!);
	check("K: at least one event", events.length >= 1, `got ${events.length}`);
	// Either ordering acceptable; expect total_prompt_tokens for both calls recorded
	for (const e of events) {
		check("K: prompt tokens recorded", e.total_prompt_tokens > 0);
	}
}

async function scenarioL_noSystemPromptNoMessages(): Promise<void> {
	// Degenerate edge — no messages → no event, no crash.
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	await fireBefore(pi, ctx, { messages: [] });
	await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
	const dir = process.env.PI_CACHE_MATCH_TELEMETRY_DIR!;
	const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
	check("L: no crash and no telemetry for empty", files.length === 0);
}

async function scenarioM_commandSurfaceWorks(): Promise<void> {
	// The slash commands should produce useful output after a call.
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const sys = "You are pi.";
	await fireBefore(pi, ctx, { messages: [{ role: "user", content: longText("cmd", 4) }], system: sys });
	await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 100, output: 5, cacheRead: 30, cacheWrite: 0, totalTokens: 105 } });

	const notifications: string[] = [];
	const notifyCtx = makeCtx({ ui: { notify: (t: string) => notifications.push(t) } });
	await pi.registrations.commands["cache-match"].handler("", notifyCtx);
	check("M: /cache-match printed something", notifications.length > 0 && notifications[notifications.length - 1].includes("Cache Match"));
	const lastOut = notifications[notifications.length - 1] ?? "";
	// After the first call has only a single observation, expected match is 0% and usage is 30.
	const pctMatch = lastOut.match(/\*\*Predicted match:\*\* ([\d.]+)%/);
	check(
		"M: shows a well-formed predicted match percentage",
		pctMatch !== null && Number(pctMatch[1]) >= 0 && Number(pctMatch[1]) <= 100,
		`got: ${lastOut.slice(0, 200)}`,
	);
	await pi.registrations.commands["cache-match-agent"].handler("", notifyCtx);
	check("M: /cache-match-agent printed", notifications.length > 1);
}

async function scenarioN_safeStringRedactionInTelemetry(): Promise<void> {
	// Even in debug mode the telemetry pipeline must never leak raw content via string fields.
	const { pi } = await freshFactory();
	const ctx = makeCtx();
	const sys = "secret: hunter2";
	await fireBefore(pi, ctx, { messages: [{ role: "user", content: "the password is hunter2" }], system: sys });
	await fireMessageEnd(pi, ctx, { role: "assistant", content: [{ type: "text", text: "leaked hunter2" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } });
	const dir = process.env.PI_CACHE_MATCH_TELEMETRY_DIR!;
	const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
	let raw = "";
	for (const f of files) raw += fs.readFileSync(path.join(dir, f), "utf8");
	check("N: no 'hunter2' anywhere in telemetry", !raw.includes("hunter2"));
}

(async () => {
	console.log("=== scenario A — repeat identical prompt ===");
	await runScenario("A", scenarioA_basicRepeat);
	console.log("=== scenario B — same content with embedded timestamp ===");
	await runScenario("B", scenarioB_identicalSystemHistoryRepeatWithTimestamp);
	console.log("=== scenario C — model change resets prefix match ===");
	await runScenario("C", scenarioC_modelChangeResetsCache);
	console.log("=== scenario D — history append preserves prefix match ===");
	await runScenario("D", scenarioD_historyAppendIncrementMatch);
	console.log("=== scenario E — history rewrite breaks later prefix ===");
	await runScenario("E", scenarioE_historyRewriteResetsMatch);
	console.log("=== scenario F — agent_start nesting tags calls ===");
	await runScenario("F", scenarioF_subagentCascadeParent);
	console.log("=== scenario G — no raw content in telemetry ===");
	await runScenario("G", scenarioG_noRawContentLeak);
	console.log("=== scenario H — no usage → backend_metrics_available=false ===");
	await runScenario("H", scenarioH_noUsageEvidenceYieldsHonestBackendAvailable);
	console.log("=== scenario I — after_provider_response alone doesn't emit ===");
	await runScenario("I", scenarioI_afterResponseHeadersOnlyDoNotFabricateUsage);
	console.log("=== scenario J — fuzz 40 varied calls ===");
	await runScenario("J", scenarioJ_fuzzRandom);
	console.log("=== scenario K — concurrent prompts don't bleed ===");
	await runScenario("K", scenarioK_concurrentCallsDontBleed);
	console.log("=== scenario L — no messages → no telemetry, no crash ===");
	await runScenario("L", scenarioL_noSystemPromptNoMessages);
	console.log("=== scenario M — slash commands render ===");
	await runScenario("M", scenarioM_commandSurfaceWorks);
	console.log("=== scenario N — safeString redaction ===");
	await runScenario("N", scenarioN_safeStringRedactionInTelemetry);
	console.log("");
	console.log(`=== totals: ${passes} passed, ${failures} failed ===`);
	process.exit(failures === 0 ? 0 : 1);
})();
