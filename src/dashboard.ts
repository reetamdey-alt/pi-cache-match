/**
 * CacheMatch dashboard — full-screen overlay for /cachematch.
 *
 * Round-2 design — this round adds what was actually missing for the goal:
 *
 *   1. LIVE header badge + "prefill saved" + "last event age" heart-beat
 *   2. KPI chip strip (LATEST / AVG / READS / CACHED TURNS / BREAKS)
 *   3. Hit-rate sparkline + hit-rate HISTOGRAM (distribution, not just arc)
 *   4. BLOCK MAP — per-turn row with block grid AND explicit X/Y blocks label,
 *      so "what fraction of KV-block space is reused" reads at a glance.
 *   5. CALL TREE — root → subagent cascade with per-call-type hit% and
 *      per-line block-usage.
 *   6. ROUTING CARD — "STICK WITH <model>" verdict + per-model score ordered
 *      descending, with the actual TTL the score's stickiness implies.
 *      This is the concrete output an agent framework needs for routing.
 *   7. CALL-TYPE rollup bars
 *   8. Turn log (scrollable)
 *   9. Footer (telemetry path + keys)
 *
 * Visual, technical, content-free. All metrics are structural.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { CacheBreakReason, CacheMatchEvent, CallType } from "./types.ts";

export interface DashboardStats {
	byModel: Record<
		string,
		{
			totalCalls: number;
			avgPredictedMatchPct: number;
			avgAffinityScore: number;
			totalPromptTokens: number;
		}
	>;
	byCallType: Record<
		string,
		{
			totalCalls: number;
			avgPredictedMatchPct: number;
		}
	>;
}

const CALLOUT_ORDER: CallType[] = [
	"root_user_turn",
	"agent_turn",
	"subagent",
	"internal_turn",
	"tool_agent",
	"script",
];

const CALLOUT_LABEL: Record<CallType, string> = {
	root_user_turn: "root",
	agent_turn: "agent",
	subagent: "subag",
	internal_turn: "intrn",
	tool_agent: "tool",
	script: "script",
};

// 1-letter break-reason codec, shared by the KPI chip's reason inventory,
// TURN LOG's `!X` column, and CALL TREE markers. Module scope so both the
// render path and the tree builder use the identical vocabulary.
const REASON_SHORT: Partial<Record<NonNullable<CacheBreakReason>, string>> = {
	system_prompt_change: "S",
	tool_list_change: "T",
	history_rewrite: "H",
	template_change: "P",
	tokenizer_change: "K",
	volatility: "V",
	model_change: "M",
	session_restart: "R",
};
const reasonShort = (r: NonNullable<CacheBreakReason>): string => REASON_SHORT[r] ?? "?";

export class CacheMatchDashboard implements Focusable {
	readonly width = 84;
	focused = false;

	private scroll = 0;
	private events: CacheMatchEvent[];
	private stats: DashboardStats;
	private telemetryFile: string;
	private agentId: string;
	private sessionId: string;
	private done: (result: { action: "open" } | undefined) => void;
	private theme: Theme;
	private renderedAtMs: number;
	/* Max rows the dashboard may emit (incl borders). -1 = no cap. */
	private maxLines: number;

	constructor(args: {
		events: CacheMatchEvent[];
		stats: DashboardStats;
		telemetryFile: string;
		agentId: string;
		sessionId: string;
		theme: Theme;
		done: (result: { action: "open" } | undefined) => void;
		maxLines?: number;
	}) {
		// Sanitize NaN/Infinity numerics once at construction. Field-agnostic:
		// walk every key, coerce non-finite numbers to a safe default. Schema
		// requires several fields; missing/NaN in any of them would otherwise
		// leak `NaN%` through a dozen render paths (fuzz case "NaN pct").
		const sanitize = (e: CacheMatchEvent): CacheMatchEvent => {
			const out: Record<string, any> = { ...e };
			for (const k of Object.keys(out)) {
				const v = out[k];
				if (typeof v === "number" && !Number.isFinite(v)) {
					// percentages clamp to [0,1] so a 1050% can't escape; other
					// numerics default to 0 (the honest "no data yet" placeholder).
					out[k] = k.endsWith("_pct") || k === "cache_affinity_score" ? 0 : 0;
				}
			}
			// Percent fields: hard-clamp even finite values to [0,1].
			for (const k of Object.keys(out)) {
				const v = out[k];
				if (typeof v === "number" && (k.endsWith("_pct") || k === "cache_affinity_score")) {
					out[k] = Math.max(0, Math.min(1, v));
				}
			}
			// Required-numeric defaults: anything the render String()-ifies must
			// never be undefined. `String(e.call_index)` was the actual fuzz/
			// scenario leak — fix at boundary, not at every print site.
			if (typeof out.call_index !== "number" || !Number.isFinite(out.call_index)) out.call_index = 0;
			if (typeof out.depth !== "number" || !Number.isFinite(out.depth)) out.depth = 1;
			return out as CacheMatchEvent;
		};
		this.events = args.events.map(sanitize).sort(
			// Chronological first: telemetry files and replays can span multiple
			// sessions, each restarting call_index at 0 — a call_index-primary
			// sort interleaves lanes and makes events[last] arbitrary. Real-time
			// single-session streams are timestamp-monotonic already, so the
			// call_index tiebreak only orders same-ms bursts within one session.
			(a, b) => a.timestamp.localeCompare(b.timestamp) || a.call_index - b.call_index,
		);
		this.stats = args.stats;
		this.telemetryFile = args.telemetryFile;
		this.agentId = args.agentId;
		this.sessionId = args.sessionId;
		this.theme = args.theme;
		this.done = args.done;
		this.maxLines = typeof args.maxLines === "number" ? args.maxLines : -1;
		this.renderedAtMs = Date.now();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "return") || data === "o" || data === "O") {
			this.done({ action: "open" });
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.scroll = Math.max(0, this.scroll - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.scroll = Math.min(this.maxScroll(), this.scroll + 1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scroll = Math.max(0, this.scroll - 10);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scroll = Math.min(this.maxScroll(), this.scroll + 10);
			return;
		}
		if (matchesKey(data, "home") || data === "g") {
			this.scroll = 0;
			return;
		}
		if (matchesKey(data, "end") || data === "G") {
			this.scroll = this.maxScroll();
			return;
		}
	}

	invalidate(): void {}
	dispose(): void {}

	private maxScroll(): number {
		return Math.max(0, this.events.length - 8);
	}

	private pad(s: string, len: number): string {
		const vis = visibleWidth(s);
		return s + " ".repeat(Math.max(0, len - vis));
	}

	/** Truncate a styled string to `len` visible cells, preserving ANSI escapes. */
	private clip(s: string, len: number): string {
		if (visibleWidth(s) <= len) return s;
		let out = "";
		let vis = 0;
		let i = 0;
		const target = Math.max(0, len - 1); // leave room for …
		while (i < s.length && vis < target) {
			// ESC[...m style sequences pass through without consuming width.
			if (s[i] === "\x1b" && s[i + 1] === "[") {
				const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
				if (m) {
					out += m[0];
					i += m[0].length;
					continue;
				}
			}
			out += s[i];
			vis++;
			i++;
		}
		return out + "…" + "\x1b[0m";
	}

	private row(content: string, innerW: number): string {
		return (
			this.theme.fg("border", "│") +
			this.pad(content, innerW) +
			this.theme.fg("border", "│")
		);
	}

	private hitColor(pct: number): ThemeColor {
		return pct >= 0.8 ? "success" : pct >= 0.4 ? "warning" : "error";
	}

	// `~` when pi's tokenizer is the approximate char/token heuristic. Real
	// wire counters (usage_*, latency) never carry it. Reads like standard
	// approximation notation; confidence column in SIGNAL explains why.
	private approxMarker(): string {
		const last = this.events[this.events.length - 1];
		return last && last.confidence !== "high" ? "~" : "";
	}

	/** Age string, e.g. "3s ago" or "2m ago". */
	private ageStr(isoTs: string): string {
		const ms = Date.now() - new Date(isoTs).getTime();
		if (!Number.isFinite(ms) || ms < 0) return "now";
		if (ms < 1_500) return "now";
		if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h ago`;
		return `${Math.floor(ms / 86_400_000)}d ago`;
	}

	/** Sparkline over [0..1]. */
	private sparkline(values: number[], width: number): string {
		if (width < 1) width = 1;
		if (values.length === 0) return this.theme.fg("dim", "─".repeat(width));
		const bars = "▁▂▃▄▅▆▇█";
		const out: string[] = [];
		const showN = Math.min(values.length, width);
		if (values.length <= width) {
			for (let i = 0; i < values.length; i++) {
				const v = Math.max(0, Math.min(1, values[i]!));
				const ch = bars[Math.round(v * (bars.length - 1))]!;
				out.push(this.theme.fg(this.hitColor(v), ch));
			}
		} else {
			for (let i = 0; i < showN; i++) {
				const idx = Math.round((i * (values.length - 1)) / (showN - 1));
				const v = Math.max(0, Math.min(1, values[idx]!));
				const ch = bars[Math.round(v * (bars.length - 1))]!;
				out.push(this.theme.fg(this.hitColor(v), ch));
			}
		}
		const rendered = out.join("");
		const vis = visibleWidth(rendered);
		if (vis < width) {
			return rendered + this.theme.fg("dim", "·".repeat(width - vis));
		}
		return rendered;
	}

	/**
	 * Histogram of values in [0..1] — 5 buckets: 0-20 / 20-40 / 40-60 / 60-80 / 80-100.
	 * Renders one horizontal bar per bucket, with the bucket label on the left.
	 */
	private histogram(values: number[]): string[] {
		const th = this.theme;
		const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
		const labels = ["0–20", "20–40", "40–60", "60–80", "80–100"];
		const counts = [0, 0, 0, 0, 0];
		for (const v of values) {
			for (let i = 0; i < 5; i++) {
				if (v >= edges[i]! && v < edges[i + 1]!) {
					counts[i]!++;
					break;
				}
			}
		}
		const max = Math.max(1, ...counts);
		const out: string[] = [];
		for (let i = 0; i < 5; i++) {
			const c = counts[i]!;
			const w = Math.round((c / max) * 26);
			const bar = th.fg(this.hitColor(labels[i] === "80–100" ? 0.9 : labels[i] === "20–40" ? 0.3 : labels[i] === "0–20" ? 0.1 : 0.6),
				"█".repeat(w)) + th.fg("dim", "░".repeat(Math.max(0, 26 - w)));
			out.push(`  ${th.fg("dim", labels[i]!.padEnd(6))} ${bar}  ${th.fg("dim", String(c))}`);
		}
		return out;
	}

	/** Gauge bar. Uses sub-cell 8ths (btop-style gradient resolution) so the
	 * encoded value matches the numeric label to within ~6% of a cell. */
	private gauge(pct: number, size = 10): string {
		const inner = Math.max(1, size);
		const clamped = Math.max(0, Math.min(1, pct));
		const exact = clamped * inner;
		const full = Math.floor(exact);
		const frac = exact - full;
		const partials = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
		// When the fractional part rounds to a full cell, fold into `full` and
		// draw no partial glyph at all — round(frac*8)=8 indexes past the end
		// of partials[] and leaks `undefined` into the bar (real-wire 0.4875
		// hit this: `████undefined░░░`). The honest render folds up.
		let partialIdx = Math.round(frac * 8);
		let fullAdj = full;
		if (partialIdx >= 8) {
			fullAdj = full + 1;
			partialIdx = 0;
		}
		const color = this.hitColor(pct);
		const full_part = this.theme.fg(color, "█".repeat(Math.min(fullAdj, inner)));
		const partial_part =
			partialIdx > 0 && fullAdj < inner ? this.theme.fg(color, partials[partialIdx]!) : "";
		const used = Math.min(fullAdj, inner) + (partialIdx > 0 && fullAdj < inner ? 1 : 0);
		const rest = this.theme.fg("dim", "░".repeat(Math.max(0, inner - used)));
		return full_part + partial_part + rest;
	}

	/** Per-turn block map cell-render; returns the colored string (no %). */
	private blockCells(e: CacheMatchEvent, cells: number): string {
		const total = Math.max(1, e.total_full_blocks);
		const hit = e.predicted_matched_blocks;
		const miss = Math.max(0, total - hit);
		const hitPortion = Math.round((hit / total) * cells);
		const missPortion = Math.round((miss / total) * cells);
		const rem = cells - hitPortion - missPortion;
		const hitColor = this.hitColor(e.predicted_match_pct);
		const out: string[] = [];
		if (hitPortion > 0) out.push(this.theme.fg(hitColor, "█".repeat(hitPortion)));
		if (missPortion > 0) out.push(this.theme.fg("dim", "░".repeat(missPortion)));
		if (rem > 0) out.push(this.theme.fg("warning", "▌".repeat(rem)));
		return out.join("");
	}

	render(_width: number): string[] {
		const th = this.theme;
		const side = (s: string) => th.fg("border", s);
		const W = this.width;
		const inner = W - 2;
		const lines: string[] = [];

		const pushTop = () => lines.push(side(`╭${"─".repeat(inner)}╮`));
		const pushBot = () => lines.push(side(`╰${"─".repeat(inner)}╯`));

		// Fold tiers: FULL (~64 rows) / COMPACT (≤36) / TIGHT (≤26). maxLines < 0 means "no cap".
		const max = this.maxLines > 0 ? this.maxLines : 1_000_000;
		const full = max >= 56;
		const compact = !full && max >= 32;
		const tight = !full && !compact;

		pushTop();

		if (this.events.length === 0) {
			lines.push(this.row("", inner));
			lines.push(
				this.row(
					` ${th.fg("accent", "◆ CACHE MATCH")}  ${th.fg("dim", "Xyne agent-efficiency overlay")}`,
					inner,
				),
			);
			lines.push(this.row("", inner));
			lines.push(
				this.row(` ${th.fg("warning", "No cache-match data yet for this session.")}`, inner),
			);
			lines.push(this.row("", inner));
			lines.push(
				this.row(` ${th.fg("dim", "Send at least one turn, then /cachematch again.")}`, inner),
			);
			lines.push(this.row("", inner));
			pushBot();
			return lines;
		}

		const last = this.events[this.events.length - 1]!;
		const pcts = this.events.map((e) => e.predicted_match_pct);
		const avgPct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
		const totalCr = this.events.reduce((s, e) => s + (e.usage_cache_read ?? 0), 0);
		// Defensive ??0 — schema says predicted_prefill_savings_tokens is required
		// but fuzz events or partial jsonl rows can omit it; NaN must never
		// surface in the render (fuzz case "single event" caught this).
		const totalSaved = this.events.reduce((s, e) => s + (e.predicted_prefill_savings_tokens ?? 0), 0);
		const fired = this.events.filter((e) => (e.usage_cache_read ?? 0) > 0).length;
		const breaks = this.events.filter((e) => e.suspected_break_reason != null).length;

		// Trend: avg of the newest min(5, n-1) turns minus avg of the rest before them.
		// Matches Grafana's "delta vs previous window" pattern.
		const recentWindow = Math.min(5, Math.max(1, pcts.length - 1));
		const recentAvg =
			recentWindow > 0 ? pcts.slice(-recentWindow).reduce((a, b) => a + b, 0) / recentWindow : avgPct;
		const priorAvg =
			pcts.length > recentWindow
				? pcts.slice(0, pcts.length - recentWindow).reduce((a, b) => a + b, 0) / (pcts.length - recentWindow)
				: avgPct;
		const trendDelta = recentAvg - priorAvg;
		const trendArrow = Math.abs(trendDelta) < 0.02 ? "─" : trendDelta > 0 ? "▲" : "▼";
		const trendColor: ThemeColor = Math.abs(trendDelta) < 0.02 ? "dim" : trendDelta > 0 ? "success" : "error";

		// Cache floor: lowest hit in the last min(8, n) events — Grafana-style alert proxy.
		const floorWindow = this.events.slice(-8);
		const floorPct = floorWindow.length
			? Math.min(...floorWindow.map((e) => e.predicted_match_pct))
			: 0;

		// Break streak: consecutive break events trailing the log — Helicone-style anomaly marker.
		let breakStreak = 0;
		for (let i = this.events.length - 1; i >= 0; i--) {
			if (this.events[i]!.suspected_break_reason != null) breakStreak += 1;
			else break;
		}

		// Break reason inventory (e.g. "2V·1S") — compress each reason to its
		// distinguishing initial so the BREAK chip tells you *what* broke, not
		// just *how many*. Codec lives at module scope (REASON_SHORT).
		const reasonCounts = new Map<string, number>();
		for (const e of this.events) {
			if (e.suspected_break_reason != null) {
				const k = reasonShort(e.suspected_break_reason);
				reasonCounts.set(k, (reasonCounts.get(k) ?? 0) + 1);
			}
		}
		// Clobber pressure rides the same codec inventory: 3 events flagged
		// cache_clobbering_detected shows as `·3evict` — a pattern of evictions means
		// fix-capacity-or-TTL, not fix-prompt, so the operator decision flips.
		// `evict` spells the operator-visible concept; `clb` (clobber) was module jargon.
		const clobberCount = this.events.filter((e) => e.cache_clobbering_detected).length;
		const breakReasonMix = [
			...[...reasonCounts.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([k, n]) => `${n}${k}`),
			...(clobberCount > 0 ? [`${clobberCount}evict`] : []),
		].join("·");

		// Section separator: a single line that *is* the title, with a trailing
		// ── rule that visualizes the boundary without consuming a blank row.
		const sectionHeader = (label: string, extra = "", extraIsRaw = false): string => {
			const extraW = extra ? visibleWidth(extra) : 0;
			const headW = 3 + label.length + (extra ? 2 + extraW : 0);
			const rule = "─".repeat(Math.max(0, inner - headW - 1));
			const extraStr = extra ? ` ${extraIsRaw ? extra : th.fg("dim", extra)}` : "";
			return this.row(
				` ${th.fg("accent", "▍")} ${th.fg("text", label)}${extraStr} ${th.fg("dim", rule)}`,
				inner,
			);
		};

		// ─── 1. header ────────────────────────────────────────────────────────
		// session id was dropped from the tag — the footer path carries the
		// session-identifying basename, and the header's `· sess_tes…` was
		// duplicating that. agent + model remain.
		const title = th.fg("accent", "◆ CACHE");
		// agent and model labelled — was `xyne-cli · deepseek` which read as one
		// compound name instead of "this agent · this model".
		const tag = th.fg("dim", `  agent ${this.agentId} · model ${last.model}`);
		const live = th.fg("success", "● LIVE");
		const age = th.fg("dim", `(${this.ageStr(last.timestamp)})`);
		// ↻savings was dropped: the SAVED chip on the next row carries the same
		// number — the header's last tile duplicated info one row away.
		lines.push(this.row(` ${title}${tag}  ${live} ${age}`, inner));

		// ─── 2. KPI chips ─── 5 columns when FULL; trend integrated into chips. ─
		// KPI chips: value + tag, ordered by action-signal:
		//   MATCH — last match%, primary hit-rate metric
		//   AVG n — session average, n = events considered
		//   READ  — total cached tokens the provider actually read back (observed)
		//   SAVED — tokens predicted to be reused (what pi told us would be skipped)
		//   BREAK — number of cache-break events detected
		// FLOOR was dropped: redundant with the sparkline's left anchor.
		// TAGS now say what the metric is (match/read/saved) rather than where
		// it came from (latest/cache).
		// `~` tags values derived from the approximate char/token heuristic —
		// pi marks them `confidence="low"` + "approximate char/token heuristic"
		// in the SIGNAL row's reason chain. Real wire counters (usage_*, latency)
		// never get the marker. When confidence is medium (session-history
		// reconstruction) the semantics of match% change silently, so ~ applies too.
		const approx = last.confidence !== "high" ? "~" : "";
		const chips: Array<[string, string, ThemeColor]> = [
			[
				`${approx}${(last.predicted_match_pct * 100).toFixed(1)}%`,
				"HIT",
				this.hitColor(last.predicted_match_pct),
			],
			[
				`${approx}${(avgPct * 100).toFixed(1)}%`,
				// Avg over the window with the sample count visible: `AVG n8`
				// reads as "average of 8" — the space keeps `n8` from fusing
				// into the label the way `AVG8` did.
				`AVG n${pcts.length}`,
				this.hitColor(avgPct),
			],
			[fmtNum(totalCr), "READ tok", "accent"],
			[fmtNum(totalSaved), "SAVED tok", "success"],
			// Last-call token economy in one glance-token: `3.1k→913 IO` reads as
			// "3.1k prompt in, 913 completion out". Colored dim on purpose — this
			// is context, not an alarm metric.
			...(typeof last.usage_input === "number" || typeof last.usage_output === "number"
				? ([
						[
							`${approx}${fmtNum(last.usage_input ?? 0)}→${fmtNum(last.usage_output ?? 0)}`,
							"IO",
							"dim",
						] as [string, string, ThemeColor],
					])
				: []),
			// Cold-start warmup — calls-to-reach-80% hit per session, medianed.
			// Real-world warm (e.g. e2e drive: 1.0 / 39 sessions) says the cache
			// hydrates on call 2; a high number says priming is busted. Only
			// emitted when ≥2 sessions exist; single-session pools can't compute it.
			...(() => {
				const bySess = new Map<string, number[]>();
				for (const e of this.events) {
					const arr = bySess.get(e.session_id) ?? [];
					arr.push(e.predicted_match_pct);
					bySess.set(e.session_id, arr);
				}
				if (bySess.size < 2) return [];
				const warmups: number[] = [];
				for (const pcts of bySess.values()) {
					const k = pcts.findIndex((p) => p >= 0.8);
					warmups.push(k === -1 ? pcts.length : k + 1);
				}
				warmups.sort((a, b) => a - b);
				const med = warmups[Math.floor(warmups.length / 2)]!;
				return [
					[
						// "calls-to-80% hit" primes the cache; the label says the verb so
						// `4 PRIME` reads as "took 4 calls to prime", not "4°C warm".
						`${med.toFixed(0)}`,
						"PRIME",
						med <= 2 ? "success" : med <= 4 ? "warning" : "dim",
					] as [string, string, ThemeColor],
				];
			})(),
			// Session write:read payback — Σcache_write ÷ Σcache_read. Net-negative
			// caching (>1: you're paying more into cache than you read back) is the
			// one alarm metric nobody else flips to red, so it is one.
			// Label is `W:R` (a ratio), never `x`: bare `0.2x` reads as a multiplier,
			// not a fraction of tokens-in-per-token-out.
			...(() => {
				const totW = this.events.reduce((s, e) => s + (e.usage_cache_write ?? 0), 0);
				const totR = this.events.reduce((s, e) => s + (e.usage_cache_read ?? 0), 0);
				if (totW <= 0 || totR <= 0) return [];
				const ratio = totW / totR;
				return [
					[
						`${ratio.toFixed(2)}`,
						"W:R",
						ratio > 1 ? "error" : ratio > 0.5 ? "warning" : "dim",
					] as [string, string, ThemeColor],
				];
		})(),
		[
			// VALUE = readable sentence-fragment, LABEL = the color verdict.
			// Break+clobber truths are independent — a clobber without a break
			// is still worth alarm (case "cache clobber" proved this renders as
			// `no breaks healthy` when the cache was actually evicting). Show
			// each only when non-zero; never lie by omission.
			(() => {
				const parts: string[] = [];
				if (breaks > 0) parts.push(`${breaks} break${breaks > 1 ? "s" : ""}`);
				if (breakReasonMix.length > 0) parts.push(breakReasonMix);
				if (parts.length === 0) return "no breaks";
				return parts.join(" ");
			})(),
			// Color carries the verdict (warning/error/success).
			breaks > 0 ? "" : "healthy",
			// Color: red for any break-streak>1, warning for any single break OR
			// any clobber without break (eviction is an alarm), green otherwise.
			(breaks > 0
				? breakStreak > 1 ? "error" : "warning"
				: clobberCount > 0 ? "warning" : "success") as ThemeColor,
		],
	];
		// One-line chip strip in every tier: value colored, label dim, grouped by
		// whitespace. Same info density as the old 2-row grid in half the rows.
		const strip = chips
			.map(([v, l]) => {
				const colored = th.fg(chips.find((c) => c[0] === v)![2], v);
				// Empty label is legal (color carries the verdict — see breaks chip);
				// omit the trailing space+dim block instead of rendering a blank chip.
				return l ? `${colored} ${th.fg("dim", l)}` : colored;
			})
			.join("   ");
		lines.push(this.row(` ${strip}`, inner));

		// ─── 3. sparkline + trend + histogram (FULL only) ─────────────────────
		// Rule-carrying extra. Two tokens only: the signed delta (vs baseline)
		// and the baseline value itself. `recentWindow`/`n=` are dropped — AVG's
		// fused count and the sparkline anchors already carry both.
		const deltaStr =
			trendArrow === "─"
				? "flat"
				: // ` pt` with the space — `pt` glued to the number reads as a
					// unit-suffix (like `k`) instead of "percentage points = the
					// difference between two percents".
					`${trendDelta > 0 ? "+" : ""}${(trendDelta * 100).toFixed(1)} pt`;
		const trendText = th.fg(
			trendColor,
			`${trendArrow} ${deltaStr} vs ${(priorAvg * 100).toFixed(0)}% prior`,
		);
		lines.push(sectionHeader("HIT RATE", trendText, true));
		const firstPct = pcts[0] ?? 0;
		const lastPct = pcts[pcts.length - 1] ?? 0;
		const anchorL = th.fg(this.hitColor(firstPct), `${approx}${(firstPct * 100).toFixed(0)}%`);
		const anchorR = th.fg(this.hitColor(lastPct), `${approx}${(lastPct * 100).toFixed(0)}%`);
		// Reserve 5 cells per side for anchors ("100%"/"NN%" + space). Sparkline keeps
		// 46 cells only when there's room.
		const sparkW = Math.min(46, inner - 14);
		const spark = this.sparkline(pcts, sparkW);
		if (full && pcts.length > 1) {
			// Inline distribution: one ▪ per event per bucket, colored by the
			// bucket's midpoint hit-rate tier. Zero buckets render as dim · so
			// the 0→100% shape is visible at a glance in a single row.
			const BUCKETS = 5;
			const counts = new Array<number>(BUCKETS).fill(0);
			for (const v of pcts) {
				const b = Math.min(BUCKETS - 1, Math.floor(v * BUCKETS));
				counts[b]++;
			}
			const groups = counts
				.map((c, i) => {
					if (c === 0) return th.fg("dim", "·");
					return th.fg(this.hitColor((i + 0.5) / BUCKETS), "▪".repeat(c));
				})
				.join(th.fg("dim", " "));
			lines.push(this.row(`  ${anchorL} ${spark} ${anchorR}  ${th.fg("dim", "·")} ${groups}`, inner));
		} else {
			// COMPACT / TIGHT / single-point: plain anchored sparkline.
			lines.push(this.row(`  ${anchorL} ${spark} ${anchorR}`, inner));
		}

		// ─── 4. BLOCK MAP (compact: 4 rows, tight: skip) ─────────────────────
		if (!tight) {
			const blockShow = full ? this.events.slice(-8) : this.events.slice(-4);
			// BLOCK MAP — the bar already encodes the hit/miss ratio; per-row frac
			// was redundant. Header tells the user the block size in tokens so a
			//      ███░░  · 4/5 · 72%
			//  row reads as "4 out of 5 blocks of N tokens each, 72% reuse".
			const blockW = compact ? Math.min(14, inner - 34) : Math.min(20, inner - 34);
			const blSz = blockShow[0]?.block_size_tokens;
			// Irreducible miss floor: tokens stranded in the trailing partial block
			// can never match, so this is the "how close to optimal can I get"
			// number. Warn-colored when ≥40% of a block — that's when prompt
			// padding buys a full extra matched block.
			const tail = last.partial_block_tokens;
			const tailFrag =
				typeof tail === "number" && tail > 0 && typeof blSz === "number"
					? `  tail ${fmtNum(tail)}`
					: "";
			const headerRight =
				typeof blSz === "number"
					? `turn reuse · ${fmtNum(blSz)}/blk${tailFrag}`
					: "turn reuse";
			lines.push(sectionHeader("BLOCK MAP", headerRight));
			// Right-pad is the column-width of the LARGEST index visible, not a
			// fixed 3 — the 90% case is single-digit indices, where padStart(3)
			// burned 2 columns of bar width on every row.
			const idxW = Math.max(2, ...blockShow.map((e) => String(e.call_index).length));
			for (const e of blockShow) {
				// Per-row break-code marker dropped: TURN LOG and CALL TREE both
				// carry it next to the value it describes. Here it left-padded
				// break rows by 2 vs non-break rows — subtle misalignment that
				// read as a layout bug, not a signal.
				const cells = this.blockCells(e, blockW);
				const label = th.fg("dim", String(e.call_index).padStart(idxW) + " ");
				const frac = `${e.predicted_matched_blocks}/${e.total_full_blocks}`;
				// No literal `%` — the header says what the X/Y column is. `turn
				// reuse` + the trailing number speak the same unit.
				const pctStr = `${approx}${(e.predicted_match_pct * 100).toFixed(0)}`.padStart(3);
				lines.push(
					this.row(
						`  ${label}${cells} ` +
							th.fg("dim", frac.padStart(6)) +
							"  " +
							th.fg(this.hitColor(e.predicted_match_pct), pctStr),
						inner,
					),
				);
			}
		}

		// ─── 5. routing card (always shown — this is the routing intelligence) ─
		lines.push(sectionHeader("ROUTING"));
		const models = Object.entries(this.stats.byModel)
			.filter(([, s]) => s.totalCalls > 0)
			.sort((a, b) => b[1].avgPredictedMatchPct - a[1].avgPredictedMatchPct);
		if (models.length > 0) {
			const best = models[0]!;
			const bestPct = best[1].avgPredictedMatchPct;
			const stick = bestPct >= 0.8 ? "high" : bestPct >= 0.4 ? "medium" : "low";
			const stickCol = stick === "high" ? "success" : stick === "medium" ? "warning" : "dim";
			const verdict = `STICK WITH ${th.fg("accent", best[0])}`;
			// Verdict no longer reprints "hit score NN%" — the per-model row for the
			// winner (immediately below) already shows the same number next to a bar.
			if (tight) {
				// TIGHT: verdict only — the model rows below would duplicate info.
				lines.push(
					this.row(
						` ${th.fg(stickCol as ThemeColor, "▶")} ${verdict}  ${th.fg("dim", `·  stick ${stick}`)}`,
						inner,
					),
				);
			} else {
				const modelRows = compact ? models.slice(0, 3) : models;
				// Per-model trend: avg of last ≤3 events for this model minus avg of the rest.
				const modelTrend = (name: string): { arrow: string; color: ThemeColor; str: string } => {
					const mine = this.events.filter((e) => e.model === name).map((e) => e.predicted_match_pct);
					if (mine.length < 2) return { arrow: "─", color: "dim", str: "flat" };
					const w = Math.min(3, mine.length - 1);
					const rAvg = mine.slice(-w).reduce((a, b) => a + b, 0) / w;
					const pAvg = mine.slice(0, mine.length - w).reduce((a, b) => a + b, 0) / (mine.length - w);
					const d = rAvg - pAvg;
					if (Math.abs(d) < 0.02) return { arrow: "─", color: "dim", str: "flat" };
					// ` pt` with the space — same reason as HIT RATE header.
					return d > 0
						? { arrow: "▲", color: "success", str: `+${(d * 100).toFixed(1)} pt` }
						: { arrow: "▼", color: "error", str: `${(d * 100).toFixed(1)} pt` };
				};
				for (const [m, s] of modelRows) {
						const pct = s.avgPredictedMatchPct;
						// Distribution tails, computed from events: median vs p95 gap
						// tells you whether avg% means anything. Tight cluster shows
						// p50 alone; wide spread shows both.
						const mPcts = this.events.filter((e) => e.model === m).map((e) => e.predicted_match_pct).sort((a, b) => a - b);
						const mP50 = mPcts.length > 0 ? mPcts[Math.floor(mPcts.length / 2)]! : undefined;
						const mP95 = mPcts.length > 0 ? mPcts[Math.ceil(mPcts.length * 0.95) - 1]! : undefined;
						const spread = mP50 !== undefined && mP95 !== undefined && mPcts.length >= 3 ? mP95 - mP50 : undefined;
						const distFrag =
							typeof mP50 === "number" && typeof spread === "number"
								? spread > 0.15
									? `  p50 ${(mP50 * 100).toFixed(0)}·p95 ${(mP95! * 100).toFixed(0)}`
									: `  p50 ${(mP50 * 100).toFixed(0)}`
								: "";
						const isWinner = m === best[0];
						const winMark = isWinner
							? th.fg(stickCol as ThemeColor, "▶ ")
							: "  ";
						const label = winMark + th.fg("text", m.padEnd(13));
					const bar = this.gauge(pct, 10);
					const num = th.fg(this.hitColor(pct), `${(pct * 100).toFixed(1)}%`.padStart(6));
					const trend = modelTrend(m);
					const meta = full
						? th.fg("dim", `  ·  ×${s.totalCalls} ${fmtNum(s.totalPromptTokens)} t`)
						: th.fg("dim", `  ·  ×${s.totalCalls}`);
					// Whole trend cell colored by trend direction (matches the HIT RATE
					// rule, where the entire trend string rides the trend color) —
					// hue means exactly one thing per cell: green/▲ improving.
					const tcell = ` ${th.fg(trend.color, `${trend.arrow.padStart(2)} ${trend.str.padEnd(7)}`)}`;
					lines.push(this.row(`  ${label} ${bar} ${num}${tcell}${th.fg("dim", distFrag)}${meta}`, inner));
				}
				if (compact && models.length > 3) {
					lines.push(this.row(`  ${th.fg("dim", `+ ${models.length - 3} more model(s)`) }`, inner));
				}
			}
			// ─── routing hint: a single parseable line developers can copy into
			// their router config (llm-d / Envoy AI Gateway / GIE all speak
			//   "best model + weight + stickiness").
			// Rendered in FULL + COMPACT; TIGHT drops it to keep the box small.
			if (!tight && models.length > 0) {
				const best = models[0]!;
				const bestPct = best[1].avgPredictedMatchPct;
				const stick = bestPct >= 0.8 ? "high" : bestPct >= 0.4 ? "medium" : "low";
				// Weight: normalize hit-pct across displayed models to 100 so the
				// output can be pasted as a backendRef weight pie.
				const totalScore = models.reduce((a, [, s]) => a + Math.max(0.0001, s.avgPredictedMatchPct), 0);
				// Weight keys use a minimal unique prefix of each model name —
				// the full name is glance-noise when only 2–4 models are listed.
				// Prefix length auto-extends until keys are unique.
				const names = models.map(([m]) => m);
				// ≥3 chars so a reader who hasn't memorized the model set can still
				// pattern-match to the row above. Extends only when the 3-char
				// prefixes collide.
				const prefLen = (() => {
					for (let l = 3; l <= 12; l++) {
						const keys = names.map((n) => n.slice(0, l));
						if (new Set(keys).size === keys.length) return l;
					}
					return 12;
				})();
				const parts = models
					.slice(0, 3)
					.map(([m, s]) => {
						const w = Math.round((Math.max(0.0001, s.avgPredictedMatchPct) / totalScore) * 100);
						return `${m.slice(0, prefLen)}=${w}`;
					})
					.join(" ");
				const stickShort = stick === "medium" ? "med" : stick;
				const hint = `route=${best[0].slice(0, prefLen)} w(${parts}) stick=${stickShort}`;
				lines.push(
					this.row(
						`  ${th.fg("dim", "hint")} ${th.fg("accent", hint)}`,
						inner,
					),
				);
			}
		}

		// ─── 5b. PREDICTED vs OBSERVED — realized-vs-forecast accuracy ──────
		// Helicone-style realized hit-rate + prediction-veracity strip.
		// pred = max-pct the model predicted before the completion call.
		// obs  = usage_cache_read / usage_prompt_tokens (what the provider actually
		//        reported reading back). If obs is missing (older events or no
		//        provider data), skip the row.
		// Shown as: latest pred%, latest obs%, the |pred-obs| gap with a color
		// verdict (good < 5pt / warn < 15pt / poor otherwise), plus a sparkline
		// of per-event gaps so you can see drift.
		if (!tight) {
			// Provider usage_cache_read may itself include cache-write-side tokens, so
			// clamp obs to [0,1] *and* coerce anything ≥ total_prompt_tokens to 1.0
			// (the provider reports cross-request prefix reuse, which is *also* a
			// cache hit from the user's perspective). This matches what the
			// observability platforms (Langfuse, Datadog, Helicone) do.
			const withObs = this.events.filter(
				(e) => typeof e.usage_cache_read === "number" && (e.usage_cache_read ?? 0) > 0,
			);
			if (withObs.length > 0) {
				const gaps: number[] = [];
				const lines3: Array<[string, string, string]> = []; // pred / obs / gap for half-lives
				for (const e of withObs) {
					const pred = e.predicted_match_pct;
					const obs = Math.min(1, (e.usage_cache_read ?? 0) / (e.total_prompt_tokens ?? 1));
					const gap = pred - obs;
					gaps.push(gap);
					lines3.push([
						`${(pred * 100).toFixed(0)}%`,
						`${(obs * 100).toFixed(0)}%`,
						`${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}`,
					]);
				}
				const lastGap = gaps[gaps.length - 1]!;
				const absGap = Math.abs(lastGap);
				const gapColor: ThemeColor = absGap < 0.05 ? "success" : absGap < 0.15 ? "warning" : "error";
				const gapVerdict = absGap < 0.05 ? "verified" : absGap < 0.15 ? "close" : "drifting";
				lines.push(sectionHeader("VERACITY", "predicted vs observed"));
				const last3 = withObs.slice(-1)[0]!;
				const lastPred = last3.predicted_match_pct;
				const lastObs = Math.min(1, (last3.usage_cache_read ?? 0) / (last3.total_prompt_tokens ?? 1));
				const predStr = `${(lastPred * 100).toFixed(1)}%`.padStart(6);
				const obsStr = `${(lastObs * 100).toFixed(1)}%`.padStart(6);
				const gapStr = `${lastGap >= 0 ? "+" : ""}${(lastGap * 100).toFixed(1)} pt`.padStart(8);
				const verdict = th.fg(gapColor, ` ${gapVerdict}`);
				lines.push(
					this.row(
						`  ${th.fg("dim", "pred")} ${th.fg(this.hitColor(lastPred), predStr)}  ` +
							`${th.fg("dim", "obs")} ${th.fg(this.hitColor(lastObs), obsStr)}  ` +
							// Gap is a hit-rate delta → hit-colored (same convention as
							// ROUTING trend cells and the gap-trail glyphs right below).
							// The [verdict] badge alone carries the threshold alarm hue.
							`${th.fg("dim", "\u0394")} ${th.fg(this.hitColor(Math.min(1, Math.max(0, 0.5 + lastGap))), gapStr)}  ` +
							// Badge carries n so the rule doesn't have to. Trailing window
							// span (first→last observed event) is glance-time info; a raw
							// index is not.
							(() => {
								const spanMs =
									new Date(last3.timestamp).getTime() - new Date(withObs[0]!.timestamp).getTime();
								// NaN-span guard: invalid / non-ISO timestamps yield NaN,
								// which `.toFixed` happily renders as `NaNd`. When the
								// window can't be measured, omit it entirely.
								if (!Number.isFinite(spanMs)) {
									return `${th.fg(gapColor, `[${gapVerdict} · ${withObs.length} obs]`)}`;
								}
								const span =
									spanMs < 60_000
										? `${Math.max(0, Math.round(spanMs / 1000))}s`
										: spanMs < 3_600_000
											? `${Math.round(spanMs / 60_000)}m`
											: spanMs < 86_400_000
												? `${Math.round(spanMs / 3_600_000)}h`
												: `${Math.round(spanMs / 86_400_000)}d`;
								return `${th.fg(gapColor, `[${gapVerdict} · ${withObs.length} obs]`)}${th.fg("dim", `  ·  ${span}`)}`;
							})() +
							(() => {
								let wireExtra = 0, wireTotal = 0;
								for (const e of this.events) {
									const u = e.usage_cache_read, t = e.total_prompt_tokens;
									if (typeof u !== "number" || typeof t !== "number" || u === 0 || t === 0) continue;
									wireTotal += u;
									if (u > t) wireExtra += u - t;
								}
								if (wireTotal === 0) return "";
								const share = wireExtra / wireTotal;
								if (share < 0.01) return "";
								return `  ${th.fg("dim", "X-call")} ${th.fg("text", `${(share * 100).toFixed(0)}%`)}`;
							})(),
						inner,
					),
				);
				// Trend of the last ≤8 gaps: positive = predicting higher than reality (over-confident),
				// negative = under-confident. Sign of overfitting risk.
				if (full && gaps.length >= 4) {
					const recent = gaps.slice(-8);
					const sparkArr = recent.map((g) => Math.max(0, Math.min(1, 0.5 + g))); // center on 0 (50% = parity)
					const sparkW2 = Math.min(20, inner - 30);
					const gapSpark = this.sparkline(sparkArr, sparkW2);
					lines.push(
						this.row(`  ${th.fg("dim", "Δ trail")}  ${gapSpark}  ${th.fg("dim", "·  ↑over ↓under")}`,
							inner,
						),
					);
				}
			}
		}

		// ─── 6. call tree (FULL: 7 recent; COMPACT: 4 recent; TIGHT: skip) ─────
		// COMPACT gain: agent + subagent structure is *the* glance-signal for the
		// use-case (multi-turn + subagent calls). 4 covers the common one-group
		// 2-3-session; when compact truncates a group the last visible row is
		// replaced by `…+N` so truncation is explicit, never silent.
		if (!tight) {
			const cap = full ? 7 : 4;
			const callTreeRows = this.buildCallTreeLines(Math.min(cap, this.events.length));
			if (callTreeRows.length > 0) {
				lines.push(sectionHeader("CALL TREE", "root → subagents"));
				for (const r of callTreeRows) lines.push(this.row(r, inner));
			}
		}

		// ─── 7. CALL TYPES only when the tree can't show them. CALL TREE now
		// renders in FULL+COMPACT and carries per-type averages at its group
		// rows; the rollup is downgraded to a TIGHT-tier replacement (tree is
		// folded away there), keeping the per-type intelligence at every tier.
		const ctEntries = CALLOUT_ORDER.map((ct) => ({
			ct,
			s: this.stats.byCallType[ct],
		})).filter((x) => x.s && x.s.totalCalls > 0);
		if (ctEntries.length > 0 && tight) {
			lines.push(sectionHeader("CALL TYPES", "avg hit"));
			for (const { ct, s } of ctEntries) {
				const pct = s!.avgPredictedMatchPct;
				const label = th.fg("dim", CALLOUT_LABEL[ct].padEnd(6));
				const bar = this.gauge(pct, 10);
				const num = th.fg(this.hitColor(pct), `${(pct * 100).toFixed(1)}%`.padStart(6));
				const n = th.fg("dim", ` ${s!.totalCalls}`);
				lines.push(this.row(`  ${label} ${bar} ${num}${n}`, inner));
			}
		}

		// ─── 8. break alert ──────────────────────────────────────────────────
		if (breaks > 0) {
			// Recurring break hotspot: the *mode* first-mismatch region across all
			// breaks, not just the last one. 4-of-5 breaking in `tools` says move
			// the tool block forward; in `history` says stop rewriting.
			const regionCounts = new Map<string, number>();
			for (const e of this.events) {
				if (e.suspected_break_reason != null && e.first_mismatch_region) {
					regionCounts.set(e.first_mismatch_region, (regionCounts.get(e.first_mismatch_region) ?? 0) + 1);
				}
			}
			const hotspot = [...regionCounts.entries()].sort((a, b) => b[1] - a[1])[0];
			// `hs=` suffix dropped — tag was opaque; the mode region signals the
			// same thing in the section body (hotspot = most-common region).
			// Kept for the body row below when breaks ≥ 2.
			lines.push(sectionHeader("BREAK", `${breaks} total`));
			const lastBreak = [...this.events].reverse().find((e) => e.suspected_break_reason != null)!;
			const blockLoc =
				typeof lastBreak.first_mismatch_block_index === "number"
					? th.fg("dim", ` blk#${lastBreak.first_mismatch_block_index}`)
					: "";
			const msgLoc =
				typeof lastBreak.first_mismatch_message_index === "number"
					? th.fg("dim", ` msg#${lastBreak.first_mismatch_message_index}`)
					: "";
				const clobberTail = lastBreak.cache_clobbering_detected
				? `  ${th.fg("error", `✗ clb${typeof lastBreak.cache_clobbering_expected_tokens === "number" ? ` ${fmtNum(lastBreak.cache_clobbering_expected_tokens)}t` : ""}`)}`
				: "";
			// Note text is redundant with `suspected_break_reason` and lives in telemetry;
			// drop it here rather than squeeze the head. Head is one fused glance-token:
			// ⚠ + call_idx + 1-letter codec + word + scope. `break @` / `·` boilerplate
			// cost 9 cells and told the eye nothing it couldn't infer from position.
			const head =
				` ${th.fg("warning", `⚠@${lastBreak.call_index}`)}  ` +
				`${th.fg("warning", `${reasonShort(lastBreak.suspected_break_reason!)}`)} ` +
				`${th.fg("text", lastBreak.suspected_break_reason ?? "?")}  ` +
				`${th.fg("dim", lastBreak.first_mismatch_region ?? "?")}`;
			// Diagnosis note carries the human root-cause when telemetry has one
			// ('timestamps in tool outputs', 'tool output changed in X'). The codec
			// alone only says *what* class broke, not *why* — the note closes the
			// loop between break and fix. Fits only when the trimmed head leaves
			// room; inner-26 chars is the glance budget.
			const note = lastBreak.diagnosis_note?.trim();
			const noteFrag =
				note && note.length > 0 && note.length <= Math.max(12, inner - visibleWidth(head) - 2)
					? `  ${th.fg("dim", note)}`
					: "";
			const variants: string[] = [
				head + blockLoc + msgLoc + clobberTail,
				head + blockLoc + clobberTail,
				head + clobberTail,
				// Note appears as the second-to-last fallback, after locations and
				// clobber tail — explanatory prose yields to structural indices when
				// width is tight.
				head + noteFrag,
				head,
			];
			const fitted = variants.find((v) => visibleWidth(v) <= inner) ?? head;
			lines.push(this.row(fitted, inner));
		}

		// ─── 8b. SIGNAL QUALITY — confidence, truth-source, latency ──────────
		// The extension emits its own trust metadata (confidence, match-source,
		// backend-reconciled vs pi-prediction-only) — show it next to backend
		// latency when both are present. This is the "covers everything" panel.
		if (!tight) {
			const conf = last.confidence;
			// Confidence reasons move up to the rule (label position) — saves a
			// row and puts the "why" right beside the HIGH/MEDIUM/LOW it justifies.
			// Reasons are pi-side diagnostic strings (e.g. "hybrid corroboration"),
			// scheme-flat, no prompt content.
			const reasonTxt = (last.confidence_reasons ?? [])
				.slice(0, 2)
				.map((r) => r
					.replace(/: .*$/, "")            // drop the explanatory tail — the head is the glance-token
					.replace(/\s*\(.*\)\s*$/, "")     // drop trailing parens
					.trim())
				.filter((r) => r.length > 0)
				.join(" · ");
			const labelExtra = reasonTxt
				? `${conf.toUpperCase()} · ${reasonTxt}`
				: conf.toUpperCase();
			lines.push(sectionHeader("SIGNAL", labelExtra, true));
			const matchFrom = last.matched_from;
			const matchFromColor: ThemeColor =
				matchFrom === "actual" ? "success" : matchFrom === "canonical" ? "warning" : "dim";
			const hybrid = last.cache_match_source === "hybrid";
			const hybridColor: ThemeColor = hybrid ? "success" : "dim";
			// No padEnd — crisp inline `dim=value` tiles. The eye groups by the
			// leading dim tag instead of relying on column alignment.
			// Backend tile answers §24.3's "model/backend cache efficiency" pairing:
			// which engine routed this call. Same schema-flat convention as from/src.
			const be = last.backend
				? `  ${th.fg("dim", "be")} ${th.fg("text", last.backend)}`
				: "";
			const left =
				`  ${th.fg("dim", "from")} ${th.fg(matchFromColor, matchFrom)}  ` +
				`${th.fg("dim", "src")} ${th.fg(hybridColor, hybrid ? "hybrid" : "pred-pool")}${be}`;
			const lat = last.total_latency_ms;
			const ttft = last.ttft_ms;
			const latStr =
				typeof lat === "number" && Number.isFinite(lat)
					? ` ${th.fg("dim", "L")} ${th.fg("text", `${lat.toFixed(0)}ms`)}`
					: "";
			const ttftStr =
				typeof ttft === "number" && Number.isFinite(ttft)
					? ` ${th.fg("dim", "T")} ${th.fg("text", `${ttft.toFixed(0)}ms`)}`
					: "";
			// Identity + integrity tiles: which cache namespace this session buckets
			// into, which template version produced the fingerprint, and the per-call
			// latency pair. All scheme-flat; no derivation needed.
			const ns = last.cache_namespace
				? `  ${th.fg("dim", "ns")} ${th.fg("text", last.cache_namespace)}`
				: "";
			const tt = last.template_hash
				? `  ${th.fg("dim", "tpl")} ${th.fg("text", last.template_hash.slice(0, 8))}`
				: "";
			// tv/tk rev pair — invisible until a cache breaks for no obvious
			// reason; folded as tiles so the row count stays put.
			const tv =
				full && last.template_version
					? `  ${th.fg("dim", `tv${last.template_version}`)}`
					: "";
			const tk =
				full && last.tokenizer_version
					? ` ${th.fg("dim", `tk${last.tokenizer_version}`)}`
					: "";
			// W — tokens PAID to write into cache last call (cost signal, not a hit
			// metric). Volatility ΔT — history-rewrite churn vs prior turn; the
			// trigger behind `V` breaks. Both FULL-only: headline tier keeps the
			// row scannable, deep tier carries the economics.
			const w =
				full && typeof last.usage_cache_write === "number" && last.usage_cache_write > 0
					? `  ${th.fg("dim", "W")} ${th.fg("text", fmtNum(last.usage_cache_write))}`
					: "";
			const dT =
				full && typeof last.volatility_delta_tokens === "number" && last.volatility_delta_tokens > 0
					? `  ${th.fg("dim", "ΔT")} ${th.fg("text", fmtNum(last.volatility_delta_tokens))}`
					: "";
			// Session ttft median — the "is caching buying me latency" roll-up
			// behind the per-call T. Median, not mean, because tail latencies lie.
			const tts = this.events.map((e) => e.ttft_ms).filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
			const tmid = tts.length > 0 ? tts[Math.floor(tts.length / 2)]! : undefined;
			const tSess =
				full && typeof tmid === "number"
					? `  ${th.fg("dim", "T*")} ${th.fg("text", `${tmid.toFixed(0)}ms`)}`
					: "";
			// Session volatility mean — chronic churn (every-turn compaction) vs
			// acute break (one-off spike). Both matter; the decision differs.
			const vols = this.events.map((e) => e.volatility_delta_tokens).filter((v): v is number => typeof v === "number" && v > 0);
			const vavg = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : undefined;
			const dTSess =
				full && typeof vavg === "number"
					? `  ${th.fg("dim", "ΔT*")} ${th.fg("text", fmtNum(vavg))}`
					: "";
			// Session rollup tiles (T*, ΔT*) move to their own row so the per-call
			// row stays within the width of the 100-char COMPACT/TIGHT skeleton;
			// FULL max-width at earlier rounds reached 118 with everything on one
			// line and was creeping toward overflow with WR + ΔT* additions.
			const mainSig = `${left}${latStr}${ttftStr}${ns}${tt}${tv}${tk}${w}${dT}`;
			lines.push(this.row(mainSig, inner));
			const rollupSig = `${tSess}${dTSess}`;
			if (rollupSig.trim().length > 0) {
				lines.push(this.row(`  ${th.fg("dim", "sess")}${rollupSig}`, inner));
			}
		}

		// ─── 9. turn log ─────────────────────────────────────────────────────
		const turnLogMeta = tight ? "3 rows" : compact ? "5 rows" : "8 rows";
		// Wire-total column appears only when at least one event carries it — some
		// pi builds don't expose `usage.total_tokens`. Showing it lets the eye
		// sanity-check pi's char-hash estimate against the wire counter.
		const wireTotalAvail = this.events.some((e) => typeof e.usage_total === "number");
		lines.push(
			sectionHeader(
				"TURN LOG",
				wireTotalAvail
					? `${turnLogMeta} · # time model match% reads ttl note`
					: `${turnLogMeta} · # time model match% reads note`,
			),
		);
		// Same-day check: if every event shares a YYYY-MM-DD prefix, the time
		// column only needs HH:MM:SS and we can shave 4 columns off the header.
		const firstDay = this.events[0]?.timestamp.slice(0, 10) ?? "";
		const allSameDay = this.events.every((e) => e.timestamp.startsWith(firstDay));
		const timeField = (ts: string) => (allSameDay ? ts.slice(11, 19) : ts.slice(5, 19));
		const timeW = allSameDay ? 9 : 15;
		// Column semantics now ride in the section rule label: "# time model match% aff reads !"
		// is uniform across all tiers, so the dim column header row is redundant.

		const recent = [...this.events].reverse();
		const visibleMax = tight ? 3 : compact ? 5 : 8;
		const startIdx = Math.min(this.scroll, Math.max(0, recent.length - visibleMax));
		const endIdx = Math.min(startIdx + visibleMax, recent.length);
		for (let i = startIdx; i < endIdx; i++) {
			const e = recent[i]!;
			const marker = e.suspected_break_reason ? th.fg("warning", "!") : " ";
			const pctCol = this.hitColor(e.predicted_match_pct);
			const crCol = (e.usage_cache_read ?? 0) > 0 ? "success" : "dim";
			// % is implied by the header's "match%" — eight rows of the same
			// literal were column-echo waste. Header keeps the unit; rows keep
			// the number.
			const pctStr = `${approx}${(e.predicted_match_pct * 100).toFixed(1)}`;
			const readsStr = fmtNum(e.usage_cache_read ?? 0);
			// `!` column doubles as a depth/break co-indicator using the same
			// shared 1-letter vocabulary as the BREAK chip (system=S, tool=T,
			// history=H, template=P, tokenizer=K, volatility=V, model=M,
			// restart=R). The reader sees the *kind* of break inline without
			// scrolling to BREAK section.
			// Depth uses `L0/L1/…` (call-nesting level) — `d3` parsed as opaque
			// hash-suffix, and most devs have seen `L0` for root in flame graphs.
			const depthStr = `L${e.depth}`;
			// Codec alone — `V` instead of `!V`: the letter IS the break badge
			// (same glance-shape as CALL TREE and BLOCK MAP markers), and the `!`
			// prefix becomes redundant once the vocabulary is one letter.
			const brkStr = e.suspected_break_reason
				? reasonShort(e.suspected_break_reason)
				: depthStr;
			const line =
				" " +
				marker +
				" " +
				// aff column dropped: cache_affinity_score ≈ predicted_match_pct on
				// the warm pool (algorithmic sibling), so its column duplicated
				// the one immediately to its left. Column space reclaimed.
				this.pad(String(e.call_index), 4) +
				this.pad(timeField(e.timestamp), timeW) +
				this.pad(e.model.slice(0, 11), 12) +
				th.fg(pctCol, this.pad(pctStr, 7)) +
				th.fg(crCol, this.pad(readsStr, 7)) +
				// Wire-total column you can compare against the pi estimate.
				// Only rendered when at least one event carries it (see rule
				// header guard above). Dim hue — this is wire truth, not an
				// alarm metric; the eye only needs it when cross-checking.
				(wireTotalAvail
					? th.fg("dim", this.pad(typeof e.usage_total === "number" ? fmtNum(e.usage_total) : "—", 6))
					: "") +
				this.pad(brkStr, 3);
			lines.push(this.row(line, inner));
		}
		if (recent.length > visibleMax) {
			lines.push(
				this.row(
					` ${th.fg("dim", `  ↑ ${startIdx} before  ·  ↓ ${recent.length - endIdx} after`)}`,
					inner,
				),
			);
		}

		// ─── 10. footer ──────────────────────────────────────────────────────
		const keys = tight ? "Esc close · Enter open" : "Esc/q close · Enter/o open · ↑↓/jk scroll · g/G";
		const telem = this.telemetryFile ? th.fg("accent", this.telemetryFile) : "";
		lines.push(
			this.row(
				` ${telem}${telem ? "  " : ""}${th.fg("dim", keys)}`,
				inner,
			),
		);
		pushBot();
		return lines;
	}

	/**
	 * Render a tree of the most recent N events grouped by call_type.
	 */
	private buildCallTreeLines(max: number): string[] {
		const th = this.theme;
		const recent = this.events.slice(-max).reverse();
		if (recent.length === 0) return [];
		const out: string[] = [];
		const byType = new Map<CallType, CacheMatchEvent[]>();
		for (const e of recent) {
			const ct = e.call_type;
			if (!byType.has(ct)) byType.set(ct, []);
			byType.get(ct)!.push(e);
		}
		// Group order = first-seen in the recent window (recency order), NOT a
		// fixed priority list — the group's most recent event sorts it, so the
		// tree tracks the live call structure. Row budget: FULL up to 3 per
		// group, COMPACT up to 2; a truncated group ends with `…+N` so the
		// reader knows exactly how many calls are elided, and group sparklines
		// in the parent row continue to carry the full group's trend.
		const typeOrder = [...byType.keys()];
		const maxPerGroup = max >= 6 ? 3 : 2;
		for (const ct of typeOrder) {
			const evs = byType.get(ct);
			if (!evs || evs.length === 0) continue;
			const parentTag = th.fg("accent", ct === "root_user_turn" ? "●" : "○");
			const parentLabel = th.fg("text", ct.replace(/_/g, " ").padEnd(18));
			const avg = evs.reduce((a, b) => a + b.predicted_match_pct, 0) / evs.length;
			const avgStr = th.fg(this.hitColor(avg), `${(avg * 100).toFixed(1)}%`);
			const typeName = ct.replace(/_/g, " ");
			for (let i = 0; i < evs.length; i++) {
				const e = evs[i]!;
				const isLastChild = i === evs.length - 1;
				const branchGlyph = isLastChild ? "└─" : "├─";
				// Same 1-letter break codec as TURN LOG: `!V` not bare `!`.
				// Padding keeps the 2-cell marker width stable (d-col in TURN LOG
				// is already 2 cells) so child rows still align under the head.
				const marker = e.suspected_break_reason
					? th.fg("warning", reasonShort(e.suspected_break_reason))
					: "  ";
				const pct = e.predicted_match_pct;
				const pctStr = `${this.approxMarker()} ${(pct * 100).toFixed(1)}%`.padStart(6);
				// frac is matched/total KV blocks for this single call. Rendering
				// as "4/5" (slash is the unit-separator convention from BLOCK MAP's
				// `X/Y` rule label) keeps the column narrow; the rule label above
				// carries the "blocks" semantics.
				const frac = `${e.predicted_matched_blocks}/${e.total_full_blocks}`.padStart(5);
				const reads = fmtNum(e.usage_cache_read ?? 0);
				if (i === 0) {
					// First row of a group carries the terse header inline; children align under it.
					// headStr is the *visible* head width so continuation rows can pad
					// to the same column. n=N → n=N + mini-sparkline of the group's
					// hit% history so trend is visible without scanning children.
					const groupPcts = evs.map((x) => x.predicted_match_pct);
					const groupSpark = this.sparkline(groupPcts, Math.min(groupPcts.length, 8));
					// Numeric glyph ①②③…④⁺ replaces `n3` — the count reads as a
					// glyph (a glance-token), not a word prefix. Head width math
					// must use the glyph's single-cell display width.
					const NUM_GLYPHS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];
					const nGlyph = evs.length <= NUM_GLYPHS.length ? NUM_GLYPHS[evs.length - 1]! : "④⁺";
					const headVisible = `${typeName.slice(0, 11).padEnd(11)} ${avgStr.padStart(6)} ${nGlyph} ${" ".repeat(Math.min(groupPcts.length, 8))}`;
					const head = `${typeName.slice(0, 11).padEnd(11)} ${avgStr.padStart(6)} ${th.fg("dim", nGlyph)} ${groupSpark}`;
					out.push(` ${th.fg("dim", branchGlyph)} ${head} ${marker} ${th.fg("dim", `${String(e.call_index).padStart(3)} `)}${th.fg(this.hitColor(pct), pctStr)} ${th.fg("dim", frac)} ${th.fg("dim", reads)}`);
					// Stash for siblings:
					(evs as CacheMatchEvent[] & { __headW?: number }).__headW = headVisible.length;
				} else {
					const headW = (evs as CacheMatchEvent[] & { __headW?: number }).__headW ?? 0;
					out.push(` ${th.fg("dim", branchGlyph)} ${" ".repeat(headW)} ${marker} ${th.fg("dim", `${String(e.call_index).padStart(3)} `)}${th.fg(this.hitColor(pct), pctStr)} ${th.fg("dim", frac)} ${th.fg("dim", reads)}`);
				}
				// Row budget: the newest `maxPerGroup` calls stay visible; the
				// elided tail is the OLDEST calls (lowest value). Rather than a
				// separate `…+N` row, the last visible row's branch glyph becomes
				// `…└` — one glyph position carries both the tree-contour and the
				// truncation signal, so no row is spent.
				if (evs.length > maxPerGroup && i === maxPerGroup - 1) {
					const line = out.pop()!;
					out.push(line.replace(/├─|└─/, "…└"));
					break;
				}
			}
		}
		return out;
	}
}

function fmtNum(n: number): string {
	// Never render NaN or Infinity — fuzz cases (Infinity latency, missing
	// counters, etc.) must degrade to something that reads as "no data",
	// not "$NaN" strung into a sentence.
	if (!Number.isFinite(n)) return "0";
	if (n < 0) return "0"; // negative counts make no sense in this vocabulary
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}
