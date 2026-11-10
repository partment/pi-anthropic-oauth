import { createHash, randomUUID } from "node:crypto";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import {
  type Api,
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
  registerSessionResourceCleanup,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getAnthropicUserId, isClaudeOAuthAccessToken } from "./auth.js";
import { convertPiMessagesToAnthropic, convertPiToolsToAnthropic } from "./convert.js";
import { buildAnthropicSystemPrompt, resolveCacheRetention } from "./prompt.js";
import { makeClaudeCodeUserAgent } from "./version.js";

const LEGACY_THINKING_MODEL = /^claude-(?:opus|sonnet|haiku)-4-[0-5](?:-|$)|^claude-[0-3][-.]/;
const fallbackSessionId = randomUUID();
const sessions = new Map<string, { promptKey: string; promptId: string; previousRequestId?: string }>();
registerSessionResourceCleanup((sessionId) => {
  if (sessionId) sessions.delete(sessionId);
  else sessions.clear();
});

export function supportsFastMode(model?: Model<Api>): boolean {
  return model?.provider === "anthropic" &&
    ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"].includes(model.id);
}

export function usesAdaptiveThinking(model: Model<Api>): boolean {
  const forced = (model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking;
  if (typeof forced === "boolean") return forced;
  return !LEGACY_THINKING_MODEL.test(model.id.toLowerCase().replace(/\./g, "-"));
}

/** Builds model-specific inference parameters and client headers. */
export function buildClaudeCodeRequest(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  fastModeEnabled = false,
) {
  const apiKey = options.apiKey!;
  const isOAuth = isClaudeOAuthAccessToken(apiKey);
  const firstParty = new URL(model.baseUrl).hostname === "api.anthropic.com";
  const id = model.id.toLowerCase().replace(/\./g, "-");
  const adaptive = usesAdaptiveThinking(model);
  const midConversationSystem = /^claude-opus-(?:4-8|5(?:-5)?)(?:$|-\d{8}$)/.test(id);
  const perTurnEffort = /^claude-opus-5-5(?:$|-\d{8}$)/.test(id);
  const fastMode = fastModeEnabled && supportsFastMode(model);
  const cacheRetention = resolveCacheRetention(options.cacheRetention, options.env, isOAuth ? "long" : "short");
  const defaultMaxTokens = perTurnEffort ? 128000
    : /^claude-opus-(?:4-[6-9]|5)(?:-|$)/.test(id) ? 64000 : 32000;
  const maxTokens = options.maxTokens ?? Math.min(model.maxTokens, defaultMaxTokens);

  const userMessages = context.messages.filter((message) => message.role === "user");
  const firstUser = userMessages[0]?.content;
  const firstUserText = typeof firstUser === "string" ? firstUser
    : firstUser?.find((block) => block.type === "text")?.text ?? "";
  const sessionId = options.sessionId || fallbackSessionId;
  const promptKey = createHash("sha256").update(JSON.stringify(userMessages.at(-1) ?? null)).digest("hex");
  let session = sessions.get(sessionId);
  if (!session) {
    session = { promptKey, promptId: randomUUID() };
    sessions.set(sessionId, session);
  } else if (session.promptKey !== promptKey) {
    session.promptKey = promptKey;
    session.promptId = randomUUID();
  }

  // Fold transcript system updates into the current top-level prompt.
  const transcript = collapseSystemMessages(context);
  const systemPrompt = getCurrentSystemPrompt(transcript.messages);
  const system = buildAnthropicSystemPrompt(systemPrompt, true, cacheRetention, firstUserText,
    firstParty ? {
      promptId: session.promptId,
      promptIndex: Math.max(0, userMessages.length - 1),
      turnIndex: Math.max(1, userMessages.length),
      previousRequestId: session.previousRequestId,
    } : undefined);
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    messages: convertPiMessagesToAnthropic(transcript.messages, isOAuth, model, cacheRetention),
    system,
    tools: convertPiToolsToAnthropic(getCurrentTools(transcript.messages), isOAuth),
    metadata: { user_id: getAnthropicUserId(apiKey, sessionId) },
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
    stream: true,
  };

  if (adaptive) {
    const reasoning = options.reasoning ?? "high";
    const mapped = model.thinkingLevelMap?.[reasoning];
    const effort = typeof mapped === "string" ? mapped : reasoning === "minimal" ? "low" : reasoning;
    params.output_config = { effort: effort as NonNullable<MessageCreateParamsStreaming["output_config"]>["effort"] };
  }
  if (options.reasoning && model.reasoning) {
    if (adaptive) {
      // Preserve adaptive thinking even for Pi's one-token cache-warming replay.
      params.thinking = { type: "adaptive", display: "summarized" };
    } else {
      const requested = options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets] ?? 31999;
      const budget = Math.min(requested, maxTokens - 1);
      if (budget >= 1024) params.thinking = { type: "enabled", budget_tokens: budget, display: "summarized" };
    }
  }
  if (perTurnEffort && params.thinking?.type === "disabled") delete params.thinking;
  if (params.thinking && params.thinking.type !== "disabled") {
    params.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
  }
  if (fastMode) params.speed = "fast";

  // Keep user-message representation stable when the cache marker moves forward.
  for (const message of params.messages) {
    if (message.role === "user" && typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content }];
    }
  }
  if (firstParty) {
    const previous = [...context.messages].reverse().find((message) =>
      message.role === "assistant" && message.provider === model.provider && message.model === model.id &&
      message.stopReason !== "error" && message.stopReason !== "aborted");
    params.diagnostics = { previous_message_id: previous?.role === "assistant" ? previous.responseId ?? null : null };
  }

  // Ordering also matches the captured CLI. Do not add fine-grained tool
  // streaming: the CLI doesn't send it in this profile, and Pi needs valid JSON.
  const betas: string[] = [];
  const haiku = id.startsWith("claude-haiku-");
  if (!haiku) betas.push("claude-code-20250219");
  if (isOAuth) betas.push("oauth-2025-04-20");
  betas.push("interleaved-thinking-2025-05-14", "thinking-token-count-2026-05-13", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05");
  if (midConversationSystem) {
    betas.push("mid-conversation-system-2026-04-07");
    if (perTurnEffort) betas.push("per-turn-control-2026-07-01");
    betas.push("mid-conversation-tool-changes-2026-07-01");
    if (firstParty) betas.push("mid-conversation-system-clear-at-2026-08-21");
  }
  if (adaptive) betas.push("effort-2025-11-24");
  if (haiku) betas.push("claude-code-20250219");
  if (firstParty && params.thinking && params.thinking.type !== "disabled") betas.push("thinking-binding-controls-2026-08-01");
  if (fastMode) betas.push("fast-mode-2026-02-01");
  if (isOAuth || cacheRetention === "long") betas.push("extended-cache-ttl-2025-04-11");
  if (firstParty) betas.push("cache-diagnosis-2026-04-07");

  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": makeClaudeCodeUserAgent(),
    "x-app": "cli",
    "x-claude-code-session-id": sessionId,
  };
  if (firstParty) {
    headers["x-claude-code-prompt-id"] = session.promptId;
    headers["x-claude-code-request-class"] = "main";
    headers["x-client-request-id"] = randomUUID();
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    const normalized = key.toLowerCase();
    if (normalized === "anthropic-beta") {
      if (value) betas.push(...value.split(",").map((beta) => beta.trim()).filter(Boolean));
    } else if (value !== null && !(normalized in headers) &&
      !["authorization", "x-api-key", "anthropic-version"].includes(normalized)) {
      headers[normalized] = value;
    }
  }
  headers["anthropic-beta"] = [...new Set(betas)].join(",");
  return { params, headers, session };
}
