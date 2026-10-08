import { existsSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { loginAnthropic, refreshAnthropicToken } from "./auth.js";
import { streamAnthropicOAuth, supportsFastMode } from "./stream.js";

function ensureClaudeCodeSymlink() {
  const target = join(homedir(), ".pi");
  const link = join(homedir(), ".Claude Code");
  if (existsSync(target) && !existsSync(link)) {
    try {
      symlinkSync(target, link);
    } catch { }
  }
}

export default function (pi: ExtensionAPI) {
  ensureClaudeCodeSymlink();

  let fastMode = false;

  function updateFastModeStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      "anthropic-fast-mode",
      fastMode && supportsFastMode(ctx.model) ? "Fast Mode" : undefined,
    );
  }

  pi.on("session_start", (_event, ctx) => updateFastModeStatus(ctx));
  pi.on("model_select", (_event, ctx) => updateFastModeStatus(ctx));

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
      getApiKey: (credentials: OAuthCredentials) => credentials.access,
    } as unknown as ProviderConfig["oauth"],
    streamSimple: (model, context, options) =>
      streamAnthropicOAuth(model, context, options, fastMode),
  });
}
