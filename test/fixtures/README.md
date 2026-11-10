# Request fixtures

The fixtures contain captured HTTP requests. Tests send requests through the SDK and compare their headers and bodies after explicit normalization. Capture metadata records the source package and tarball checksum.

## Behaviors covered

- OAuth and API-key authentication.
- First-party and custom base URLs.
- Adaptive, budget-based, and disabled thinking.
- Model-specific output limits and effort settings.
- Standard speed and Fast Mode.
- Long, short, and disabled caching.
- Tool definitions, tool-result follow-ups, and response linkage.

The capture profile uses `--print hello --system-prompt "Test prompt." --effort high --permission-mode manual`. Settings and MCP configuration are isolated. Nonessential traffic, updates, telemetry, and the optional 1M-context flag are disabled.

Dummy credentials and local synthetic SSE responses keep the capture independent of a real account. First-party captures retain `https://api.anthropic.com` as the base URL through a local HTTPS CONNECT mock. The proxy never forwards traffic. Custom-base-URL cases exercise the omission of first-party headers, diagnostics, and billing fields.

## Normalization

`test/request-normalization.mjs` normalizes:

- Credentials, device/session/prompt/request IDs, and measured tool durations. Account UUID remains checked.
- OS, architecture, runtime, and runtime version. SDK version, timeout, retry count, user agent, and beta values remain checked.
- Transport fields: host, connection, content length, and compression negotiation.
- System text and system-reminder blocks. Inline system-message ordering, cache markers, and control fields are preserved.
- Tool descriptions, schemas, inputs, and results. Tool names, result IDs, error flags, and cache markers remain checked. The deferred-tool sentinel is excluded because Pi has no corresponding tool.

Enabled-thinking comparisons deliberately expect `thinking.display: "summarized"` so Pi can display thinking summaries. The fixed Pi test transcript has no CLI environment/budget updates, so its expected request omits those captured turns and places the cache marker on the existing user/tool-result block. Effort stays in the request-level `output_config`. These adjustments are explicit in `test/request.test.mjs`; the normalizer does not remove actual system turns.

`test/request-cache.test.mjs` checks stable message prefixes across repeated tool calls when the system prompt and tools stay unchanged. It also verifies that section updates and removals are folded into the top-level prompt, no inline system messages are sent even in long histories, and parallel tool results, session cleanup, and compaction remain intact. Fixtures are re-normalized from the original captures, not generated from the implementation.

Other headers and JSON fields remain in the comparison, including unknown fields. Fixture data retains captured protocol values; test names and assertions describe the behavior being checked.

First-party billing blocks retain the `cch=00000` placeholder. The checksum is not computed. The billing suffix, entrypoint, prompt ID, previous request ID, and turn indices are checked separately.

Pi retains its own permission model, prompt patch handling, tool lifecycle, and retry policy. Explicit token limits, thinking budgets, effort mappings, cache settings, custom headers, and client-version overrides take precedence over defaults. Old OAuth credentials gain a persistent device ID on their next successful refresh; an unavailable account UUID stays empty.

## Capture locally

Use Node, OpenSSL on `PATH`, and a Claude Code executable for your platform:

```sh
node scripts/capture-claude-code.mjs ./path/to/claude claude-opus-5 reproduction --tool
```

The script identifies the executable, isolates its environment and configuration, and writes raw and normalized JSON under `node_modules/.cache/claude-code`. TLS verification is disabled only in the dummy child for its local self-signed mock; production requests are unchanged. Raw files may contain local paths and should not be committed.

Flags: `--custom-base-url`, `--api-key`, `--fast`, `--no-thinking`, `--no-cache`, `--tool`. The synthetic Read call accesses only the ignored sample file. Review normalized captures before updating a fixture; do not generate expected requests from the extension.

Run `npm test` to check the request fixtures, identity consistency, session cleanup, OAuth refresh metadata, tool schemas, tool-duration headers, thinking-summary delivery, signature replay, and cache-prefix stability. Tests make no real inference calls.
