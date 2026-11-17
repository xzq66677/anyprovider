# anyprovider

You have an API key and a base URL. Your coding agent wants a provider entry with model ids, a context window, an output ceiling and a reasoning knob. This tool figures all of that out from the gateway itself, then writes the config your harness actually reads.

[![Node](https://img.shields.io/badge/node-%3E%3D18-3c873a?style=flat-square)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Dependencies: none](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](#install)

English · [简体中文](README.zh-CN.md)

---

## The problem

Onboarding a new model provider is four unknowns stacked on top of each other:

- **Which model ids exist?** Often `/v1/models` is missing, stale, or hand-maintained.
- **How is reasoning passed?** `reasoning_effort`, `thinking.type`, `reasoning.effort`, `enable_thinking`, `chat_template_kwargs` — every gateway picked a different one, and a wrong guess is a hard 400.
- **How large is the context window and the output ceiling?** Guessing wrong is either a truncated answer or a request the server rejects outright.
- **What does my harness want?** ZCode, opencode, Claude Code, Continue, Cline, LiteLLM and aider all store provider config in different files, with different keys and different ideas about what a "model" is.

anyprovider answers all four by talking to the gateway, then emits the file each harness expects.

## What it does

One probe run produces a per-model record — id, context window, max output, reasoning parameter — and each target adapter turns that into its own file format.

It does not read vendor documentation, and it does not assume `/models` is honest: the reasoning knob and the output ceiling are established by sending a few very small real requests and observing what the gateway accepts and what it says when you ask for too much.

## Install

Requires Node 18 or newer. There are no dependencies — `node_modules` never appears.

```bash
# from source
git clone https://github.com/USER/anyprovider.git
cd anyprovider
node src/cli.mjs --help

# or install the `anyprovider` command globally from a checkout
npm i -g .
anyprovider --list-targets
```

Once published to npm:

```bash
npx anyprovider --list-targets
```

## Quick start

Put the key in a file so it does not end up in your shell history:

```bash
printf '%s' 'sk-...' > ./key.txt

node src/cli.mjs \
  --base https://api.example.com/v1 \
  --key-file ./key.txt \
  --target opencode
```

That is a **dry run**: it prints the discovered models and the file it *would* write. Add `--write` to apply.

```bash
node src/cli.mjs \
  --base https://api.example.com/v1 \
  --key-file ./key.txt \
  --target opencode,zcode \
  --write
```

## CLI

```
Usage
  anyprovider --base <url> --key <key> --target <ids> [--write]

Required
  --base <url>          gateway base URL (with or without /v1)
  --key-file <path>     file containing the API key (preferred)
  --key <key>           API key inline (visible in shell history)
                        or set ANYPROVIDER_API_KEY / OPENAI_API_KEY
  --target <ids>        comma separated, or "all"

Discovery
  --model <ids>         comma separated model ids (when /models is missing)
  --protocol <list>     restrict detection to chat,responses,anthropic
  --sample <n>          models to reasoning-probe (default 3, 0 = skip)
  --deep                probe every model individually (slow, thorough)
  --default-context <n> context window when the gateway reports none (128000)
  --default-maxout <n>  max output when it cannot be probed (32000)
  --timeout <ms>        per-request timeout (30000)

Output
  --write               actually write configs (default: dry run)
  --name <text>         display name (default: host)
  --id <text>           provider id (default: derived from host)
  --json                machine-readable discovery output
  --list-targets        show supported harnesses

Targets  zcode  opencode  claude-code  cline  continue  litellm  aider  env
```

| Flag | Meaning |
|---|---|
| `--base` | Required. Scheme is added if missing (`https://`), trailing slashes are stripped, `/v1` is optional. |
| `--key-file` | Required unless you use `--key` or the env vars. First line of the file, trimmed. |
| `--key` | Inline key. Convenient, and visible in `ps` / shell history — prefer `--key-file`. |
| `ANYPROVIDER_API_KEY`, `OPENAI_API_KEY` | Read only when neither `--key-file` nor `--key` is given. |
| `--target` | Comma or space separated ids, or `all`. `--list-targets` prints the ids. |
| `--model` | Used twice: supplies ids when `/models` is empty, and restricts which discovered models get written. |
| `--protocol` | Restricts and reorders protocol detection, e.g. `--protocol anthropic` for a gateway you know is Anthropic-native. |
| `--sample` | How many models get the reasoning probe; models with missing metadata are picked first. `0` skips reasoning entirely. |
| `--deep` | Probes reasoning and the output ceiling per model instead of once per gateway. Roughly one request per candidate knob per model. |
| `--default-context` | Fallback context window when `/models` reports none. |
| `--default-maxout` | Fallback output ceiling when the overshoot probe yields nothing. |
| `--timeout` | Per-request timeout in milliseconds. |
| `--write` | Apply. Without it, nothing on disk changes. |
| `--name` | Display name stored in the config. Defaults to the base URL host. |
| `--id` | Provider id. Defaults to `custom-<host-slug>`, max 40 characters. |
| `--json` | Prints `{ discovery, targets }` to stdout and silences the human output. Useful for piping into other tooling. |
| `--list-targets` | Prints id, label and homepage for every adapter, then exits. |

`-h` / `--help` and `-v` / `--version` also work.

Exit codes: `0` success, `1` the gateway could not be mapped or a target failed, `2` bad invocation (missing `--base`, `--target`, or key).

### Examples

Probe only, see what the gateway claims, write nothing:

```bash
node src/cli.mjs --base https://api.example.com/v1 --key-file ./key.txt --target env
```

A gateway with no `/models` endpoint, where you know the ids:

```bash
node src/cli.mjs \
  --base https://api.example.com \
  --key-file ./key.txt \
  --model model-a,model-b \
  --target opencode --write
```

Write only two of the many advertised models into ZCode, with an explicit provider id:

```bash
node src/cli.mjs \
  --base https://api.example.com/v1 \
  --key-file ./key.txt \
  --id my-gateway \
  --name "My Gateway" \
  --model gpt-x,gpt-x-mini \
  --target zcode --write
```

Machine-readable discovery for a script:

```bash
node src/cli.mjs --base https://api.example.com/v1 --key-file ./key.txt \
  --target env --json > discovery.json
```

## Wizard

The wizard is the same engine without flags — it asks for the base URL, the key (masked), a name, then shows the models and lets you pick targets.

```bash
node src/wizard.mjs
# or
npm run wizard
```

There is **no `anyprovider-wizard` bin**; `package.json` only exposes `anyprovider`, plus the `wizard` npm script. The wizard has no flags — pass nothing. Its prompts are currently in Chinese.

Flow: base URL → key → display name → probe → model table with a selection prompt (`enter` = all, `1,3-5` = indexes, `M id1,id2` = manual, `Q` = quit) → target menu (defaults to the targets whose config files already exist on disk) → preview of every file to be written → one confirmation → apply.

On a terminal it waits for a final keypress so a double-clicked window does not disappear. Piped input works too: earlier-arriving lines are queued rather than dropped.

## Supported targets

| id | Tool | File written | Safe merge? | Protocols |
|---|---|---|---|---|
| `zcode` | ZCode | `<dataBaseDir>/.zcode/v2/provider_config.json` | yes — merges, validates first | chat, responses, anthropic |
| `opencode` | opencode | `~/.config/opencode/opencode.json` (or `.jsonc`) | yes — merges, both schema generations | chat, responses, anthropic |
| `claude-code` | Claude Code | `~/.claude/settings.json` | yes — merges the `env` block | anthropic only |
| `cline` | Cline / Roo Code | VS Code user `settings.json` | yes — merges flat `cline.*` keys | chat |
| `continue` | Continue | `~/.continue/config.yaml` | create or suggest | chat |
| `litellm` | LiteLLM | `./litellm.config.yaml` | create or suggest | chat, responses, anthropic |
| `aider` | aider | `~/.aider.conf.yml` | create or suggest | chat |
| `env` | anything else | `~/.anyprovider/providers.json` | yes — merges registry | chat, responses, anthropic |

"Protocols" is what the emitted config assumes. When the probe detects a protocol a target cannot speak, that target is **skipped with a warning** instead of writing a config it could never use — so `--target all` against an Anthropic-native gateway writes ZCode, opencode, LiteLLM and the generic bundle, and skips the chat-only ones.

Details per target — exact keys, path overrides, restart requirements — are in [docs/targets.md](docs/targets.md).

## Safety model

- **Dry run by default.** Nothing is written without `--write`.
- **Backups.** Any existing file is copied to `<file>.bak-<ISO timestamp>` before it is replaced.
- **Atomic writes.** Content goes to a temp file in the same directory and is `rename`d into place, so an interrupted run cannot leave a half-written config.
- **Three write modes**, declared per target:
  - `merge` — the adapter understands this file's format and merges into it, preserving everything else.
  - `create` — written only when the file does not exist; if it does, the target is downgraded to `suggest`.
  - `suggest` — never touches the real file; writes a sibling `<name>.anyprovider.<ext>` for you to merge by hand.
- **Unparseable files are never touched.** If an existing config is not valid JSON (or JSONC), the adapter throws instead of guessing.
- **ZCode validates before it writes.** ZCode checks the whole `provider_config.json` with zod, all-or-nothing: a single rule missing a required field (`optionSpecs.reasoningLevel`, for instance) makes the app discard the entire file and run on an empty in-memory copy — the UI then shows no custom providers at all while the file on disk is still intact. The ZCode adapter re-implements that required-field check and refuses to emit a config that would be rejected.
- **Keys are printed in some snippets.** The `continue`, `litellm`, `aider` and `env` targets embed the API key in their output because those tools need it inline. Do not paste that output into issues or logs.

## How the probing works

Four steps, each empirical.

**1. Model list.** `GET {base}/models` is attempted against the base URL as given and against a version-stripped variant, plus `/v1` appended where it is missing — gateways are inconsistent about whether the base URL includes the version segment. The first 200 with a non-empty list wins. A 401/403 aborts immediately instead of retrying every candidate.

**2. Protocol sniff.** One tiny request per protocol, in order `chat` → `responses` → `anthropic`, each hitting `/chat/completions`, `/responses`, `/messages` under the candidate bases. A response is accepted only if it looks like the protocol's real shape (`choices[]`, `output[]`, `content[]`). The first match fixes the format: `openai-chat-completions`, `openai-responses` or `anthropic-messages`.

**3. Reasoning parameter.** Send a baseline request, then one request per candidate knob and keep the first that is not a 400:

| Protocol | Candidates, in order |
|---|---|
| chat | `reasoning_effort`, `thinking`, `reasoning`, `enable_thinking`, `chat_template_kwargs` |
| responses | `reasoning`, `reasoning_effort` |
| anthropic | `thinking` |

A knob that is accepted is kept, and the probe also records whether the gateway echoes any reasoning payload back (`reasoning_content`, `thinking` blocks, `reasoning_tokens`); a knob accepted with no echo at all is marked silent in the `--json` output. By default three models are sampled (preferring the ones whose `/models` entry lacks metadata) and the majority result becomes the provider-wide default; `--deep` probes every model. A model that was probed and rejected every knob is recorded as *no reasoning* and does not inherit the provider-wide winner.

**4. Output ceiling.** `/models` metadata is used when present (`max_completion_tokens`, `max_output_tokens`, `max_tokens`). Otherwise the probe deliberately overshoots with `max_tokens: 1000000`; the resulting 400 usually names the real limit, which is parsed out of the message and bounded below the overshoot value. One such probe covers every model missing a ceiling; `--deep` probes per model. Context windows come from `context_length` / `context_window` / `max_context_length` / `max_model_len`, falling back to `--default-context`.

Everything learned lands in one object, exposed verbatim by `--json`.

## Limitations

- **Three protocols only.** OpenAI chat completions, OpenAI responses, and Anthropic messages. No native Gemini, Bedrock or Cohere protocols.
- **Capabilities are not probed.** Whether a model accepts images, video, PDFs, native web search or JSON-schema output is never tested. Adapters write conservative defaults (`supportsImage: false`, `supportsNativeWebSearch: false` in ZCode), so turn capabilities on by hand if the model has them.
- **Model-specific quirks are averaged.** One reasoning parameter per provider unless you pass `--deep`; a gateway that mixes reasoning and non-reasoning models behind one endpoint may need `--deep`.
- **Probing costs requests.** Each run sends a handful of small completions; `--deep` sends roughly one request per candidate knob per model. `--sample 0` skips the reasoning probe entirely.
- **opencode's current schema stores credentials in the environment.** The modern `providers` shape references an env var name, not the key, so the adapter prints the `export` / `setx` line you must run before launching opencode. Only the legacy `provider` shape takes an inline `apiKey`.
- **YAML targets never merge.** Continue, LiteLLM and aider get a full file only when none exists; otherwise you get a `.anyprovider.<ext>` suggestion to paste from. YAML lists cannot be appended to safely.
- **`--target all` writes to your working directory.** The `litellm` target resolves to `./litellm.config.yaml` relative to where you run it, and `env` keeps a copy of the key under `~/.anyprovider/providers.json`.

## Adding a target

An adapter declares metadata and one pure `plan()` function. It never writes files; `src/core/apply.mjs` does that, with backups and atomic renames.

```js
export default {
  id: 'mytool',
  label: 'My Tool',
  homepage: 'https://example.com',
  protocols: ['chat'],          // what the emitted config assumes
  defaultPath: () => join(home(), '.mytool', 'config.json'),
  plan({ discovery, selected, providerId, providerName, baseUrl, apiKey, path }) {
    return {
      writes: [{ path: path || join(home(), '.mytool', 'config.json'), text: toJson(root), mode: 'merge' }],
      snippet: null,            // optional text printed to the user
      notes: ['Restart My Tool so it reloads the config.'],
    };
  },
};
```

Rules: return text, never write; throw rather than emit something you know is invalid; pick `mode: 'suggest'` for any format you cannot merge with certainty. Register the adapter in `src/targets/index.mjs` — that list drives `--target all`, `--list-targets` and the wizard menu. The full contract, including the `mode` semantics and the shared helpers (`readJsonIfExists`, `parseJsonLoose`, `toJson`, `yamlString`, `upsertBlock`), is documented at the top of `src/targets/_shared.mjs`.

## Development

```bash
npm test        # node --test test/
```

The suite uses a local mock gateway (`test/mock-gateway.mjs`) and writes into a temp directory; it never touches a real config. CI runs the same command on Ubuntu, Windows and macOS against Node 18, 20 and 22.

## License

MIT — see [LICENSE](LICENSE).

Issues and pull requests are welcome; new target adapters are the most useful contribution, and the contract above is deliberately small.
