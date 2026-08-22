import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function firstNonEmpty(keys: string[]): string {
	for (const key of keys) {
		const value = process.env[key];
		if (isNonEmpty(value)) return value.trim();
	}
	return "";
}

function readJsonSafe(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function readPiSettingsCalls(): Record<string, unknown> | undefined {
	return readJsonSafe(join(osHomedir(), ".pi", "agent", "settings.json"));
}

function deepLookup(obj: unknown, dottedPath: string): string {
	if (!obj || typeof obj !== "object") return "";
	const value = dottedPath.split(".").reduce<unknown>((acc, part) => {
		if (!acc || typeof acc !== "object") return undefined;
		return (acc as Record<string, unknown>)[part];
	}, obj);
	return isNonEmpty(value) ? value.trim() : "";
}

/** Design doc §23: telemetry must never contain raw prompt content. This enforces safe string emission. */
export function safeString(value: unknown, maxLen = 256): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		const json = JSON.stringify(value);
		if (!isNonEmpty(json)) return "";
		return json.length > maxLen ? `${json.slice(0, maxLen)}…` : json;
	} catch {
		return "";
	}
}

/** Deterministic anonymous ID used when a call label is missing. */
export function anonymousId(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

/** Design doc §11.3: stable 16-hex-char hash (FNV-1a 64-bit) of an arbitrary payload. */
export function hashString(input: string): string {
	let h1 = 0xcbf29ce484222325n;
	let h2 = 0x84222325cbf29ce4n;
	const prime = 0x00000100000001b3n;
	const mask = 0xffffffffffffffffn;
	for (let i = 0; i < input.length; i++) {
		const c = BigInt(input.charCodeAt(i) & 0xff);
		h1 = (h1 ^ c) * prime & mask;
		h2 = (h2 ^ BigInt((i + 1) & 0xff)) * prime & mask;
	}
	return (h1 ^ h2).toString(16).padStart(16, "0").slice(0, 16);
}

/** Hash the extra-cache-key map with stable key ordering (design doc §11.2 extra_cache_keys). */
export function hashExtraCacheKeys(keys: Record<string, string>): string {
	const ordered = Object.keys(keys)
		.sort()
		.map((k) => `${k}=${keys[k]}`)
		.join("&");
	return hashString(`extra:${ordered}`);
}

export interface CacheMatchConfig {
	/** Design doc §10.1: default 16 tokens (vLLM-compatible page size). */
	blockSizeTokens: number;
	/** Design doc §11.3: fingerprint namespace version. */
	fingerprintVersion: string;
	/** Design doc §11.2: tenant/namespace isolation salt. */
	cacheSalt: string;
	/** Design doc §14.2: Prometheus naming insight — prefix only for the local JSONL stream. */
	eventName: string;
	/** Design doc §10.4: chars/token heuristic when no tokenizer is available. */
	approximateCharTokens: number;
	orgId: string;
	appId: string;
	agentId: string;
	templateVersion: string;
	tokenizerVersion: string;
	debugMode: boolean;
	telemetryDir: string;
	maxSessionIndexEntries: number;

	customTokenizers?: unknown;
	customProviders?: unknown;
}

function resolveTemplateVersion(): string {
	const direct = firstNonEmpty(["PI_CACHE_MATCH_TEMPLATE_VERSION", "PI_TEMPLATE_VERSION"]);
	if (isNonEmpty(direct)) return direct;
	const settings = readPiSettingsCalls();
	const fromSettings = deepLookup(settings, "defaults.templateVersion") || deepLookup(settings, "templateVersion");
	if (isNonEmpty(fromSettings)) return fromSettings;
	return "chat-template-v5";
}

function resolveTokenizerVersion(): string {
	const direct = firstNonEmpty(["PI_CACHE_MATCH_TOKENIZER_VERSION", "PI_TOKENIZER_VERSION"]);
	if (isNonEmpty(direct)) return direct;
	return "tokenizer-v3";
}

function resolveOrgAppAgent(): Pick<CacheMatchConfig, "orgId" | "appId" | "agentId"> {
	const settings = readPiSettingsCalls();
	const orgId =
		firstNonEmpty(["PI_CACHE_MATCH_ORG_ID", "PI_ORG_ID", "XYNE_ORG_ID"]) ||
		deepLookup(settings, "telemetry.orgId") ||
		deepLookup(settings, "defaults.orgId") ||
		"org_x";
	const appId =
		firstNonEmpty(["PI_CACHE_MATCH_APP_ID", "PI_APP_ID", "XYNE_APP_ID"]) ||
		deepLookup(settings, "telemetry.appId") ||
		deepLookup(settings, "defaults.appId") ||
		"xyne";
	const agentId =
		firstNonEmpty(["PI_CACHE_MATCH_AGENT_ID", "PI_AGENT_ID", "XYNE_AGENT_ID"]) ||
		deepLookup(settings, "telemetry.agentId") ||
		deepLookup(settings, "defaults.agentId") ||
		"xyne-cli";
	return { orgId, appId, agentId };
}

export function resolveConfig(cwd: string): CacheMatchConfig {
	const { orgId, appId, agentId } = resolveOrgAppAgent();
	const telemetryDir =
		firstNonEmpty(["PI_CACHE_MATCH_TELEMETRY_DIR"]) || join(osHomedir(), ".pi", "agent", "cache-match");
	return {
		blockSizeTokens: parseInt(firstNonEmpty(["PI_CACHE_MATCH_BLOCK_SIZE_TOKENS", "PI_BLOCK_SIZE_TOKENS"]) || "16", 10) || 16,
		// Doc §11.3/§14: fingerprint_version is a static schema label, not a per-org derivation.
		// Tenant isolation happens via cache_namespace + cacheSalt, not version skew.
		fingerprintVersion: firstNonEmpty(["PI_CACHE_MATCH_FINGERPRINT_VERSION"]) || "pi-cache-fp-v1",
		// Default salt: deterministic per (org, app) so a pi process restart
		// doesn't lose lineage. Override with PI_CACHE_MATCH_SALT for strict isolation.
		cacheSalt: firstNonEmpty(["PI_CACHE_MATCH_SALT", "PI_SOFT_SALT"]) || `salt-${hashString(`${orgId}:${appId}`).slice(0, 12)}`,
		eventName: "pi.cache_match.completion",
		approximateCharTokens: 4,
		orgId,
		appId,
		agentId,
		templateVersion: resolveTemplateVersion(),
		tokenizerVersion: resolveTokenizerVersion(),
		debugMode: firstNonEmpty(["PI_CACHE_MATCH_DEBUG", "PI_CACHE_MATCH_DEBUG_MODE"]) === "1",
		telemetryDir,
		maxSessionIndexEntries: 1000,
	};
}
