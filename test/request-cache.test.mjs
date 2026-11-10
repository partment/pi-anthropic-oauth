import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cleanupSessionResources, collapseSystemMessages, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { buildClaudeCodeRequest } from "../.test-dist/request.js";
import { streamAnthropicOAuth } from "../.test-dist/stream.js";
import { normalizeRequest } from "./request-normalization.mjs";

const model = {
  id: "claude-opus-5-5", name: "Opus", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://api.anthropic.com", reasoning: true, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000,
};
const options = () => ({ apiKey: "sk-ant-oat01-cache-test", reasoning: "high", cacheRetention: "long", sessionId: randomUUID() });
const context = () => ({ messages: [
  { role: "system", content: "Stable base instructions.", sections: { rules: "<rules>Original rules.</rules>", cwd: "<cwd>project</cwd>" }, timestamp: 0 },
  { role: "user", content: "Read sample.txt", timestamp: 1 },
] });
const toolCall = (selected, id) => ({ role: "assistant", api: selected.api, provider: selected.provider, model: selected.id,
  content: [{ type: "toolCall", id, name: "read", arguments: { path: "sample.txt" } }], stopReason: "toolUse", timestamp: 2 });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "sample" }], isError: false, timestamp: 3 });
const withoutCache = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item));

function assertPrefix(previous, current) {
  assert.deepEqual(withoutCache(current.messages.slice(0, previous.messages.length)), withoutCache(previous.messages));
  assert.deepEqual(current.tools, previous.tools);
  // Billing attribution changes per request; the instruction blocks stay fixed.
  assert.deepEqual(current.system.slice(1), previous.system.slice(1));
}

for (const id of ["claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"]) {
  for (const cacheRetention of ["none", "short", "long"]) {
    test(`tool follow-ups keep a stable message prefix: ${id}, ${cacheRetention}`, (t) => {
      const selected = { ...model, id }, transcript = context(), opts = { ...options(), cacheRetention };
      t.after(() => cleanupSessionResources(opts.sessionId));
      let previous = buildClaudeCodeRequest(selected, transcript, opts).params;
      assert.deepEqual(previous.messages.map((message) => message.role), ["user"]);
      const instructionBlock = previous.system.at(-1).text;
      assert.match(instructionBlock, /Stable base instructions\.[\s\S]*Original rules/);
      for (let turn = 0; turn < 12; turn++) {
        transcript.messages.push(toolCall(selected, `tool_${turn}`), toolResult(`tool_${turn}`));
        const before = structuredClone(transcript);
        const current = buildClaudeCodeRequest(selected, transcript, opts).params;
        assertPrefix(previous, current);
        assert.deepEqual(transcript, before);
        assert.ok(current.messages.every((message) => message.role !== "system"));
        assert.equal(current.system.at(-1).text, instructionBlock);
        assert.equal(current.messages.length, 1 + (turn + 1) * 2);
        const markers = current.messages.flatMap((message) => message.content.filter((block) => block.cache_control));
        assert.equal(markers.length, cacheRetention === "none" ? 0 : 1);
        if (cacheRetention !== "none") assert.deepEqual(current.messages.at(-1).content.at(-1).cache_control, {
          type: "ephemeral", ...(cacheRetention === "long" && { ttl: "1h" }),
        });
        previous = current;
      }
      transcript.messages.push({ role: "user", content: "Continue", timestamp: 4 });
      assertPrefix(previous, buildClaudeCodeRequest(selected, transcript, opts).params);
      const messages = buildClaudeCodeRequest(selected, transcript, opts).params.messages;
      cleanupSessionResources(opts.sessionId);
      assert.deepEqual(buildClaudeCodeRequest(selected, structuredClone(transcript), opts).params.messages, messages);
    });
  }
}

for (const id of ["claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-5"]) {
  test(`system updates use the current top-level prompt: ${id}`, (t) => {
    const selected = { ...model, id }, transcript = context(), opts = options();
    t.after(() => cleanupSessionResources(opts.sessionId));
    const first = buildClaudeCodeRequest(selected, transcript, opts).params;
    transcript.messages.push(toolCall(selected, "one"), toolResult("one"), {
      role: "system", content: "Use concise answers.",
      sections: { rules: "<rules>Updated AGENTS.md rules.</rules>", cwd: null }, timestamp: 4,
    });
    const before = structuredClone(transcript);
    const changed = buildClaudeCodeRequest(selected, transcript, opts).params;
    assert.deepEqual(transcript, before);
    assert.deepEqual(changed.messages.map((message) => message.role), ["user", "assistant", "user"]);
    assert.equal(changed.system.at(-1).text, getCurrentSystemPrompt(collapseSystemMessages(transcript).messages));
    assert.match(changed.system.at(-1).text, /Stable base instructions\.[\s\S]*Use concise answers\.[\s\S]*Updated AGENTS\.md rules/);
    assert.doesNotMatch(changed.system.at(-1).text, /Original rules|<cwd>/);
    assert.notEqual(changed.system.at(-1).text, first.system.at(-1).text);

    transcript.messages.push({ role: "system", content: "", sections: { rules: null }, timestamp: 5 });
    const removed = buildClaudeCodeRequest(selected, transcript, opts).params;
    assert.ok(removed.messages.every((message) => message.role !== "system"));
    assert.doesNotMatch(removed.system.at(-1).text, /Original rules|Updated AGENTS\.md rules|<cwd>/);
    assert.match(removed.system.at(-1).text, /Use concise answers/);
  });
}

