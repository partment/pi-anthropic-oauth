// Only normalize allowed prompt/tool contents and values that vary per run.
// Message roles, ordering, and cache boundaries remain part of the comparison.
export function normalizeRequest(request) {
  const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["host", "connection", "content-length", "accept-encoding"]) delete headers[key];
  for (const key of ["x-stainless-os", "x-stainless-arch", "x-stainless-runtime", "x-stainless-runtime-version"]) {
    if (key in headers) headers[key] = "<runtime>";
  }
  for (const key of ["authorization", "x-api-key"]) {
    if (key in headers) headers[key] = "<credential>";
  }
  for (const key of ["x-claude-code-session-id", "x-claude-code-prompt-id", "x-client-request-id"]) {
    if (key in headers) headers[key] = "<uuid>";
  }
  if (headers["x-claude-code-prev-tool-durations"]) {
    headers["x-claude-code-prev-tool-durations"] = headers["x-claude-code-prev-tool-durations"].replace(/=\d+(?=;|$)/g, "=<ms>");
  }

  const body = JSON.parse(JSON.stringify(request.body));
  const user = JSON.parse(body.metadata.user_id);
  user.device_id = "<device-id>";
  user.session_id = "<uuid>";
  body.metadata.user_id = JSON.stringify(user);
  body.system = body.system.map((block) => ({ ...block, text: "<system-prompt>" }));
  // The deferred-tool sentinel is not a Pi tool; keep the real tool names.
  body.tools = body.tools.filter((tool) => tool.name !== "DeferredToolPlaceholder")
    .map(({ name, cache_control }) => ({ name, ...(cache_control && { cache_control }) }));
  body.messages = body.messages.map((message) => {
    if (message.role === "system") {
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      return { ...message, content: content.map((block) => block.type === "text" ? { ...block, text: "<system-prompt>" } : block) };
    }
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content
      .filter((block) => !(block.type === "text" && /^<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(block.text)))
      .map((block) => {
        if (block.type === "tool_use") return { ...block, input: "<Pi tool input>" };
        if (block.type === "tool_result") return { ...block, content: "<Pi tool result>" };
        return block;
      }) };
  });
  return { url: request.url, method: request.method, headers, body };
}
