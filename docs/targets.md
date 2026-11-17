# Targets

Every target is an adapter under `src/targets/`. It returns text; `src/core/apply.mjs` writes it. This document covers what each adapter actually produces, which files can be merged safely, and what has to happen before the new config takes effect.

Shared behaviour, not repeated below:

- **Dry run.** Without `--write` nothing is written. Adapters still read existing files during a dry run, so the reported path and mode are the real ones.
- **Backups.** Replacing an existing file first copies it to `<file>.bak-<ISO timestamp>` (colons and dots replaced with `-`).
- **Atomic replace.** Content goes to `.<name>.tmp-<pid>` in the same directory, then `rename` onto the target.
- **No `--path` flag.** The CLI has no way to override a path; each adapter resolves its own location, and some honour an environment variable (noted per target).
- **Suggestion files.** When an existing file cannot be merged with certainty, the write lands at `<dir>/<name>.anyprovider.<ext>` — for example `~/.continue/config.anyprovider.yaml`. The original is untouched.
- **Protocol gating.** Each adapter declares the protocols it can emit. If the probe detected a protocol outside that list, the CLI and the wizard skip the target with a warning rather than writing a config the tool could never read.

## Summary

| id | File | Mode | Protocols | Needs restart |
|---|---|---|---|---|
| `zcode` | `<dataBaseDir>/.zcode/v2/provider_config.json` | merge | chat, responses, anthropic | yes — quit from tray |
| `opencode` | `~/.config/opencode/opencode.json[c]` | merge | chat, responses, anthropic | yes, plus an env var |
| `claude-code` | `~/.claude/settings.json` | merge | anthropic only | yes — new `claude` session |
| `cline` | VS Code user `settings.json` | merge | chat | reload the window |
| `continue` | `~/.continue/config.yaml` | create / suggest | chat | yes |
| `litellm` | `./litellm.config.yaml` | create / suggest | chat, responses, anthropic | restart the proxy |
| `aider` | `~/.aider.conf.yml` | create / suggest | chat | next invocation |
| `env` | `~/.anyprovider/providers.json` | merge | chat, responses, anthropic | n/a |

"Mode" is what the adapter asks for. `create` degrades to a suggestion file whenever the target already exists; `suggest` never touches the real file.

---

## zcode

**File:** `<dataBaseDir>/.zcode/v2/provider_config.json`

The location is indirect. ZCode reads `~/.zcode/v2/setting.json` for a `dataBaseDir` and then keeps its live config at `<dataBaseDir>/.zcode/v2/provider_config.json`. If that file is missing it falls back to `~/.zcode/v2/provider_config.json`. `ZCODE_CONFIG` overrides everything.

A stale copy often survives under `~/.zcode/v2/` after the data dir is moved. Editing that copy changes nothing in the app, so the adapter always prefers a path that exists under `dataBaseDir`.

**Written:** the provider is merged into `config.providerConfigRules.providerRules` (existing entry with the same `providerId` is replaced):

```json
{
  "providerId": "custom-api-example-com",
  "providerName": "api.example.com",
  "enabled": true,
  "config": {
    "group": "standard-personal",
    "visibility": "visible",
    "access": { "type": "api-key", "apiKey": "sk-..." },
    "api": { "type": "openai-chat-completions", "baseUrl": "https://api.example.com/v1" },
    "personalModelIds": ["model-a", "model-b"],
    "modelOrder": ["model-a", "model-b"]
  }
}
```

`api.type` is `openai-chat-completions`, `openai-responses` or `anthropic-messages`, depending on what the probe detected.

Per model, an entry is merged into `config.modelConfigRules.manualProviderModelRules` and the id is appended to `config.providerOrder`:

```json
{
  "modelId": "model-a",
  "providerId": "custom-api-example-com",
  "config": {
    "enabled": true,
    "properties": {
      "contextWindow": 262144,
      "supportsJsonSchemaOutput": true,
      "supportsNativeWebSearch": false,
      "supportsMidConversationSystem": false,
      "inputFormat": { "supportsImage": false, "supportsVideo": false, "supportsPdf": false }
    },
    "optionSpecs": {
      "maxOutputTokens": { "max": 65536 },
      "reasoningLevel": { "values": ["none", "low", "medium", "high"], "map": "{\"reasoning_effort\": reasoningLevel}" }
    }
  }
}
```

