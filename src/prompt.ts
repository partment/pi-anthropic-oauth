import type { CacheControlEphemeral } from "@anthropic-ai/sdk/resources/messages.js";
import type { CacheRetention, ProviderEnv } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { getClaudeCodeVersion } from "./version.js";

const CLAUDE_CODE_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

export interface ClaudeCodeAttribution {
  promptId: string;
  promptIndex: number;
  turnIndex: number;
  previousRequestId?: string;
}

// The version suffix samples the first user prompt, not the system prompt
// or the current tool result.
export function buildClaudeCodeBillingBlock(
  firstUserText = "",
  attribution?: ClaudeCodeAttribution,
): MessageContentBlock {
  const version = getClaudeCodeVersion();
  const suffix = createHash("sha256")
    .update(`59cf53e54c78${firstUserText[4] ?? "0"}${firstUserText[7] ?? "0"}${firstUserText[20] ?? "0"}${version}`)
    .digest("hex").slice(0, 3);
  let text = `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=sdk-cli;`;
  if (attribution) {
    // Keep the native pre-checksum placeholder and the existing OAuth field.
    // The native replacement checksum is not reproduced for Pi's prompt.
    text += " cch=00000;";
    if (attribution.previousRequestId && /^req_[A-Za-z0-9_-]{1,36}$/.test(attribution.previousRequestId)) {
      text += ` cc_prev_req=${attribution.previousRequestId};`;
    }
    text += ` cc_prompt_id=${attribution.promptId}; cc_turn_origin=sdk;`;
    text += ` cc_prompt_index=${attribution.promptIndex}; cc_turn_index=${attribution.turnIndex};`;
  }
  return { type: "text", text };
}
const PI_REMOVAL_ANCHORS = [
  "pi-coding-agent",
  "@earendil-works/pi-coding-agent",
  "badlogic/pi-mono",
] as const;

export const PI_REWRITE_MODE_ENV = "PI_ANTHROPIC_OAUTH_REWRITE_MODE";
export const PI_REWRITE_PATTERN_ENV = "PI_ANTHROPIC_OAUTH_REWRITE_PATTERN";

export type PiRewriteMode = "aggressive" | "path-safe" | "technical-safe" | "custom";

const DEFAULT_PI_REWRITE_MODE: PiRewriteMode = "aggressive";
const PI_REWRITE_PATTERN_SOURCES: Record<Exclude<PiRewriteMode, "custom">, string> = {
  aggressive: String.raw`\b[Pp]i\b`,
  "path-safe": String.raw`(?<![/\\])\b[Pp]i\b`,
  "technical-safe": String.raw`(?<![/\\.@:_-])\b[Pp]i\b(?![/\\.@:_-])`,
};

const PI_REWRITE_MODES = new Set<PiRewriteMode>([
  "aggressive",
  "path-safe",
  "technical-safe",
  "custom",
]);

type MessageContentBlock = {
  type: "text";
  text: string;
  cache_control?: CacheControlEphemeral;
};

