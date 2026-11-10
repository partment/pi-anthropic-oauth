import { existsSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { getAnthropicApiKey, isClaudeOAuthAccessToken, loginAnthropic, refreshAnthropicToken } from "./auth.js";
import { streamAnthropicOAuth, supportsFastMode } from "./stream.js";
import { registerUsageCommand } from "./usage.js";
import { toClaudeCodeToolName } from "./convert.js";

function ensureClaudeCodeSymlink() {
  const target = join(homedir(), ".pi");
  const link = join(homedir(), ".Claude Code");
  if (existsSync(target) && !existsSync(link)) {
    try {
      symlinkSync(target, link);
    } catch {
      // Best effort: a failed compatibility symlink must not prevent loading.
    }
  }
}

export default function (pi: ExtensionAPI) {
  ensureClaudeCodeSymlink();
  registerUsageCommand(pi);

  let fastMode = false;
  const toolStarts = new Map<string, number>();
  let toolDurations: { name: string; ms: number }[] = [];

  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.model?.provider === "anthropic") toolStarts.set(event.toolCallId, performance.now());
  });
  pi.on("tool_execution_end", (event) => {
    const start = toolStarts.get(event.toolCallId);
    toolStarts.delete(event.toolCallId);
    if (start !== undefined && toolDurations.length < 32) toolDurations.push({ name: event.toolName, ms: Math.max(0, Math.round(performance.now() - start)) });
  });

  function updateFastModeStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      "anthropic-fast-mode",
      fastMode && supportsFastMode(ctx.model) ? "Fast Mode" : undefined,
    );
  }

  pi.on("session_start", (_event, ctx) => {
    toolStarts.clear();
    toolDurations = [];
    updateFastModeStatus(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    if (ctx.model?.provider !== "anthropic") {
      toolStarts.clear();
      toolDurations = [];
    }
    updateFastModeStatus(ctx);
  });

  pi.registerCommand("fast", {
    description: "Toggle Fast Mode for supported Anthropic Opus models (/fast [on|off])",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /fast [on|off]", "warning");
        return;
      }
      const enabled = action ? action === "on" : !fastMode;
      if (enabled && !supportsFastMode(ctx.model)) {
        ctx.ui.notify("Fast Mode requires a supported Anthropic Opus model.", "warning");
        return;
      }
      fastMode = enabled;
      updateFastModeStatus(ctx);
      ctx.ui.notify(
        fastMode
          ? "Fast Mode on. Premium pricing applies; subscriptions require usage credits."
          : "Fast Mode off.",
        fastMode ? "warning" : "info",
      );
    },
  });

  pi.registerProvider("anthropic", {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    oauth: {
      name: "Claude Pro/Max",
      usesCallbackServer: true,
      login: loginAnthropic,
      refreshToken: refreshAnthropicToken,
      getApiKey: getAnthropicApiKey,
    } as unknown as ProviderConfig["oauth"],
    streamSimple: (model, context, options) => {
      const durations = toolDurations;
      toolDurations = [];
      let value = "";
      if (new URL(model.baseUrl).hostname === "api.anthropic.com") {
        for (const { name, ms } of durations) {
          const wireName = isClaudeOAuthAccessToken(options?.apiKey ?? "") ? toClaudeCodeToolName(name) : name;
          const escaped = wireName.replace(/%|[;=, ]|[^\x20-\x7e]/gu, (character) => encodeURIComponent(character));
          const entry = `${value ? ";" : ""}${escaped}=${ms}`;
          if (value.length + entry.length > 4096) break;
          value += entry;
        }
      }
      return streamAnthropicOAuth(model, context, value ? {
        ...options,
        headers: { ...options?.headers, "x-claude-code-prev-tool-durations": value },
      } : options, fastMode);
    },
  });
}
