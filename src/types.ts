/**
 * Types for the pi-cache-match extension.
 *
 * Telemetry is a strict subset of design doc §13.1 `pi.cache_match.completion`:
 * counts, ratios, block-hash prefixes, and safe capped strings only — never raw
 * prompt/messages/tool output/token content (§23.1).
 */

export type Confidence = "high" | "medium" | "low";

export type CallType =
	| "root_user_turn"
	| "agent_turn"
	| "subagent"
	| "internal_turn"
	| "tool_agent"
	| "script";

export type BackendId =
	| "vllm"
	| "sglang"
	| "anthropic"
	| "openai"
	| "bedrock"
	| "custom_managed_inhouse"
	| "unknown_backend";

export type CacheBreakReason =
	| "system_prompt_change"
	| "tool_list_change"
	| "history_rewrite"
	| "template_change"
	| "tokenizer_change"
	| "volatility"
	| "model_change"
	| "session_restart"
	| null;

export interface CompletionContext {
	callId: string;
	parentCallId?: string;
	rootCallId: string;
	callType: CallType;
	agentId: string;
	appId: string;
	orgId: string;
	sessionId: string;
	turnId: string;
	model: string;
	provider?: string;
	backend?: BackendId;
	depth: number;
}

export interface CacheMatchPrediction {
	// ─── call identity / cascade (doc §3.2) ───────────────────────────────
	callId: string;
	parentCallId?: string;
	rootCallId: string;
	callType: CallType;
	agentId: string;
	subagentId?: string;
	traceId?: string;
	appId: string;
	orgId: string;
	sessionId: string;
	turnId: string;
	callIndex: number;
	cacheKeyRoot: string;
	cacheNamespace: string;
	provider?: string;
	backend?: BackendId;
	model: string;
	depth: number;
	timestamp: string;
	// ─── template/tokenizer versioning ─────────────────────────────────────
	templateVersion: string;
	tokenizerVersion: string;
	templateHash?: string;
	tokenizerHash?: string;
	/** Doc §3.2 fingerprint schema version; static label on every event. */
	fingerprintVersion: string;
	// ─── block geometry ────────────────────────────────────────────────────
	totalPromptTokens: number;
	totalFullBlocks: number;
	partialBlockTokens: number;
	blockSizeTokens: number;
	// ─── predicted cache match (pi-side, no backend data needed) ───────────
	predictedMatchedBlocks: number;
	predictedMatchedTokens: number;
	/** Doc §7.1: emit both. Block-level in MVP === token-level because matched_tokens = matched_blocks × block_size. */
	predictedMatchPct: number;
	tokenMatchPct: number;
	blockMatchPct: number;
	matchedFrom: "actual" | "canonical" | "none";
	// ─── canonical-twin twin track (volatility normalised) ─────────────────
	canonicalMatchedTokens?: number;
	canonicalMatchedPct?: number;
	volatilityDeltaTokens?: number;
	// ─── cache-break diagnostics ───────────────────────────────────────────
	firstMismatchBlockIndex?: number;
	firstMismatchMessageIndex?: number;
	firstMismatchRegion?: string;
	breakType?: string;
	suspectedBreakReason: CacheBreakReason;
	diagnosisNote?: string;
	/** Doc §12.4: flag + expectation when prior lineage was substantial but current match is 0. */
	cacheClobberingDetected?: boolean;
	cacheClobberingExpectedTokens?: number;
	// ─── confidence model ─────────────────────────────────────────────────
	confidence: Confidence;
	confidenceReasons: string[];
	// ─── lineage stored for next call's LCP match ──────────────────────────
	storeForNext?: (cacheKeyRoot: string, blocks: { blockHashes: string[]; updatedAt: number }) => void;
}

export interface CacheMatchObservation {
	backendObserved: boolean;
	backendPrefixCacheHits: string;
	backendPrefixCacheQueries: string;
	backendPrefixCacheHitPct?: number;
	backendPromptTokensCached: string;
	/** Actual cache-read tokens seen on this response (if reported by the provider). */
	backendActualCachedReadTokens?: number;
	/** Actual hit % = cachedRead / (cachedRead + nonCachedInput) when usage is available. */
	backendActualCacheHitPct?: number;
	backendEvictions?: number;
	// ─── timing/usage, trustworthy only when extracted from a real stream ──
	ttftMs?: number;
	prefillMs?: number;
	decodeMs?: number;
	totalLatencyMs?: number;
	usageInput?: number;
	usageOutput?: number;
	usageCacheRead?: number;
	usageCacheWrite?: number;
	predictionActualDelta?: number;
}

