import { hashExtraCacheKeys, hashString } from "./config.ts";

/** Design doc §11.2 initial parent_hash. */
export const ZERO_HASH = "0000000000000000" as const;
export const emptyParentHash: string = ZERO_HASH;

/** Design doc §11.2 input tuple that goes into the chained hash. */
export interface BlockFingerprintInput {
	fingerprintVersion: string;
	model: string;
	tokenizerVersion: string;
	templateVersion: string;
	cacheNamespace: string;
	parentHash: string;
	tokenIds: number[];
	extraCacheKeys: Record<string, string>;
}

/**
 * vLLM-style chained block fingerprint.
 *
 *   block_hash[i] = H( fp_version | model | tokenizer_version | template_version
 *                     | cache_namespace | parent_hash[i-1] | token_ids | extra_cache_keys )
 *
 * `H` is the salted FNV-1a 64-bit string hash from config. Only hashes are
 * retained downstream — never the token list itself.
 */
export function hashBlock(input: BlockFingerprintInput): string {
	const parts = [
		input.fingerprintVersion,
		input.model,
		input.tokenizerVersion,
		input.templateVersion,
		input.cacheNamespace,
		input.parentHash,
		input.tokenIds.join(","),
		hashExtraCacheKeys(input.extraCacheKeys),
	];
	return hashString(parts.join("|"));
}
