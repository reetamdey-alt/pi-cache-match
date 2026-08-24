/**
 * Unit-level render of CacheMatchDashboard against synthetic events.
 * Run with:  node --experimental-strip-types src/dashboard.test-render.ts
 */
import { CacheMatchDashboard } from "./dashboard.ts";
import type { BackendId, CacheMatchEvent } from "./types.ts";

// — mock theme: return ANSI-tagged text so we can see what color would be used
const mockTheme = {
	fg: (color: string, s: string) => `<${color}>${s}</${color}>`,
	bg: (color: string, s: string) => `[bg ${color}]${s}[/bg]`,
} as any;

function makeEvent(overrides: Partial<CacheMatchEvent> = {}): CacheMatchEvent {
	return {
		schema_version: "1",
		event_name: "pi.cache_match.completion",
		timestamp: "2026-08-21T14:00:00.000Z",
		org_id: "org_x",
		app_id: "xyne",
		agent_id: "xyne-cli",
		session_id: "sess_test_smoke",
		turn_id: "turn_0",
		call_id: "call_0",
		parent_call_id: "",
		root_call_id: "call_0",
		call_type: "agent_turn",
		depth: 1,
		call_index: 0,
		model: "glm-latest",
		provider: "juspay",
		backend: "anthropic" as BackendId,
		template_version: "1",
		tokenizer_version: "1",
		template_hash: "tmpl-a1b2c3d4",
		tokenizer_hash: "t",
		cache_namespace: "fb35abbf",
		cache_key_root: "root",
		fingerprint_version: "pi-cache-fp-v1",
		block_size_tokens: 512,
		prompt_bytes: 1 << 12,
		total_prompt_tokens: 2000,
		total_full_blocks: 4,
		partial_block_tokens: 0,
		predicted_matched_blocks: 3,
		predicted_matched_tokens: 1500,
		predicted_match_pct: 0.75,
		token_match_pct: 0.75,
		block_match_pct: 0.75,
		matched_from: "canonical",
		canonical_matched_tokens: 1900,
		canonical_matched_pct: 0.95,
		volatility_delta_tokens: 128,
		first_mismatch_block_index: 3,
		first_mismatch_message_index: 1,
		first_mismatch_region: "system",
		suspected_break_reason: null,
		diagnosis_note: undefined,
		cache_clobbering_detected: false,
		cache_clobbering_expected_tokens: 0,
		cache_affinity_score: 0.8,
		recommended_cache_stickiness: "high",
		predicted_prefill_savings_tokens: 1500,
		confidence: "high",
		confidence_reasons: [
			"hybrid corroboration",
			"12-turn stable namespace",
		],
		ttft_ms: 100,
		prefill_ms: 50,
		decode_ms: 10,
		total_latency_ms: 160,
		usage_input: 2000,
		usage_output: 500,
		usage_total: 2500,
		usage_cache_read: 1500,
		usage_cache_write: 200,
		prediction_actual_delta: 0,
		backend_metrics_available: true,
		cache_match_source: "hybrid",
		...overrides,
	} as CacheMatchEvent;
}

const events: CacheMatchEvent[] = [];
for (let i = 0; i < 8; i++) {
	events.push(
		makeEvent({
			call_index: i,
			timestamp: `2026-08-21T14:${String(10 + i).padStart(2, "0")}:00.000Z`,
			session_id: i < 4 ? "sess-A" : "sess-B",
			predicted_match_pct: i === 3 || i === 5 ? 0.1 : 0.72 + i * 0.02,
			predicted_matched_blocks: Math.min(4, i + 1),
			total_full_blocks: i === 1 ? 8 : 5,
			partial_block_tokens: i === 0 ? 200 : i === 7 ? 350 : 0,
			suspected_break_reason:
				i === 3 ? "volatility" : i === 5 ? "tool_list_change" : null,
			first_mismatch_region:
				i === 3 ? "history" : i === 5 ? "history" : undefined,
			first_mismatch_block_index: i === 3 || i === 5 ? 3 : undefined,
			diagnosis_note:
				i === 3
					? "prompt grew between turns"
					: i === 5
						? "tool list differed from prior turn"
						: undefined,
			cache_clobbering_detected: i === 3 || i === 5,
			cache_clobbering_expected_tokens: i === 3 ? 900 : i === 5 ? 450 : 0,
			usage_cache_read: i === 0 ? 0 : 1000 + i * 100,
			usage_input: 2000 + i,
			usage_output: 500 + i,
			// i=7 uses a high cache_read so wire>pi fires — XO tile computes
			// cross-call reuse share (>0 to render). Others keep wire ≤ pi.
			total_prompt_tokens: i === 7 ? 1400 : 2000 + i,
			model: i < 3 ? "glm-latest" : "deepseek",
			call_type: i < 4 ? "agent_turn" : (i < 6 ? "subagent" : "internal_turn"),
			depth: i < 4 ? 1 : i < 6 ? 2 : 3,
		} as any),
	);
}

const buildDashboard = (maxLines: number) =>
	new CacheMatchDashboard({
		events,
		stats: {
			byModel: {
				"glm-latest": { totalCalls: 5, avgPredictedMatchPct: 0.78, avgAffinityScore: 0.82, totalPromptTokens: 12000 },
				deepseek: { totalCalls: 3, avgPredictedMatchPct: 0.7, avgAffinityScore: 0.74, totalPromptTokens: 6000 },
			},
			byCallType: {
				agent_turn: { totalCalls: 4, avgPredictedMatchPct: 0.78 },
				subagent: { totalCalls: 2, avgPredictedMatchPct: 0.62 },
				internal_turn: { totalCalls: 2, avgPredictedMatchPct: 0.5 },
			},
		},
		telemetryFile: "/tmp/xyne-e2e/t17sweep/org_x-xyne-xyne-cli.jsonl",
		agentId: "xyne-cli",
		sessionId: "sess_test_smoke",
		theme: mockTheme,
		done: () => {},
		maxLines,
	});

const visible = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\x1b\[[0-9;]*m/g, "");
const show = (label: string, maxLines: number, dump: boolean) => {
	const dash = buildDashboard(maxLines);
	const out = dash.render(80);
	const widths = out.map((l) => visible(l).length);
	console.log(`\n================ ${label} (maxLines=${maxLines}) rendered ${out.length} lines, widths ${Math.min(...widths)}..${Math.max(...widths)} ================`);
	if (dump) console.log(out.join("\n"));
};

show("FULL", -1, true);
show("COMPACT", 36, true);
show("TIGHT", 26, true);