export interface CacheMatchEvent {
	schema_version: string;
	event_name: string;
	timestamp: string;
	// ─── cascade / tenancy (doc §3.2) ─────────────────────────────────────
	org_id: string;
	app_id: string;
	agent_id: string;
	subagent_id?: string;
	trace_id?: string;
	call_id: string;
	parent_call_id?: string;
	root_call_id: string;
	call_type: CallType;
	depth: number;
	// ─── session / model ─────────────────────────────────────────────────
	session_id: string;
	turn_id: string;
	call_index: number;
	model: string;
	provider?: string;
	backend?: BackendId;
	// ─── template/tokenizer versions ─────────────────────────────────────
	template_version: string;
	tokenizer_version: string;
	template_hash: string;
	tokenizer_hash: string;
	/** Fingerprint schema version (doc §3.2); static label for downstream parsers. */
	fingerprint_version: string;
	// ─── block geometry ──────────────────────────────────────────────────
	cache_namespace: string;
	cache_key_root: string;
	block_size_tokens: number;
	total_prompt_tokens: number;
	total_full_blocks: number;
	partial_block_tokens: number;
	// ─── predicted cache metrics (doc §7.1: emit both token- and block-level) ──
	predicted_matched_blocks: number;
	predicted_matched_tokens: number;
	/** Token-level ratio: matched_tokens / total_prompt_tokens. */
	token_match_pct: number;
	/** Block-level ratio: matched_blocks / total_full_blocks. */
	block_match_pct: number;
	/** Alias kept for backward compat — block_match_pct is the same value in MVP. */
	predicted_match_pct: number;
	matched_from: "actual" | "canonical" | "none";
	canonical_matched_tokens?: number;
	canonical_matched_pct?: number;
	volatility_delta_tokens?: number;
	// ─── cache-break diagnostics ─────────────────────────────────────────
	first_mismatch_block_index?: number;
	first_mismatch_message_index?: number;
	first_mismatch_region?: string;
	break_type?: string;
	suspected_break_reason: CacheBreakReason;
	diagnosis_note?: string;
	/** Doc §12.4: true when prior lineage matched ≥ N tokens and current matches 0 unexpectedly. */
	cache_clobbering_detected?: boolean;
	/** Doc §12.4: tokens we expected to match but didn't. */
	cache_clobbering_expected_tokens?: number;
	// ─── affinity / stickiness tips for LLM routing ──────────────────────
	cache_affinity_score: number;
	recommended_cache_stickiness: "high" | "medium" | "low";
	predicted_prefill_savings_tokens: number;
	// ─── confidence model ────────────────────────────────────────────────
	confidence: Confidence;
	confidence_reasons: string[];
	// ─── backend-observed truth (when present) ───────────────────────────
	ttft_ms?: number;
	prefill_ms?: number;
	decode_ms?: number;
	total_latency_ms?: number;
	usage_input?: number;
	usage_output?: number;
	usage_cache_read?: number;
	usage_cache_write?: number;
	prediction_actual_delta?: number;
	backend_metrics_available: boolean;
	/** Doc §14.1: "hybrid" when backend usage reconciled with prediction, else "pi_prediction". */
	cache_match_source?: "hybrid" | "pi_prediction";
}

export interface SegmentInfo {
	blockIndex: number;
	messageIndex: number;
	role: string;
	toolNames: string[];
	tokenStart: number;
	tokenCount: number;
	source: "prompt" | "tools" | "history";
	regionLabel: string;
}

export interface AgentCascadeStats {
	totalCalls: number;
	avgPredictedMatchPct: number;
	avgActualHitPct?: number;
	p50MatchPct?: number;
	p95MatchPct?: number;
	/** Keep last N matchPct samples for quantiles (doc §24). Bounded ring, oldest evicted. */
	matchPctSamples: number[];
	avgAffinityScore: number;
	totalPromptTokens: number;
	totalMatchedTokens: number;
	totalMissTokens: number;
	lowConfidenceCalls: number;
	breakReasons: Record<string, number>;
}
