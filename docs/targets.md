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
| `deepseek-harness` | `~/.dsh/profiles/desktop/cordis.patch.yml` + `~/.dsh/.credentials.yaml` | merge (both) | chat, responses, anthropic | yes — quit from tray |
| `cline` | VS Code user `settings.json` | merge | chat | reload the window |
| `continue` | `~/.continue/config.yaml` | create / suggest | chat | yes |
| `litellm` | `./litellm.config.yaml` | create / suggest | chat, responses, anthropic | restart the proxy |
| `aider` | `~/.aider.conf.yml` | create / suggest | chat | next invocation |
| `zed` | `~/.config/zed/settings.json` (Win: `%APPDATA%\Zed\settings.json`) | merge | chat, responses, anthropic | yes — restart Zed |
| `vscode-copilot` | user `chatLanguageModels.json` | merge | chat, responses, anthropic | reload the window |
| `windsurf` | `~/.anyprovider/windsurf.json` only | merge | chat, responses, anthropic | n/a — guided |
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

## deepseek-harness

**Files:** `~/.dsh/profiles/desktop/cordis.patch.yml` (provider definition) and `~/.dsh/.credentials.yaml` (the key). `DSH_PATCH` and `DSH_CREDENTIALS` override both — point `DSH_PATCH` at `~/.dsh/profiles/headless/cordis.patch.yml` if you also run the headless profile.

**Written:** the provider is merged into the `id: llm-pi-ai` patch entry's `config.providers` map (an existing entry with the same id is replaced; the entry is created when missing):

```yaml
      custom-api-example-com:
        displayName: api.example.com
        apiKeyEnv: CUSTOM_API_EXAMPLE_COM_API_KEY
        api: openai-completions        # or openai-responses / anthropic-messages
        baseURL: https://api.example.com/v1
        models:
          - id: model-a
            name: model-a
            contextWindow: 262144
            maxTokens: 65536
            reasoningEfforts:          # only for models with a reasoning knob
              off: null
              low: low
              medium: medium
              high: high
```

The key itself never enters the patch file — that is DSH's own rule ("cordis.patch.yml 从不携带密钥值"). It is upserted into the credentials store:

```yaml
refs:
  CUSTOM_API_EXAMPLE_COM_API_KEY: sk-...
```

**Merge safety:** indentation-aware line surgery, not parse/serialize — the repo ships zero dependencies, so the adapter locates the `llm-pi-ai` entry, the `providers:` map and each provider block by exact indent rules and rewrites only its own block. Providers it has never seen (and grant records in `.credentials.yaml`) survive verbatim, line endings are preserved, and a guard refuses to write if the key ever leaked into the patch text.

**Protocol:** all three — DSH's pi-ai engine speaks `openai-completions`, `openai-responses` and `anthropic-messages`.

**Restart:** fully quit DeepSeek Harness from the tray and start it again; the patch layer is read at startup.

---

## zed

**File:** `~/.config/zed/settings.json`; on Windows `%APPDATA%\Zed\settings.json`. `ZED_SETTINGS` overrides.

**Written:** a provider under `language_models.openai_compatible.<providerId>` (or `anthropic_compatible.<providerName>` for anthropic gateways):

```json
{
  "language_models": {
    "openai_compatible": {
      "custom-api-example-com": {
        "api_url": "https://api.example.com/v1",
        "available_models": [
          { "name": "model-a", "display_name": "model-a", "max_tokens": 262144,
            "max_output_tokens": 65536, "reasoning_effort": "medium" }
        ]
      }
    }
  }
}
```

Models that rejected every reasoning knob get no `reasoning_effort`; `responses`-protocol models get `capabilities.chat_completions: false`; anthropic gateways get a `thinking` mode entry and an `/v1`-stripped URL.

**Merge safety:** full JSON parse/merge — unrelated settings are preserved.

**Protocol:** chat, responses, anthropic.

**Restart:** yes — restart Zed after editing settings.json.

---

## vscode-copilot

**File:** the VS Code user `chatLanguageModels.json` custom-endpoint list. On Windows it prefers `%APPDATA%\Code\User\` and falls back to `Code - Insiders` when only the Insiders file exists; `VSCODE_CHAT_MODELS` overrides the whole path.

**Written:** one `customendpoint` provider entry per run (matched and replaced by `name`):

```json
[{
  "name": "api.example.com",
  "vendor": "customendpoint",
  "apiType": "chat-completions",
  "apiKey": "sk-...",
  "models": [{
    "id": "model-a", "name": "model-a", "apiType": "chat-completions",
    "url": "https://api.example.com/v1/chat/completions",
    "toolCalling": true, "vision": false,
    "maxInputTokens": 196608, "maxOutputTokens": 65536,
    "thinking": true,
    "supportsReasoningEffort": ["minimal", "low", "medium", "high"],
    "reasoningEffortFormat": "chat-completions"
  }]
}]
```

`apiType` maps the protocol directly: `chat` → `chat-completions`, `responses` → `responses`, `anthropic` → `messages`. Each model's `url` is the full endpoint the probe actually verified, including the API path. `maxInputTokens + maxOutputTokens` always equals the probed context window — VS Code treats their sum as the context size. Reasoning fields appear only for models with a knob; anthropic gateways accept `["low", "medium", "high"]`, chat ones `["minimal", "low", "medium", "high"]`.

**Merge safety:** full JSON parse/merge — its own entry is replaced by `name`, other entries stay.

**Protocol:** chat, responses, anthropic.

**Restart:** reload the VS Code window.

---

## windsurf

**File:** `~/.anyprovider/windsurf.json` — a capture bundle, nothing inside Windsurf itself.

Windsurf documents no settings file for arbitrary custom endpoints; Cascade's BYOK dialog only accepts pasted values. Rather than inventing a config format and corrupting an install, this target records the discovered provider (base URL, key, models, primary model) in the bundle and prints the exact three values to paste into the BYOK dialog, plus a note pointing at the supported ACP-agent path (OpenCode, Claude Agent, Gemini CLI) if the dialog rejects the paste.

**Merge safety:** the bundle is JSON and merged; Windsurf's own files are never touched.

**Protocol:** chat, responses, anthropic.

**Restart:** n/a — nothing was written into Windsurf.

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
