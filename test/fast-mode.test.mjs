import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { normalizeContext } from "@earendil-works/pi-ai";
import registerExtension from "../.test-dist/index.js";
import { streamAnthropicOAuth, supportsFastMode } from "../.test-dist/stream.js";

const FAST_BETA = "fast-mode-2026-02-01";
const model = {
  id: "claude-opus-5",
  name: "Claude Opus 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};
const context = normalizeContext({
  messages: [{ role: "user", content: "Hello", timestamp: 0 }],
});
const options = { apiKey: "sk-ant-oat-test", reasoning: "high" };

function captureRequests(t) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(init.method, "POST");
    requests.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) =>
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    ).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  return requests;
}

function loadExtension(t) {
  const extension = { commands: {}, events: {} };
  // Do not create the extension's compatibility symlink in the real home directory.
  const exists = t.mock.method(fs, "existsSync", () => false);
  syncBuiltinESMExports();
  try {
    registerExtension({
      registerCommand(name, command) {
        extension.commands[name] = command;
      },
      registerProvider(name, provider) {
        assert.equal(name, "anthropic");
        extension.provider = provider;
      },
      on(event, handler) { extension.events[event] = handler; },
    });
  } finally {
    exists.mock.restore();
    syncBuiltinESMExports();
  }
  return extension;
}

test("Fast Mode is limited to officially supported Anthropic models", () => {
  for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) {
    assert.equal(supportsFastMode({ ...model, id }), true, id);
  }
  for (const id of ["claude-opus-4-6", "claude-opus-4-7", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5", "custom-model"]) {
    assert.equal(supportsFastMode({ ...model, id }), false, id);
  }
  assert.equal(supportsFastMode({ ...model, provider: "openrouter" }), false);
  assert.equal(supportsFastMode(undefined), false);
});

test("Fast Mode adds only speed and its beta to OAuth and API-key requests", async (t) => {
  const requests = captureRequests(t);
  for (const apiKey of [options.apiKey, "sk-ant-api-test"]) {
    for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) {
      for (const enabled of [false, true, false]) {
        const result = await streamAnthropicOAuth({ ...model, id }, context, { ...options, apiKey }, enabled).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        const { body, headers } = requests.at(-1);
        assert.equal(body.speed, enabled ? "fast" : undefined);
        assert.equal(Object.hasOwn(body, "speed"), enabled);
        assert.equal(headers.get("anthropic-beta").split(",").includes(FAST_BETA), enabled);
        assert.equal(body.model, id);
        assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
        assert.deepEqual(body.output_config, { effort: "high" });
        if (apiKey === options.apiKey) {
          assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
          assert.equal(headers.get("x-api-key"), null);
          assert.equal(headers.get("x-app"), "cli");
          assert.match(headers.get("anthropic-beta"), /oauth-2025-04-20/);
          assert.match(headers.get("anthropic-beta"), /claude-code-20250219/);
        } else {
          assert.equal(headers.get("x-api-key"), apiKey);
        }
      }
      const [before, fast, after] = requests.slice(-3);
      // A prompt spans tool/API iterations; only the per-request ID changes.
      assert.equal(after.headers.get("x-claude-code-prompt-id"), before.headers.get("x-claude-code-prompt-id"));
      assert.notEqual(after.headers.get("x-client-request-id"), before.headers.get("x-client-request-id"));
      after.headers.delete("x-client-request-id");
      before.headers.delete("x-client-request-id");
      const { speed, ...fastBody } = fast.body;
      assert.deepEqual(fastBody, before.body);
      assert.deepEqual(after.body, before.body);
      assert.deepEqual([...after.headers], [...before.headers]);
    }
  }
});

