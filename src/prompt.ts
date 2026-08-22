import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SegmentInfo } from "./types.ts";

/**
 * Render an AgentMessage the way pi's chat template serializes it for the API.
 * Mirrors the `<|im_start|>role\n…<|im_end|>` template pi uses (packages/ai/src/... chat template).
 * Must be stable across runs for the chain-hash to be meaningful.
 */
export function renderMessage(message: AgentMessage): string {
	const record = message as unknown as Record<string, unknown>;
	const role = typeof record.role === "string" ? record.role : "user";
	const parts: string[] = [];
	const content = record.content;
	if (typeof content === "string") {
		parts.push(content);
	} else if (Array.isArray(content)) {
		for (const part of content) {
			const p = part as Record<string, unknown>;
			if (p && typeof p === "object") {
				if (p.type === "text") parts.push(typeof p.text === "string" ? p.text : "");
				else if (p.type === "thinking") parts.push(`<thinking>${typeof p.thinking === "string" ? p.thinking : ""}</thinking>`);
				else if (p.type === "image") parts.push("[image]");
				else if (p.type === "toolCall") {
					const name = typeof p.name === "string" ? p.name : "unknown_tool";
					const args = p.arguments;
					parts.push(`<tool_call name="${name}">${typeof args === "string" ? args : JSON.stringify(args)}</tool_call>`);
				}
			}
		}
	}
	// toolResult messages in pi: role "toolResult", toolName, toolCallId
	if (role === "toolResult") {
		const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
		return `<|im_start|>tool ${toolName}\n${parts.join("\n")}<|im_end|>\n`;
	}
	return `<|im_start|>${role}\n${parts.join("\n")}<|im_end|>\n`;
}

/** Design doc §16.2/§16.3: produce the effective prompt string the runtime would send. */
export function renderMessagesToPrompt(systemPrompt: string, messages: AgentMessage[]): string {
	const parts: string[] = [];
	if (systemPrompt && systemPrompt.trim().length > 0) {
		parts.push(`<|im_start|>system\n${systemPrompt}<|im_end|>\n`);
	}
	for (const message of messages) parts.push(renderMessage(message));
	return parts.join("");
}

/**
 * Volatility normalisation (design doc §16.3 canonical-twin):
 * replace per-request IDs, timestamps, and host-specific noise so that two
 * runs with identical semantics but different volatile fields still match.
 */
export function normalizeVolatileContent(text: string): string {
	let out = text;
	// ISO timestamps
	out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "[TIMESTAMP]");
	// unix epoch (10+ digits)
	out = out.replace(/\b1[5-9]\d{8,}\b/g, "[UNIX_TS]");
	// uuid
	out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[UUID]");
	// sha-like or long-hex ids
	out = out.replace(/\b[0-9a-f]{16,64}\b/gi, "[HASH]");
	// request-id / run-id / call-id / trace-id opaque suffixes
	out = out.replace(/\b(?:req|run|call|trace|span|tool|msg|session|turn|id)-[a-z0-9]{4,}\b/gi, "[ID]");
	return out;
}

/**
 * Design doc §17.2: split the prompt into coarse segments labelled by message index, role, and tool names.
 * Used to attribute a cache break to a specific message range, not a raw byte offset.
 */
export function buildSegmentInfo(messages: AgentMessage[], tokenStarts: number[]): SegmentInfo[] {
	const segments: SegmentInfo[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i] as unknown as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "user";
		const toolNames: string[] = [];
		const content = message.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				const p = part as Record<string, unknown>;
				if (p && p.type === "toolCall" && typeof p.name === "string") toolNames.push(p.name);
			}
		}
		if (role === "toolResult" && typeof message.toolName === "string") toolNames.push(message.toolName);
		const start = tokenStarts[i] ?? 0;
		const nextStart = i + 1 < tokenStarts.length ? (tokenStarts[i + 1] ?? 0) : start;
		segments.push({
			blockIndex: -1,
			messageIndex: i,
			role: role === "toolResult" ? "tool" : role,
			toolNames,
			tokenStart: start,
			tokenCount: Math.max(nextStart - start, 0),
			source: i === 0 && role !== "user" ? "prompt" : "history",
			regionLabel: role === "toolResult" && typeof message.toolName === "string" ? `tool:${message.toolName}` : `${role}[${i}]`,
		});
	}
	return segments;
}
