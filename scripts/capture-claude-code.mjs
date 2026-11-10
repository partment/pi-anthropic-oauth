// Developer-only capture. The proxy replies locally; it never forwards traffic.
// Usage: node scripts/capture-claude-code.mjs <binary> <model> <name> [flags]
// Flags: --custom-base-url --api-key --fast --no-thinking --no-cache --tool
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeRequest } from "../test/request-normalization.mjs";

const [binaryPath, model = "claude-opus-5", name = model, ...flags] = process.argv.slice(2);
if (!binaryPath) throw new Error("Pass the Claude Code binary path.");
const binary = resolve(binaryPath);
const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
if (version.status !== 0 || !version.stdout.includes("(Claude Code)")) {
  throw new Error("Could not identify the Claude Code executable.");
}
const firstParty = !flags.includes("--custom-base-url");
const apiKey = flags.includes("--api-key");
const fastMode = flags.includes("--fast");
const thinking = !flags.includes("--no-thinking");
const cacheRetention = flags.includes("--no-cache") ? "none" : undefined;
const tool = flags.includes("--tool");
const root = resolve("node_modules/.cache/claude-code");
const config = resolve(root, `audit-config-${name}`);
await mkdir(config, { recursive: true });
await writeFile(resolve(config, "sample.txt"), "sample audit file\n");

const captured = [];
const handler = async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  captured.push({ url: req.url, method: req.method, headers: req.headers, body });
  if (!req.url.startsWith("/v1/messages")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  const callTool = tool && captured.filter((r) => r.url.startsWith("/v1/messages")).length === 1;
  const events = [
    { type: "message_start", message: { id: "msg_capture", type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: callTool
      ? { type: "tool_use", id: "toolu_capture", name: "Read", input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: callTool
      ? { type: "input_json_delta", partial_json: JSON.stringify({ file_path: resolve(config, "sample.txt") }) }
      : { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: callTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_capture" });
  res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
};
const server = createServer(handler);
const proxy = createServer();
const sockets = new Set();
let tls;
if (firstParty) {
  const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", resolve(config, "key.pem"), "-out", resolve(config, "cert.pem"),
    "-days", "1", "-subj", "/CN=api.anthropic.com"], { encoding: "utf8" });
  if (cert.status !== 0) throw new Error(`OpenSSL is required for first-party capture: ${cert.error ?? cert.stderr}`);
  tls = createTlsServer({ key: await readFile(resolve(config, "key.pem")), cert: await readFile(resolve(config, "cert.pem")) }, handler);
  proxy.on("connect", (_req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    tls.emit("connection", socket);
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
}
await new Promise((done) => server.listen(0, "127.0.0.1", done));

// Never inherit credentials, proxy exclusions, or the user's Claude settings.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|PATHEXT|LOCALAPPDATA|APPDATA|ProgramFiles|ProgramFiles\(x86\))$/i.test(key)));
Object.assign(env, {
  HOME: config, USERPROFILE: config, CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: firstParty ? "https://api.anthropic.com" : `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
  ...(apiKey ? { ANTHROPIC_API_KEY: "sk-ant-api03-capture-not-a-real-key" }
    : { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-capture-not-a-real-token" }),
  ...(firstParty && { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
  ...(!thinking && { MAX_THINKING_TOKENS: "0" }),
  ...(cacheRetention === "none" && { DISABLE_PROMPT_CACHING: "1" }),
});
const args = ["-p", "hello", "--model", model, "--system-prompt", "Test prompt.", "--tools", tool ? "Read" : "",
  "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--effort", "high", "--permission-mode", "manual"];
if (tool) args.push("--allowedTools", "Read");
if (fastMode) args.push("--settings", '{"fastMode":true}');
let stdout = "", stderr = "", code;
try {
  const child = spawn(binary, args, { env, cwd: config, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    code = await new Promise((done, reject) => {
      child.on("error", reject);
      child.on("exit", done);
    });
  } finally {
    clearTimeout(timer);
  }
} finally {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections(); server.close();
  proxy.close();
  tls?.closeAllConnections(); tls?.close();
}
await writeFile(resolve(root, `${name}.raw.json`), JSON.stringify({ code, stdout, stderr, captured }, null, 2));
const requests = captured.filter((r) => r.url.startsWith("/v1/messages")).map(normalizeRequest);
if (code !== 0 || requests.length !== (tool ? 2 : 1)) {
  throw new Error(`Capture failed (exit ${code}, ${requests.length} requests): ${stderr}`);
}
const output = resolve(root, `${name}.normalized.json`);
await writeFile(output, JSON.stringify({ name, firstParty, apiKey, fastMode, thinking,
  ...(cacheRetention && { cacheRetention }), requests }, null, 2) + "\n");
console.log(`${requests.length} local requests captured: ${output}`);