test("Fast Mode preserves required and custom beta headers without duplicates", async (t) => {
  const requests = captureRequests(t);
  for (const beta of [`custom-beta, ${FAST_BETA},oauth-2025-04-20`, null, ""]) {
    const result = await streamAnthropicOAuth(model, context, {
      ...options,
      headers: { "Anthropic-Beta": beta, "X-Test": "kept", Authorization: "ignored", "X-API-Key": "ignored" },
    }, true).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    const { headers } = requests.at(-1);
    const betas = headers.get("anthropic-beta").split(",");
    assert.equal(betas.filter((value) => value === FAST_BETA).length, 1);
    assert.equal(betas.filter((value) => value === "oauth-2025-04-20").length, 1);
    assert.ok(betas.includes("claude-code-20250219"));
    assert.ok(betas.includes("interleaved-thinking-2025-05-14"));
    assert.equal(betas.includes("custom-beta"), Boolean(beta));
    assert.equal(headers.get("x-test"), "kept");
    assert.equal(headers.get("authorization"), `Bearer ${options.apiKey}`);
    assert.equal(headers.get("x-api-key"), null);
  }
});

test("unsupported models and other providers never receive Fast Mode additions", async (t) => {
  const requests = captureRequests(t);
  for (const selected of [
    { ...model, id: "claude-sonnet-5" },
    { ...model, id: "claude-opus-4-6" },
    { ...model, provider: "openrouter" },
  ]) {
    const result = await streamAnthropicOAuth(selected, context, options, true).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(Object.hasOwn(requests.at(-1).body, "speed"), false);
    assert.equal(requests.at(-1).headers.get("anthropic-beta").includes(FAST_BETA), false);
  }
});

test("Fast Mode preserves cache retention, tools, and empty-text filtering", async (t) => {
  const requests = captureRequests(t);
  const transcript = normalizeContext({
    systemPrompt: "You are a helpful assistant.",
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: [
      { type: "text", text: "" },
      { type: "text", text: "Read a file." },
    ], timestamp: 0 }],
  });
  for (const enabled of [false, true]) {
    for (const cacheRetention of ["none", "short", "long"]) {
      const result = await streamAnthropicOAuth(model, transcript, { ...options, cacheRetention }, enabled).result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      const { body } = requests.at(-1);
      const cacheControl = cacheRetention === "none" ? undefined : {
        type: "ephemeral", ...(cacheRetention === "long" ? { ttl: "1h" } : {}),
      };
      assert.equal(body.speed, enabled ? "fast" : undefined);
      assert.equal(body.tools[0].name, "Read");
      assert.equal(body.messages[0].content.length, 1);
      assert.equal(body.messages[0].content[0].text, "Read a file.");
      assert.deepEqual(body.messages[0].content[0].cache_control, cacheControl);
      const tail = body.messages.at(-1);
      assert.equal(tail.role, "user");
      assert.deepEqual(Array.isArray(tail.content) ? tail.content.at(-1).cache_control : undefined, cacheControl);
      assert.deepEqual(body.system.at(-1).cache_control, cacheControl);
    }
  }
});

test("/usage remains available while Fast Mode is on without changing inference settings", async (t) => {
  const requests = captureRequests(t);
  const messageFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === "https://api.anthropic.com/api/oauth/usage" || url === "https://api.anthropic.com/api/oauth/profile") {
      assert.equal(init.headers.Authorization, `Bearer ${options.apiKey}`);
      assert.equal(init.headers["anthropic-beta"], "oauth-2025-04-20");
      return Response.json(url.endsWith("/usage")
        ? { five_hour: { utilization: 25 } }
        : { organization: { organization_type: "claude_pro" } });
    }
    return messageFetch(url, init);
  });
  const extension = loadExtension(t);
  const notices = [];
  const ctx = {
    mode: "rpc", model,
    modelRegistry: { async getApiKeyForProvider(provider) {
      assert.equal(provider, "anthropic");
      return options.apiKey;
    } },
    ui: { setStatus() {}, notify(message, type) { notices.push({ message, type }); } },
  };
  await extension.commands.fast.handler("on", ctx);
  await extension.commands.usage.handler("", ctx);
  assert.equal(notices.at(-1).type, "info");
  assert.match(notices.at(-1).message, /Plan: Pro/);
  assert.match(notices.at(-1).message, /25% used/);
  const result = await extension.provider.streamSimple(model, context, options).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(requests.at(-1).body.speed, "fast");
  assert.ok(requests.at(-1).headers.get("anthropic-beta").includes(FAST_BETA));
});