`reasoningLevel.map` is a JS expression evaluated with `reasoningLevel` and `maxOutputTokens` in scope. For a model with no reasoning knob the adapter writes ZCode's own "does nothing" form — `{ "values": ["enabled"], "map": "{}" }` — never an omitted key.

**Merge safety:** safe, with two guards. An existing file that is not valid JSON throws instead of being rewritten. The adapter then re-implements ZCode's required-field check (`validateZcodeConfig`) against the *whole* resulting document and refuses to emit one that would be rejected.

That second guard matters because ZCode validates the entire file with zod, all-or-nothing. One rule missing `optionSpecs.reasoningLevel` and the app discards the whole config, running on an empty in-memory copy: **every custom provider disappears from the UI while the file on disk remains complete.** If you ever see that, check the file on disk before assuming data loss.

**Restart:** closing the window is not enough. Quit ZCode from the tray icon and start it again; until then it keeps the config it loaded at launch.

**Note:** the API key is stored in plaintext as `access.apiKey`, which is how ZCode itself stores it. This file should not be committed or shared.

---

## opencode

**File:** `~/.config/opencode/opencode.jsonc` if it exists, otherwise `~/.config/opencode/opencode.json`. `OPENCODE_CONFIG` overrides both.

Two generations of the schema exist and the adapter writes whichever the existing file already uses, so a pinned older build keeps working:

- **Legacy** — the file has a `provider` key and no `providers`:

```json
{
  "provider": {
    "custom-api-example-com": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "api.example.com",
      "options": { "baseURL": "https://api.example.com/v1", "apiKey": "sk-..." },
      "models": {
        "model-a": { "name": "model-a", "limit": { "context": 262144, "output": 65536 } }
      }
    }
  }
}
```

`npm` is `@ai-sdk/openai-compatible` for chat and responses, `@ai-sdk/anthropic` for anthropic-messages.

- **Current** — anything else (including a new file). `$schema` is only added when the file does not already have it:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "custom-api-example-com": {
      "name": "api.example.com",
      "env": ["CUSTOM_API_EXAMPLE_COM_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://api.example.com/v1" },
      "models": {
        "model-a": { "name": "model-a", "limit": { "context": 262144, "output": 65536 } }
      }
    }
  }
}
```

`package` is `@opencode/ai/providers/openai-compatible`, `.../openai-compatible/responses`, or `@opencode/ai/providers/anthropic-compatible`.

**Merge safety:** safe. JSONC (comments and trailing commas) is parsed loosely before merging, and everything else in the file is preserved. A file that still fails to parse throws.

**Credential handling:** the current schema takes an env var *name*, not the key. The adapter derives `<PROVIDER ID>_API_KEY` in upper snake case and prints the command you must run before starting opencode:

```bash
export CUSTOM_API_EXAMPLE_COM_API_KEY="sk-..."      # POSIX
setx CUSTOM_API_EXAMPLE_COM_API_KEY "sk-..."        # Windows
```

Only the legacy shape embeds the key inline.

**Restart:** restart opencode after the env var is set and the file is written.

---

## claude-code

**File:** `~/.claude/settings.json` — only the `env` block is touched.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.example.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "model-a",
    "ANTHROPIC_SMALL_FAST_MODEL": "model-b"
  }
}
```

`ANTHROPIC_MODEL` is the first selected model. `ANTHROPIC_SMALL_FAST_MODEL` prefers a remaining model whose id contains `haiku`, `mini`, `small`, `flash` or `lite`; otherwise the next selected model, otherwise the primary one again. Other keys under `env` and elsewhere in the file are preserved.

**Merge safety:** safe for valid JSON; invalid JSON throws.

**Protocol restriction:** Claude Code speaks only the Anthropic Messages API. The adapter still writes the file when the probe detected something else, but adds a loud note — pointing a translating proxy (LiteLLM is the obvious one) in front of the gateway is the fix. Check `format` in the probe output before relying on this target.

**Restart:** `claude` reads these at start-up; any running session keeps the old values.

---

## cline

