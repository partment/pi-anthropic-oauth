import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { normalizeContext, cleanupSessionResources } from "@earendil-works/pi-ai";
import { streamAnthropicOAuth } from "../.test-dist/stream.js";
import { buildClaudeCodeRequest } from "../.test-dist/request.js";
import { buildClaudeCodeBillingBlock } from "../.test-dist/prompt.js";
import { getAnthropicApiKey, getAnthropicUserId, refreshAnthropicToken } from "../.test-dist/auth.js";
import { convertPiToolsToAnthropic } from "../.test-dist/convert.js";
import { normalizeRequest } from "./request-normalization.mjs";
import { getClaudeCodeVersion, makeClaudeCodeUserAgent } from "../.test-dist/version.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/anthropic-requests.json", import.meta.url), "utf8"));
const model = {
  id: "claude-opus-5", name: "Claude Opus 5", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://api.anthropic.com", reasoning: true, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 200000,
};
const readTool = { name: "read", description: "Pi Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } };
const context = () => normalizeContext({ systemPrompt: "Test prompt.", messages: [{ role: "user", content: "hello", timestamp: 0 }] });
const options = () => ({ apiKey: "sk-ant-oat01-capture-not-a-real-token", reasoning: "high", sessionId: randomUUID(), env: { PI_CACHE_RETENTION: "" } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

for (const fixture of fixtures.cases) {
  test(`inference request preserves headers and body fields: ${fixture.name}`, async (t) => {
    const selected = { ...model, id: fixture.requests[0].body.model,
      baseUrl: fixture.firstParty ? model.baseUrl : "http://127.0.0.1:34567" };
    const opts = { ...options(),
      apiKey: fixture.apiKey ? "sk-ant-api03-capture-not-a-real-key" : options().apiKey,
      reasoning: fixture.thinking ? "high" : undefined,
      cacheRetention: fixture.cacheRetention,
    };
    const transcript = normalizeContext({ systemPrompt: "Test prompt.",
      tools: fixture.requests[0].body.tools.length ? [readTool] : [],
      messages: [{ role: "user", content: "hello", timestamp: 0 }] });
    const captured = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const parsed = new URL(url);
      const request = { url: parsed.pathname + parsed.search, method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
      captured.push(request);
      const user = JSON.parse(request.body.metadata.user_id);
      assert.equal(user.session_id, request.headers["x-claude-code-session-id"]);
      assert.match(user.device_id, /^[0-9a-f]{64}$/);
      if (fixture.firstParty) {
        assert.match(request.headers["x-client-request-id"], uuid);
        assert.match(request.headers["x-claude-code-prompt-id"], uuid);
        assert.ok(request.body.system[0].text.includes(`cc_prompt_id=${request.headers["x-claude-code-prompt-id"]};`));
        assert.match(request.body.system[0].text, /cc_entrypoint=sdk-cli; cch=00000;/);
      }
      const tool = fixture.requests.length > 1 && captured.length === 1;
      const events = [
        { type: "message_start", message: { id: "msg_capture", model: selected.id, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: tool
          ? { type: "tool_use", id: "toolu_capture", name: "Read", input: {} } : { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: tool
          ? { type: "input_json_delta", partial_json: '{"path":"sample.txt"}' } : { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream", "request-id": "req_capture" },
      });
    });
    for (let i = 0; i < fixture.requests.length; i++) {
      const result = await streamAnthropicOAuth(selected, transcript, {
        ...opts, ...(i && fixture.firstParty && { headers: { "x-claude-code-prev-tool-durations": "Read=8" } }),
      }, fixture.fastMode).result();
      assert.notEqual(result.stopReason, "error", result.errorMessage);
      assert.equal(result.responseId, "msg_capture");
      // Pi keeps its initial instructions at the top and has no synthetic CLI
      // environment/budget turns. Cache the existing user/tool-result block instead.
      const expected = structuredClone(fixture.requests[i]);
      const nativeTail = expected.body.messages.at(-1);
      const cacheControl = nativeTail.role === "system" ? nativeTail.content.at(-1)?.cache_control : undefined;
      expected.body.messages = expected.body.messages.filter((message) => message.role !== "system");
      for (const message of expected.body.messages) {
        if (message.role === "user" && typeof message.content === "string") message.content = [{ type: "text", text: message.content }];
      }
      if (cacheControl) expected.body.messages.at(-1).content.at(-1).cache_control = cacheControl;
      // Keep the capture unchanged; Pi deliberately requests visible summaries.
      if (expected.body.thinking?.display === "omitted") expected.body.thinking.display = "summarized";
      assert.deepEqual(normalizeRequest(captured[i]), expected);
      if (i === 0 && fixture.requests.length > 1) {
        transcript.messages.push(result, { role: "toolResult", toolCallId: "toolu_capture", toolName: "read",
          content: [{ type: "text", text: "sample audit file" }], isError: false, timestamp: 1 });
      }
    }
    if (captured.length > 1 && fixture.firstParty) {
      assert.equal(captured[0].headers["x-claude-code-prompt-id"], captured[1].headers["x-claude-code-prompt-id"]);
      assert.notEqual(captured[0].headers["x-client-request-id"], captured[1].headers["x-client-request-id"]);
      assert.match(captured[1].body.system[0].text, /cc_prev_req=req_capture;/);
    }
    cleanupSessionResources(opts.sessionId);
  });
}

test("billing suffix uses sampled characters from the first text block", () => {
  const version = getClaudeCodeVersion();
  assert.ok(buildClaudeCodeBillingBlock("hello").text.includes(`cc_version=${version}.09d;`));
  assert.ok(buildClaudeCodeBillingBlock("goodbye").text.includes(`cc_version=${version}.de7;`));
  const transcript = context();
  transcript.messages.at(-1).content = [{ type: "text", text: "hello" }, { type: "text", text: "not part of the hash" }];
  const { params } = buildClaudeCodeRequest(model, transcript, options());
  assert.ok(params.system[0].text.includes(`cc_version=${version}.09d;`));
});

test("session and prompt IDs survive tool iterations but rotate on a new user turn", () => {
  const transcript = context(), opts = options();
  const first = buildClaudeCodeRequest(model, transcript, opts);
  const second = buildClaudeCodeRequest(model, transcript, opts);
  assert.equal(first.headers["x-claude-code-session-id"], opts.sessionId);
  assert.equal(first.headers["x-claude-code-prompt-id"], second.headers["x-claude-code-prompt-id"]);
  assert.notEqual(first.headers["x-client-request-id"], second.headers["x-client-request-id"]);
  transcript.messages.push({ role: "user", content: "hello", timestamp: 2 });
  const next = buildClaudeCodeRequest(model, transcript, opts);
  assert.notEqual(first.headers["x-claude-code-prompt-id"], next.headers["x-claude-code-prompt-id"]);
  assert.match(next.params.system[0].text, /cc_prompt_index=1; cc_turn_index=2;/);
  cleanupSessionResources(opts.sessionId);
  assert.notEqual(next.headers["x-claude-code-prompt-id"], buildClaudeCodeRequest(model, transcript, opts).headers["x-claude-code-prompt-id"]);
});

test("normal requests also merge betas and protect auth and client identity", () => {
  const { headers } = buildClaudeCodeRequest(model, context(), { ...options(), headers: {
    "Anthropic-Beta": "custom-beta, oauth-2025-04-20", Authorization: "wrong", "X-API-KEY": "wrong",
    "User-Agent": "wrong", "X-App": "wrong", "X-Claude-Code-Session-Id": "wrong", "X-Test": "kept",
  } });
  assert.equal(headers["anthropic-beta"].split(",").filter((beta) => beta === "oauth-2025-04-20").length, 1);
  assert.ok(headers["anthropic-beta"].includes("custom-beta"));
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(headers["x-test"], "kept");
  assert.equal(headers["user-agent"], makeClaudeCodeUserAgent());
  assert.equal(headers["x-app"], "cli");
  assert.notEqual(headers["x-claude-code-session-id"], "wrong");
});

test("Pi tool schemas retain constraints rather than copying Claude Code's parameters", () => {
  const parameters = { ...readTool.parameters, $schema: "https://json-schema.org/draft/2020-12/schema", $defs: { path: { type: "string" } }, oneOf: [{ required: ["path"] }] };
  const [tool] = convertPiToolsToAnthropic([{ ...readTool, parameters }], true);
  assert.equal(tool.name, "Read");
  assert.equal(tool.description, "Pi Read");
  assert.deepEqual(tool.input_schema, parameters);
  assert.equal(tool.cache_control, undefined);
});

test("cache, thinking budget, model limit, and effort overrides remain explicit", () => {
  const legacy = { ...model, id: "claude-sonnet-4-5" };
  const request = buildClaudeCodeRequest(legacy, context(), { ...options(), maxTokens: 2048, thinkingBudgets: { high: 4000 }, cacheRetention: "short" });
  assert.equal(request.params.max_tokens, 2048);
  assert.deepEqual(request.params.thinking, { type: "enabled", budget_tokens: 2047, display: "summarized" });
  assert.deepEqual(request.params.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
  const off = buildClaudeCodeRequest(legacy, context(), { ...options(), reasoning: undefined });
  assert.deepEqual(off.params.thinking, { type: "disabled" });
  assert.equal(off.params.context_management, undefined);
  const mapped = buildClaudeCodeRequest({ ...model, thinkingLevelMap: { high: "xhigh" } }, context(), options());
  assert.deepEqual(mapped.params.output_config, { effort: "xhigh" });
});

test("OAuth metadata survives refresh without borrowing another account's identity", async (t) => {
  const credentials = { access: "old-access", refresh: "refresh", expires: 0, deviceId: "a".repeat(64), accountUuid: "account-a" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "new-access", expires_in: 3600 }));
  const refreshed = await refreshAnthropicToken(credentials);
  assert.equal(refreshed.deviceId, credentials.deviceId);
  assert.equal(refreshed.accountUuid, credentials.accountUuid);
  assert.equal(getAnthropicApiKey(refreshed), "new-access");
  assert.deepEqual(JSON.parse(getAnthropicUserId("new-access", "session-a")), { device_id: credentials.deviceId, account_uuid: "account-a", session_id: "session-a" });
  assert.equal(JSON.parse(getAnthropicUserId("unrelated-api-key", "session-b")).account_uuid, "");
  t.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "another-access", expires_in: 3600, account: { uuid: "account-b" } }));
  assert.equal((await refreshAnthropicToken(credentials)).accountUuid, "account-b");
});

for (const thinking of ["", "Checking the request settings."]) {
  test(thinking ? "thinking summaries reach Pi events and replay with their signature" : "omitted thinking still preserves the signature for the next request", async (t) => {
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(JSON.parse(init.body).thinking.display, "summarized");
      const events = [
        { type: "message_start", message: { id: "msg_signed", usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        ...(thinking ? [{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } }] : []),
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const transcript = context(), opts = options();
    const stream = streamAnthropicOAuth(model, transcript, opts);
    const visible = [];
    for await (const event of stream) {
      if (event.type.startsWith("thinking_")) visible.push({ type: event.type, delta: event.delta });
    }
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(visible, [
      { type: "thinking_start", delta: undefined },
      ...(thinking ? [{ type: "thinking_delta", delta: thinking }] : []),
      { type: "thinking_end", delta: undefined },
    ]);
    assert.equal(result.content[0].thinking, thinking);
    assert.equal(result.content[0].thinkingSignature, "opaque-signature");
    transcript.messages.push(result, { role: "user", content: "continue", timestamp: 1 });
    const { params } = buildClaudeCodeRequest(model, transcript, opts);
    assert.deepEqual(params.messages.find((message) => message.role === "assistant").content[0], {
      type: "thinking", thinking, signature: "opaque-signature",
    });
    assert.equal(params.diagnostics.previous_message_id, "msg_signed");
    cleanupSessionResources(opts.sessionId);
  });
}
