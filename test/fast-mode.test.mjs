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
  const extension = { events: {} };
  // Do not create the extension's compatibility symlink in the real home directory.
  const exists = t.mock.method(fs, "existsSync", () => false);
  syncBuiltinESMExports();
  try {
    registerExtension({
      registerCommand(name, command) {
        assert.equal(name, "fast");
        extension.command = command;
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
      // OAuth billing uses a fresh prompt ID on every request, regardless of speed.
      for (const { body } of [before, fast, after]) {
        if (body.system) {
          body.system[0].text = body.system[0].text.replace(/cc_prompt_id=[0-9a-f-]+$/, "cc_prompt_id=<request>");
        }
      }
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

test("/fast toggles provider requests, survives model switches, and resets on reload", async (t) => {
  const requests = captureRequests(t);
  const extension = loadExtension(t);
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
  await extension.command.handler("", ctx);
  assert.equal(status, "Fast Mode");
  assert.match(notices.at(-1).message, /Premium pricing/);
  await send(true);
  await extension.command.handler("on", ctx);
  await send(true);
  await extension.command.handler("invalid", ctx);
  assert.match(notices.at(-1).message, /Usage:/);
  await send(true);

  for (const selected of [{ ...model, id: "claude-sonnet-5" }, { ...model, provider: "openrouter" }]) {
    ctx.model = selected;
    extension.events.model_select({ model: selected }, ctx);
    assert.equal(status, undefined);
    await send(false);
    await extension.command.handler("on", ctx);
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
  await extension.command.handler("", ctx);
  assert.equal(status, undefined);
  await send(false);
  ctx.model = undefined;
  await extension.command.handler("on", ctx);
  assert.equal(notices.at(-1).type, "warning");
  ctx.model = model;
  await send(false);
  await extension.command.handler("on", ctx);
  ctx.model = { ...model, provider: "openrouter" };
  await extension.command.handler("off", ctx);
  ctx.model = model;
  await send(false);
});