**File:** the VS Code user settings file.

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Code\User\settings.json` |
| macOS | `~/Library/Application Support/Code/User/settings.json` |
| Linux | `~/.config/Code/User/settings.json` |

**Written:** flat keys, for both Cline and Roo Code (which mirrors the same keys under its own prefix):

```json
{
  "cline.apiProvider": "openai",
  "cline.openAiBaseUrl": "https://api.example.com/v1",
  "cline.openAiApiKey": "sk-...",
  "cline.openAiModelId": "model-a",
  "roo-cline.apiProvider": "openai",
  "roo-cline.openAiBaseUrl": "https://api.example.com/v1",
  "roo-cline.openAiApiKey": "sk-...",
  "roo-cline.openAiModelId": "model-a"
}
```

**Merge safety:** safe. VS Code permits comments and trailing commas in `settings.json`, so the file is parsed loosely first and all unrelated settings survive.

**Limitation:** only the first selected model becomes active. Additional models are not registered — switch between them in the extension panel.

**Protocol:** chat completions only.

**Restart:** reload the VS Code window (or run *Developer: Reload Window*) so the extension re-reads its settings.

---

## continue

**File:** `~/.continue/config.yaml`

**Written:** a complete `models:` list, one entry per selected model:

```yaml
models:
  - name: model-a
    provider: openai
    model: model-a
    apiBase: https://api.example.com/v1
    apiKey: sk-...
    contextLength: 262144
    defaultCompletionOptions:
      maxTokens: 65536
```

**Merge safety:** none. YAML sequences cannot be appended to without risking the whole document, so the adapter never merges:

- file does not exist → written as a full config (`create`)
- file exists → the same text goes to `~/.continue/config.anyprovider.yaml` (`suggest`), and the note tells you to merge the `models:` entries by hand

The snippet is also printed to the terminal, so you can copy it without opening the suggestion file.

**Protocol:** chat completions; `provider: openai` is hard-coded.

**Restart:** restart Continue (the IDE extension or `cn`) to pick up the new file.

---

## litellm

**File:** `./litellm.config.yaml` — relative to the current working directory, so run the tool from the directory where you want the proxy config.

**Written:**

```yaml
model_list:
  - model_name: model-a
    litellm_params:
      model: openai/model-a
      api_base: https://api.example.com/v1
      api_key: sk-...
      max_tokens: 65536
```

The `model:` prefix is `openai` for chat and responses, `anthropic` for anthropic-messages.

**Merge safety:** none, same rule as Continue — create when absent, `litellm.config.anyprovider.yaml` when present.

**Why it is here:** LiteLLM is the cheapest way to give a chat-only gateway an anthropic-messages front door, which is what makes `claude-code` usable against such a gateway. It also normalises reasoning parameters across providers.

**Restart:** restart the proxy (`litellm --config ./litellm.config.yaml`, as printed in the notes).

---

## aider

**File:** `~/.aider.conf.yml`

**Written:**

```yaml
openai-api-base: https://api.example.com/v1
openai-api-key: sk-...
model: openai/model-a
weak-model: openai/model-b
```

The first selected model becomes `model`; the second (or the first again) becomes `weak-model`. Remaining models are listed in the notes as `--model openai/<id>` alternatives, since aider is a single-model CLI.

**Merge safety:** none — create when absent, suggest when present.

**Protocol:** chat completions; aider talks to gateways through its `openai/` provider prefix.

**Restart:** nothing to restart; the file is read on the next `aider` invocation.

---

## env

**File:** `~/.anyprovider/providers.json`

The escape hatch for harnesses that are not in this list. Every tool eventually needs "base URL + key + model id + limits", and this keeps a machine-readable record of exactly that:

```json
{
  "version": 1,
  "providers": {
    "custom-api-example-com": {
      "id": "custom-api-example-com",
      "name": "api.example.com",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "sk-...",
      "format": "openai-chat-completions",
      "endpoint": "https://api.example.com/v1/chat/completions",
      "models": {
        "model-a": { "contextWindow": 262144, "maxOutputTokens": 65536, "reasoning": "reasoning_effort" }
      },
      "discoveredAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

It also prints an env snippet:

```bash
export OPENAI_BASE_URL="https://api.example.com/v1"
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="model-a"
export CUSTOM_API_EXAMPLE_COM_BASE_URL="https://api.example.com/v1"
export CUSTOM_API_EXAMPLE_COM_API_KEY="sk-..."
```

**Merge safety:** safe — the registry is keyed by provider id, so re-running updates one entry.

**Note:** the file contains the API key in plaintext. Keep it private; `.gitignore` in this repository already excludes `providers.json`.

---

## Writing a new adapter

See the contract at the top of [`src/targets/_shared.mjs`](../src/targets/_shared.mjs) and the summary in the [README](../README.md#adding-a-target). The short version: return `{ writes, snippet, notes }`, pick the most conservative `mode` you can justify, and never write a file yourself.
