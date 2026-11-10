# pi-anthropic-oauth

[![npm](https://img.shields.io/npm/v/pi-anthropic-oauth?style=flat-square&logo=npm&logoColor=white&label=npm&color=7c3aed)](https://www.npmjs.com/package/pi-anthropic-oauth)

**Use your Claude Pro/Max subscription in Pi, no API key or Claude Code installation required.**

Keeps Pi's built-in models and tools.

> [!IMPORTANT]
> Requires Pi 0.86.0+

## Features

- Claude Pro/Max login from `/login`
- Automatic token refresh
- Uses your plan's included usage
- No Anthropic API key needed
- No Claude Code installation required
- Uses the Anthropic models available in Pi's built-in model registry

## Quick start

```bash
pi install npm:pi-anthropic-oauth
```

Start Pi, then run Pi's login command:

```text
/login
```

Choose:

```text
Claude Pro/Max
```

Complete the browser login. After login, select an Anthropic model in Pi.

When the extension is active, `/login` includes `Claude Pro/Max` and Anthropic models show `(sub)` after OAuth login.

View plan usage and limits:

```text
/usage
```

Update with:

```bash
pi update npm:pi-anthropic-oauth
```

## How it works

- **Login:** `/login` → `Claude Pro/Max`; tokens refresh automatically.
- **Requests:** Direct to Anthropic—no proxy or API key.
- **Compatibility:** Adapts headers, system prompts, and tool names for Claude Code.
- **Integration:** Streams native Pi events; tools run in Pi.

Creates `~/.Claude Code` → `~/.pi` if missing.

## Request handling

Requests include client and session metadata. Model capabilities determine beta headers, thinking settings, output limits, and cache placement. Tool-result follow-ups retain the prompt ID and link to the preceding response.

When thinking is enabled, requests use `display: "summarized"` so Pi can show the returned thinking summary. The API still determines whether a response contains one.

System updates are folded into the current top-level prompt before each request. The conversation sent to Anthropic contains no inline system messages. The cache marker goes on the last user or tool-result block. If system instructions change, the cached prefix may need to be rebuilt.

Pi supplies the system instructions, permissions, and tools. Tool names keep their existing mapping; descriptions, JSON Schemas, inputs, and results stay Pi-native. The billing system block retains `cch=00000` as a placeholder; the checksum is not computed.

See [request fixtures and local capture](test/fixtures/README.md) for the tested behaviors, normalization rules, and capture command. Tests use local responses and dummy credentials rather than real inference.

## Fast Mode

Run `/fast` to toggle Fast Mode, or use `/fast on` / `/fast off`. It defaults to off and is kept in memory only; restarting Pi or running `/reload` resets it.

Fast Mode only applies to the `anthropic` provider with these [officially supported models](https://platform.claude.com/docs/en/build-with-claude/fast-mode#supported-models):

- `claude-opus-5-5`
- `claude-opus-5`
- `claude-opus-4-8`

Switching to another model leaves it at standard speed. Switching back to a supported model reuses the toggle. The footer shows `Fast Mode` when it applies to the selected model. The command does not switch models.

Both regular and Fast Mode requests use `/v1/messages?beta=true`.

Enabled requests include `speed: "fast"` and the `fast-mode-2026-02-01` beta header, alongside the existing OAuth headers. Disabled or unsupported requests omit both Fast Mode additions. Thinking settings are unchanged.

> [!WARNING]
> Fast Mode uses premium pricing. Pro/Max subscriptions require usage credits; Fast Mode is not covered by included subscription usage. Pi's cost estimate still uses the model's standard rates. The API decides account access and capacity; this extension does not add Claude Code's availability checks or automatic fallback to standard speed. See [Claude Code Fast Mode](https://code.claude.com/docs/en/fast-mode).

## Claude Code version override

Anthropic gates new models on the Claude Code client version (error `claude_code_version_too_old`). The version is sent in both the OAuth user agent and the billing header of the system prompt. Override it without reinstalling:

```bash
PI_ANTHROPIC_OAUTH_CLAUDE_CODE_VERSION="<client-version>"
```

## Prompt cache retention

OAuth requests default to the 1-hour cache. API-key requests default to the 5-minute cache. An explicit Pi `cacheRetention` option takes priority, followed by `PI_CACHE_RETENTION`: `long` selects 1 hour, `short` selects 5 minutes, and `none` disables caching. For example:

```bash
PI_CACHE_RETENTION=long
```

## System prompt rewriting

For both OAuth and API-key inference, the extension prepends the Claude Code billing-header and identity system blocks and rewrites standalone `Pi` / `pi` references in Pi's system prompt to `Claude Code`. The rewrite mode defaults to `aggressive`:

```bash
PI_ANTHROPIC_OAUTH_REWRITE_MODE=aggressive
```

Other modes are opt-in and avoid rewriting some technical strings such as paths, package names, or repository names. If OAuth starts failing, switch back to `aggressive`.

Available modes:

| Mode             | Behavior                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `aggressive`     | Default. Replaces standalone `Pi` / `pi` wherever the word-boundary pattern matches.                        |
| `path-safe`      | Avoids replacing `Pi` / `pi` immediately after `/` or `\`, preserving path segments like `/srv/dev/pi-foo`. |
| `technical-safe` | Avoids replacing `Pi` / `pi` next to common technical-token separators: `/`, `\`, `.`, `@`, `:`, `_`, `-`.  |
| `custom`         | Uses `PI_ANTHROPIC_OAUTH_REWRITE_PATTERN` as the replacement regex.                                         |

Custom patterns can be a regex source or a JavaScript-style regex literal. The `g` flag is added automatically when omitted:

```bash
PI_ANTHROPIC_OAUTH_REWRITE_MODE=custom
PI_ANTHROPIC_OAUTH_REWRITE_PATTERN='(?<![/\\])\b[Pp]i\b'
# or
PI_ANTHROPIC_OAUTH_REWRITE_PATTERN='/\bpi\b/gi'
```

There is no separate off mode. If you need to disable rewriting entirely, use a custom pattern that never matches, such as `(?!)`. Disabling or weakening the rewrite may affect OAuth compatibility.

## Extra models

To add another Anthropic model, create `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "unused",
      "api": "anthropic-messages",
      "models": [
        {
          "id": "your-model-id",
          "name": "Your Model Name"
        }
      ]
    }
  }
}
```

> [!NOTE]
> Available models follow Pi's built-in Anthropic catalog. Update Pi to get the latest models.
>
> Pi requires `baseUrl`, `apiKey`, and `api` when defining custom models in `models.json`. With this extension, requests normally authenticate through Claude Pro/Max OAuth after `/login`, so `apiKey` is only a placeholder to satisfy Pi's config requirements and does not need to be a valid Anthropic API key.
>
> Do not use a fake `sk-ant-oat...` value as the placeholder. If OAuth login has not completed, Pi may try to use that fake token and Anthropic will return `401 Invalid bearer token`. Use a harmless placeholder such as `"unused"`, then run `/login` and choose `Claude Pro/Max`.

## Troubleshooting

- If you see `400 invalid_request_error` with "Third-party apps now draw from your extra usage, not your plan limits.", update this extension (`pi update npm:pi-anthropic-oauth`), then run `/login` with no arguments and choose `Claude Pro/Max`.
- Pi's built-in extra-usage warning may still appear. Check `/usage` to confirm billing; disable the warning in `/settings` if desired.
- If local callback login does not complete, paste the final callback URL or `code#state` when prompted
- If you see `401 Invalid bearer token`, remove any fake `sk-ant-oat...` placeholder from `~/.pi/agent/models.json` and log in again
- If something breaks, please open an issue with your Pi version, extension version, and error output

## License

MIT