export function sanitizeSurrogates(text: string): string {
  // Replace only *unpaired* surrogates: a high surrogate not followed by a low
  // surrogate, or a low surrogate not preceded by a high surrogate. Valid
  // surrogate pairs (non-BMP characters such as emoji) must pass through
  // untouched. Equivalent to String.prototype.toWellFormed(), which requires
  // Node 20+ while this package supports Node >=18.
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

export function resolveCacheRetention(
  cacheRetention: CacheRetention | undefined,
  env?: ProviderEnv,
  defaultRetention: CacheRetention = "short",
): CacheRetention {
  if (cacheRetention) return cacheRetention;
  const envValue = env?.PI_CACHE_RETENTION ?? process.env.PI_CACHE_RETENTION;
  return envValue === "long" || envValue === "short" || envValue === "none"
    ? envValue : defaultRetention;
}

export function cacheControlFor(
  cacheRetention: CacheRetention,
): CacheControlEphemeral | undefined {
  if (cacheRetention === "none") return undefined;
  if (cacheRetention === "long") return { type: "ephemeral", ttl: "1h" };
  return { type: "ephemeral" };
}

export function buildAnthropicSystemPrompt(
  systemPrompt: string | undefined,
  isOAuth: boolean,
  cacheRetention: CacheRetention = "short",
  firstUserText = "",
  attribution?: ClaudeCodeAttribution,
): MessageContentBlock[] | undefined {
  const blocks: MessageContentBlock[] = [];

  if (isOAuth) {
    blocks.push(buildClaudeCodeBillingBlock(firstUserText, attribution));
    const cacheControl = cacheControlFor(cacheRetention);
    blocks.push({
      type: "text", text: CLAUDE_CODE_IDENTITY,
      ...(cacheControl && { cache_control: cacheControl }),
    });
  }

  const sanitized = systemPrompt
    ? sanitizeSystemText(sanitizeSurrogates(systemPrompt))
    : "";
  if (sanitized) {
    const cacheControl = cacheControlFor(cacheRetention);
    blocks.push({
      type: "text",
      text: sanitized,
      ...(cacheControl && { cache_control: cacheControl }),
    });
  }

  return blocks.length > 0 ? blocks : undefined;
}

export function sanitizeSystemText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const paragraphs = text.split(/\n\n+/);
  const filtered = paragraphs.filter((paragraph) => {
    const lower = paragraph.toLowerCase();
    if (lower.includes("you are pi")) return false;
    return !PI_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor));
  });

  const filteredText = filtered.join("\n\n");
  const rewritePattern = resolvePiRewritePattern(env);
  rejectZeroLengthMatches(rewritePattern, filteredText);

  return filteredText.replace(rewritePattern, "Claude Code").trim();
}

function resolvePiRewritePattern(env: NodeJS.ProcessEnv): RegExp {
  const mode = parsePiRewriteMode(env[PI_REWRITE_MODE_ENV]);
  if (mode === "custom") return compileCustomPiRewritePattern(env[PI_REWRITE_PATTERN_ENV]);
  return new RegExp(PI_REWRITE_PATTERN_SOURCES[mode], "g");
}

function parsePiRewriteMode(value: string | undefined): PiRewriteMode {
  if (!value?.trim()) return DEFAULT_PI_REWRITE_MODE;
  const mode = value.trim().toLowerCase();
  if (PI_REWRITE_MODES.has(mode as PiRewriteMode)) return mode as PiRewriteMode;
  throw new Error(
    `Invalid ${PI_REWRITE_MODE_ENV}: ${value}. Expected one of ${Array.from(PI_REWRITE_MODES).join(", ")}.`,
  );
}

function compileCustomPiRewritePattern(value: string | undefined): RegExp {
  const pattern = value?.trim();
  if (!pattern) {
    throw new Error(`${PI_REWRITE_PATTERN_ENV} must be set when ${PI_REWRITE_MODE_ENV}=custom.`);
  }

  const parsed = parseRegexLiteral(pattern) ?? { source: pattern, flags: "" };
  const flags = parsed.flags.includes("g") ? parsed.flags : `${parsed.flags}g`;
  let compiled: RegExp;
  try {
    compiled = new RegExp(parsed.source, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${PI_REWRITE_PATTERN_ENV}: ${message}`);
  }

  rejectZeroLengthMatches(compiled, "");
  return compiled;
}

function rejectZeroLengthMatches(pattern: RegExp, text: string): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex = 0;
      throw new Error(
        `Invalid ${PI_REWRITE_PATTERN_ENV}: the pattern can match without consuming text. Use (?!) to disable rewriting.`,
      );
    }
  }
  pattern.lastIndex = 0;
}

function parseRegexLiteral(value: string): { source: string; flags: string } | undefined {
  if (!value.startsWith("/")) return undefined;

  for (let index = value.length - 1; index > 0; index--) {
    if (value[index] !== "/" || isEscaped(value, index)) continue;
    return { source: value.slice(1, index), flags: value.slice(index + 1) };
  }

  return undefined;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}