test("/fast toggles provider requests, survives model switches, and resets on reload", async (t) => {
  const requests = captureRequests(t);
  const extension = loadExtension(t);
  assert.deepEqual(Object.keys(extension.commands).sort(), ["fast", "usage"]);
  const notices = [];
  let status;
  const ctx = {
    model,
    ui: {
      notify(message, type) { notices.push({ message, type }); },
      setStatus(key, text) {
        assert.equal(key, "anthropic-fast-mode");
        status = text;
      },
    },
  };
  const send = async (expected, provider = extension.provider) => {
    const result = await provider.streamSimple(ctx.model, context, options).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(requests.at(-1).body.speed, expected ? "fast" : undefined);
    assert.equal(requests.at(-1).headers.get("anthropic-beta").includes(FAST_BETA), expected);
  };

  extension.events.session_start({}, ctx);
  assert.equal(status, undefined);
  await send(false);
  await extension.commands.fast.handler("", ctx);
  assert.equal(status, "Fast Mode");
  assert.match(notices.at(-1).message, /Premium pricing/);
  await send(true);
  await extension.commands.fast.handler("on", ctx);
  await send(true);
  await extension.commands.fast.handler("invalid", ctx);
  assert.match(notices.at(-1).message, /Usage:/);
  await send(true);

  for (const selected of [{ ...model, id: "claude-sonnet-5" }, { ...model, provider: "openrouter" }]) {
    ctx.model = selected;
    extension.events.model_select({ model: selected }, ctx);
    assert.equal(status, undefined);
    await send(false);
    await extension.commands.fast.handler("on", ctx);
    assert.equal(notices.at(-1).type, "warning");
    ctx.model = model;
    extension.events.model_select({ model }, ctx);
    assert.equal(status, "Fast Mode");
    await send(true);
  }

  const reloaded = loadExtension(t);
  reloaded.events.session_start({}, ctx);
  assert.equal(status, undefined);
  await send(false, reloaded.provider);
  await send(true);
  await extension.commands.fast.handler("", ctx);
  assert.equal(status, undefined);
  await send(false);
  ctx.model = undefined;
  await extension.commands.fast.handler("on", ctx);
  assert.equal(notices.at(-1).type, "warning");
  ctx.model = model;
  await send(false);
  await extension.commands.fast.handler("on", ctx);
  ctx.model = { ...model, provider: "openrouter" };
  await extension.commands.fast.handler("off", ctx);
  ctx.model = model;
  await send(false);
});

test("tool durations use wire names, reset after sending, and never leak between providers or sessions", async (t) => {
  const requests = captureRequests(t);
  const extension = loadExtension(t);
  const ctx = { model, ui: { setStatus() {} } };
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const record = (name = "read", id = "tool-1") => {
    extension.events.tool_execution_start({ toolCallId: id, toolName: name }, ctx);
    now += 8.4;
    extension.events.tool_execution_end({ toolCallId: id, toolName: name }, ctx);
  };
  const send = async (opts = options) => {
    const result = await extension.provider.streamSimple(model, context, opts).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    return requests.at(-1).headers.get("x-claude-code-prev-tool-durations");
  };
  record();
  record("my-tool", "tool-2");
  assert.equal(await send(), "Read=8;mcp__pi__my-tool=8");
  assert.equal(await send(), null);
  record("a;b=c,d e%字");
  assert.equal(await send({ ...options, apiKey: "sk-ant-api-test" }), "a%3Bb%3Dc%2Cd%20e%25%E5%AD%97=8");
  for (let i = 0; i < 40; i++) record();
  assert.equal((await send()).split(";").length, 32);
  record("x".repeat(4090));
  record();
  assert.ok((await send({ ...options, apiKey: "sk-ant-api-test" })).length <= 4096);
  record();
  extension.events.session_start({}, ctx);
  assert.equal(await send(), null);
  record();
  ctx.model = { ...model, provider: "openrouter" };
  extension.events.model_select({}, ctx);
  record();
  ctx.model = model;
  extension.events.model_select({}, ctx);
  assert.equal(await send(), null);
});
