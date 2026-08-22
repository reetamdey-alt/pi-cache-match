import type { CacheMatchConfig } from "./config.ts";
import { hashString } from "./config.ts";
import type { Confidence } from "./types.ts";

export interface TokenizerResult {
	tokenIds: number[];
	partialBytes?: unknown[];
	tokenStrings?: string[];
	normalizedTextHash?: string;
}

/**
 * Design doc §10 tokeniser.
 *
 * pi-cache-match is framework-level and does not ship a real BPE. We use a
 * deterministic, cache-perfect char/N-chars-per-token heuristic that produces
 * stable token ids within a session — exactness is not required for prefix
 * matching, only stability is.
 *
 * Confidence is always reported so callers know this is an approximation.
 */
export class Tokenizer {
	private cache = new Map<string, TokenizerResult>();
	private readonly maxCacheSize = 1024;

	constructor(private readonly config: CacheMatchConfig) {}

	encode(text: string, _opts: { model?: string } = {}): TokenizerResult {
		const key = hashString(`v1:${this.config.approximateCharTokens}:${text}`);
		const cached = this.cache.get(key);
		if (cached) return cached;
		const n = Math.max(this.config.approximateCharTokens, 1);
		const tokenIds: number[] = [];
		for (let i = 0; i < text.length; i += n) {
			const chunk = text.slice(i, i + n);
			// Deterministic 32-bit-ish pseudo-id from the chunk
			let h = 2166136261;
			for (let j = 0; j < chunk.length; j++) {
				h ^= chunk.charCodeAt(j);
				h = Math.imul(h, 16777619);
			}
			tokenIds.push(h >>> 0);
		}
		const result: TokenizerResult = {
			tokenIds,
			normalizedTextHash: key,
		};
		if (this.cache.size >= this.maxCacheSize) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.set(key, result);
		return result;
	}

	/** Approximate tokenizer → always low confidence; the extension surfaces `confidenceReasons`. */
	getConfidence(): Confidence {
		return "low";
	}
}

/** Design doc §11.1/§11.4: split token ids into full fixed-size blocks + a tail partial block. */
export function splitIntoBlocks(
	tokenIds: number[],
	blockSize: number,
): { fullBlocks: number[][]; partialBlock?: number[] } {
	const fullBlocks: number[][] = [];
	let i = 0;
	for (; i + blockSize <= tokenIds.length; i += blockSize) {
		fullBlocks.push(tokenIds.slice(i, i + blockSize));
	}
	const remainder = tokenIds.slice(i);
	return remainder.length > 0 ? { fullBlocks, partialBlock: remainder } : { fullBlocks };
}