test("system updates do not separate parallel tool results", (t) => {
  const transcript = context(), opts = options();
  t.after(() => cleanupSessionResources(opts.sessionId));
  const assistant = toolCall(model, "one");
  assistant.content.push({ ...assistant.content[0], id: "two" }, { ...assistant.content[0], id: "missing" });
  transcript.messages.push(assistant,
    { role: "system", content: "First update.", timestamp: 3 }, toolResult("one"),
    { role: "system", content: "Second update.", timestamp: 4 }, toolResult("two"));
  const request = buildClaudeCodeRequest(model, transcript, opts).params;
  assert.deepEqual(request.messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(request.messages[2].content.map((block) => [block.tool_use_id, block.is_error]),
    [["one", undefined], ["two", undefined], ["missing", true]]);
  assert.match(request.system.at(-1).text, /First update\.[\s\S]*Second update\./);
  assert.deepEqual(request.messages[2].content.at(-1).cache_control, { type: "ephemeral", ttl: "1h" });
});

test("system updates still resolve the current Pi tools", (t) => {
  const transcript = context(), opts = options();
  t.after(() => cleanupSessionResources(opts.sessionId));
  const read = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
  const bash = { name: "bash", description: "Run", parameters: { type: "object", properties: {} } };
  transcript.messages[0].toolsAdded = [read];
  transcript.messages.push({ role: "system", content: "", toolsRemoved: [{ name: "read" }], toolsAdded: [bash], timestamp: 2 });
  const request = buildClaudeCodeRequest(model, transcript, opts).params;
  assert.deepEqual(request.tools.map((tool) => tool.name), ["Bash"]);
  assert.ok(request.messages.every((message) => message.role !== "system"));
});

test("compaction or branch changes do not resurrect discarded system updates", (t) => {
  const transcript = context(), opts = options();
  t.after(() => cleanupSessionResources(opts.sessionId));
  transcript.messages.push({ role: "system", content: "Old branch instruction.", timestamp: 2 });
  assert.match(buildClaudeCodeRequest(model, transcript, opts).params.system.at(-1).text, /Old branch instruction/);
  const compacted = context();
  compacted.messages[0].sections.rules = "<rules>Compacted current rules.</rules>";
  const next = buildClaudeCodeRequest(model, compacted, opts).params;
  assert.ok(next.messages.every((message) => message.role !== "system"));
  assert.doesNotMatch(JSON.stringify(next), /Old branch/);
  assert.match(next.system.at(-1).text, /Compacted current rules/);
});

test("request normalization preserves system ordering and cache boundaries", () => {
  const request = { url: "/v1/messages", method: "POST", headers: {}, body: {
    metadata: { user_id: "{}" }, system: [], tools: [], messages: [
      { role: "user", content: "hello" },
      { role: "system", content: [{ type: "text", text: "instruction", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
  } };
  const before = normalizeRequest(request);
  assert.deepEqual(before.body.messages.map((message) => message.role), ["user", "system", "assistant"]);
  assert.deepEqual(before.body.messages[1].content[0].cache_control, { type: "ephemeral" });
  request.body.messages.push(request.body.messages.splice(1, 1)[0]);
  assert.notDeepEqual(normalizeRequest(request), before);
});

test("SDK sends long histories without inline system messages", async (t) => {
  const transcript = context(), opts = options();
  t.after(() => cleanupSessionResources(opts.sessionId));
  const answer = () => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 2 });
  for (let turn = 0; turn < 99; turn++) {
    transcript.messages.push(answer(), { role: "user", content: `Continue ${turn}`, timestamp: turn + 3 });
  }
  transcript.messages.push(
    { role: "system", content: "First update.", sections: { rules: "Old AGENTS.md" }, timestamp: 200 },
    { role: "system", content: "Second update.", sections: { rules: "New AGENTS.md" }, timestamp: 201 },
    answer(), { role: "user", content: "Continue", timestamp: 202 },
    { role: "system", content: "Third update.", timestamp: 203 },
  );
  let sent;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent = JSON.parse(init.body);
    const events = [
      { type: "message_start", message: { id: "msg_long", usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const result = await streamAnthropicOAuth(model, transcript, opts).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.ok(sent.messages.length > 199);
  assert.ok(sent.messages.every((message) => message.role === "user" || message.role === "assistant"));
  assert.match(sent.system.at(-1).text, /First update\.[\s\S]*Second update\.[\s\S]*Third update\.[\s\S]*New AGENTS\.md/);
  assert.doesNotMatch(sent.system.at(-1).text, /Old AGENTS\.md/);
});
