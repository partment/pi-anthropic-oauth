import Anthropic from "@anthropic-ai/sdk";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentTools,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { isClaudeOAuthAccessToken } from "./auth.js";
import { fromClaudeCodeToolName, type IndexedBlock } from "./convert.js";
import { buildClaudeCodeRequest } from "./request.js";
export { supportsFastMode, usesAdaptiveThinking } from "./request.js";

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "error";
  }
}

type MessageDeltaUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number | null };
};

export function applyMessageDelta(
  output: AssistantMessage,
  model: Model<Api>,
  stopReason: string | null | undefined,
  usage: MessageDeltaUsage | undefined,
  stopDetails?: { explanation?: string | null } | null,
): void {
  if (stopReason != null) {
    output.stopReason = mapStopReason(stopReason);
    if (output.stopReason === "error") {
      // Keep the provider's reason (e.g. "refusal") and explanation instead of a generic message.
      output.errorMessage = `Provider stop reason: ${stopReason}${
        stopDetails?.explanation ? ` — ${stopDetails.explanation}` : ""
      }`;
    }
  }

  if (usage) {
    if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
    if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
    if (usage.cache_read_input_tokens != null) {
      output.usage.cacheRead = usage.cache_read_input_tokens;
    }
    if (usage.cache_creation_input_tokens != null) {
      output.usage.cacheWrite = usage.cache_creation_input_tokens;
    }
    const thinkingTokens = usage.output_tokens_details?.thinking_tokens;
    if (thinkingTokens != null) output.usage.reasoning = thinkingTokens;
  }

  output.usage.totalTokens =
    output.usage.input +
    output.usage.output +
    output.usage.cacheRead +
    output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

export function streamAnthropicOAuth(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
  fastModeEnabled = false,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const tools = getCurrentTools(context.messages);

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error(
          "No Anthropic auth available. Run /login and choose Claude Pro/Max.",
        );
      }

      const isOAuth = isClaudeOAuthAccessToken(apiKey);
      const { params, headers, session } = buildClaudeCodeRequest(model, context, options ?? {}, fastModeEnabled);
      const client = new Anthropic({
        baseURL: model.baseUrl,
        apiKey: isOAuth ? null : apiKey,
        authToken: isOAuth ? apiKey : null,
        defaultHeaders: headers,
        dangerouslyAllowBrowser: true,
        ...(options?.timeoutMs !== undefined && { timeout: options.timeoutMs }),
      });

      // Raw stream instead of the MessageStream helper: MessageStream
      // accumulates tool_use input and JSON.parses it on content_block_stop,
      // which throws under fine-grained-tool-streaming (input may be invalid
      // mid-flight) and aborts the turn. The raw stream yields the same
      // RawMessageStreamEvents; tool args are already parsed leniently below.
      const { data: anthropicStream, response: httpResponse } =
        await client.beta.messages
          .create(params, {
            signal: options?.signal,
            // Let Pi handle retries; SDK quota waits are silent and unabortable.
            maxRetries: 0,
          })
          .withResponse();
      session.previousRequestId = httpResponse.headers.get("request-id") ?? undefined;

      if (options?.onResponse) {
        try {
          await options.onResponse(
            {
              status: httpResponse.status,
              headers: headersToRecord(httpResponse.headers),
            },
            model,
          );
        } catch {
          // Response hooks are best-effort and should not break streaming.
        }
      }

      stream.push({ type: "start", partial: output });

      const blocks = output.content as IndexedBlock[];

      let lastEvent = "";
      try {
        for await (const event of anthropicStream) {
          lastEvent = event.type;

          if (event.type === "message_start") {
            output.responseId = event.message.id;
            output.usage.input = event.message.usage.input_tokens || 0;
            output.usage.output = event.message.usage.output_tokens || 0;
            output.usage.cacheRead =
              (event.message.usage as { cache_read_input_tokens?: number })
                .cache_read_input_tokens || 0;
            output.usage.cacheWrite =
              (event.message.usage as { cache_creation_input_tokens?: number })
                .cache_creation_input_tokens || 0;
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
            continue;
          }

          if (event.type === "content_block_start") {
            if (event.content_block.type === "text") {
              output.content.push({
                type: "text",
                text: "",
                index: event.index,
              } as IndexedBlock);
              stream.push({
                type: "text_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            } else if (event.content_block.type === "thinking") {
              output.content.push({
                type: "thinking",
                thinking: "",
                thinkingSignature: "",
                index: event.index,
              } as IndexedBlock);
              stream.push({
                type: "thinking_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            } else if (event.content_block.type === "redacted_thinking") {
              output.content.push({
                type: "thinking",
                thinking: "[Reasoning redacted]",
                thinkingSignature: event.content_block.data,
                redacted: true,
                index: event.index,
              } as IndexedBlock);
              stream.push({
                type: "thinking_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            } else if (event.content_block.type === "tool_use") {
              output.content.push({
                type: "toolCall",
                id: event.content_block.id,
                name: isOAuth
                  ? fromClaudeCodeToolName(
                      event.content_block.name,
                      tools,
                    )
                  : event.content_block.name,
                arguments: {},
                partialJson: "",
                index: event.index,
              } as IndexedBlock);
              stream.push({
                type: "toolcall_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }
            continue;
          }

          if (event.type === "content_block_delta") {
            const contentIndex = blocks.findIndex(
              (block) => block.index === event.index,
            );
            const block = blocks[contentIndex];
            if (!block) continue;

            if (event.delta.type === "text_delta" && block.type === "text") {
              block.text += event.delta.text;
              stream.push({
                type: "text_delta",
                contentIndex,
                delta: event.delta.text,
                partial: output,
              });
            } else if (
              event.delta.type === "thinking_delta" &&
              block.type === "thinking"
            ) {
              block.thinking += event.delta.thinking;
              stream.push({
                type: "thinking_delta",
                contentIndex,
                delta: event.delta.thinking,
                partial: output,
              });
            } else if (
              event.delta.type === "signature_delta" &&
              block.type === "thinking"
            ) {
              block.thinkingSignature =
                (block.thinkingSignature || "") + event.delta.signature;
            } else if (
              event.delta.type === "input_json_delta" &&
              block.type === "toolCall"
            ) {
              block.partialJson += event.delta.partial_json;
              try {
                block.arguments = JSON.parse(block.partialJson) as JsonObject;
              } catch {}
              stream.push({
                type: "toolcall_delta",
                contentIndex,
                delta: event.delta.partial_json,
                partial: output,
              });
            }
            continue;
          }

          if (event.type === "content_block_stop") {
            const contentIndex = blocks.findIndex(
              (block) => block.index === event.index,
            );
            const block = blocks[contentIndex];
            if (!block) continue;

            delete (block as { index?: number }).index;
            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex,
                content: block.thinking,
                partial: output,
              });
            } else if (block.type === "toolCall") {
              try {
                block.arguments = JSON.parse(block.partialJson) as JsonObject;
              } catch {}
              delete (block as { partialJson?: string }).partialJson;
              stream.push({
                type: "toolcall_end",
                contentIndex,
                toolCall: block,
                partial: output,
              });
            }
            continue;
          }

          if (event.type === "message_delta") {
            applyMessageDelta(
              output,
              model,
              event.delta.stop_reason,
              event.usage as MessageDeltaUsage | undefined,
              (event.delta as { stop_details?: { explanation?: string | null } | null })
                .stop_details,
            );
          }
        }
      } catch (error) {
        // Bun can throw while closing the body after message_stop (#37).
        if (lastEvent !== "message_stop") throw error;
      }

      if (options?.signal?.aborted) throw new Error("Request aborted");
      if (output.stopReason === "error") {
        output.errorMessage ??= "Unrecognized stop reason from the API.";
        stream.push({ type: "error", reason: "error", error: output });
      } else {
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
      }
      stream.end();
    } catch (error) {
      for (const block of output.content as Array<{
        index?: number;
        partialJson?: string;
      }>) {
        delete block.index;
        delete block.partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
