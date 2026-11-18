/**
 * DeepSeek Harness (DSH desktop) — `~/.dsh/profiles/desktop/cordis.patch.yml`
 * plus `~/.dsh/.credentials.yaml`.
 *
 * DSH composes its runtime config as a patch layer: a top-level YAML array of
 * entries (`{ id, name, config }`). Custom LLM providers live in one entry,
 * `id: llm-pi-ai`, under `config.providers.<providerId>`:
 *
 *   - id: llm-pi-ai
 *     name: "@deepseek-ai/dsh-llm-pi-ai"
 *     config:
 *       providers:
 *         <providerId>:
 *           displayName: ...
 *           apiKeyEnv: <PROVIDER>_API_KEY      # credential reference, not a key
 *           api: openai-completions | openai-responses | anthropic-messages
 *           baseURL: https://...
 *           models:
 *             - id: model-a
 *               name: model-a
 *               contextWindow: 128000
 *               maxTokens: 32768
 *               reasoningEfforts: { off: null, low: low, medium: medium, high: high }
 *
 * The key itself never goes into the patch file — DSH's own UI enforces
 * "cordis.patch.yml 从不携带密钥值" and stores secrets in
 * `~/.dsh/.credentials.yaml` under `refs.<apiKeyEnv>`, resolved per request.
 * We do exactly that: the ref name goes into the patch, the key into `refs`.
 *
 * No YAML library ships with this repo (zero dependencies), so both files are
 * edited with indentation-aware line surgery instead of parse/serialize:
 * the llm-pi-ai entry, the providers map and each provider block are found by
 * exact indent rules, our own block is replaced in place, and every other
 * byte of the file — including providers anyprovider has never seen — is
 * preserved verbatim. Line endings are preserved per file.
 */

import { baseNotes, home, readTextIfExists, yamlString } from './_shared.mjs';

const FORMAT = {
  chat: 'openai-completions',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
};

export function dshPatchPath(env = process.env) {
  if (env.DSH_PATCH) return env.DSH_PATCH;
  return join(home(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
}

export function dshCredentialsPath(env = process.env) {
  if (env.DSH_CREDENTIALS) return env.DSH_CREDENTIALS;
  return join(home(), '.dsh', '.credentials.yaml');
}

/** `my-gateway` → `MY_GATEWAY_API_KEY`, matching DSH's own naming. */
export function envNameFor(providerId) {
  const slug = String(providerId).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return `${slug || 'CUSTOM'}_API_KEY`;
}

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => line.trim() === '';

/* ------------------------------------------------------------------ */
/* Provider block generation                                           */
/* ------------------------------------------------------------------ */

/**
 * YAML lines for one provider at the given indent. `reasoningEfforts` mirrors
 * what DSH's own settings UI writes: `off: null` plus the three levels
 * verbatim — pi-ai turns the level into the wire format for the provider's
 * `api`. A model that rejected every knob gets no `reasoningEfforts` at all.
 */
export function providerBlockLines({ id, providerName, apiKeyEnv, api, baseUrl, discovery, selected }, indent) {
  const pad = ' '.repeat(indent);
  const lines = [
    `${pad}${id}:`,
    `${pad}  displayName: ${yamlString(providerName)}`,
    `${pad}  apiKeyEnv: ${apiKeyEnv}`,
    `${pad}  api: ${api}`,
    `${pad}  baseURL: ${yamlString(baseUrl)}`,
    `${pad}  models:`,
  ];

  for (const model of selected) {
    lines.push(`${pad}    - id: ${yamlString(model.id)}`);
    lines.push(`${pad}      name: ${yamlString(model.name || model.id)}`);
    if (Number.isFinite(model.contextWindow)) lines.push(`${pad}      contextWindow: ${model.contextWindow}`);
    if (Number.isFinite(model.maxOutputTokens)) lines.push(`${pad}      maxTokens: ${model.maxOutputTokens}`);
    const knob = model.reasoning === undefined ? discovery.providerReasoning : model.reasoning;
    if (knob) {
      lines.push(`${pad}      reasoningEfforts:`);
      lines.push(`${pad}        off: null`);
      for (const level of ['low', 'medium', 'high']) lines.push(`${pad}        ${level}: ${level}`);
    }
  }

  return lines;
}

/* ------------------------------------------------------------------ */
/* cordis.patch.yml surgery                                            */
/* ------------------------------------------------------------------ */

function splitKeepEol(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { eol, lines: text.split(/\r?\n/) };
}

/**
 * Insert or replace the llm-pi-ai provider entry in the patch text.
 * `text === null` means the file does not exist yet.
 */
export function upsertPatchEntry(text, args) {
  const { eol, lines } = text === null
    ? { eol: '\n', lines: ['# DeepSeek Harness profile patch — see https://github.com/xzq66677/anyprovider', ''] }
    : splitKeepEol(text);

  const block = providerBlockLines(args, 6);
  const entryStart = lines.findIndex((l) => /^- id:\s*["']?llm-pi-ai["']?\s*(#.*)?$/.test(l));

  if (entryStart < 0) {
    lines.push(
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      ...block,
    );
    return lines.join(eol);
  }

  // The entry ends at the next top-level array item or at EOF.
  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) { entryEnd = i; break; }
  }

  const providersIdx = lines.findIndex((l, i) => i > entryStart && i < entryEnd && /^(\s*)providers:\s*(#.*)?$/.test(l));

  if (providersIdx >= 0) {
    const providersIndent = indentOf(lines[providersIdx]);
    const childIndent = providersIndent + 2;
    // End of the providers map: the next line inside the entry that is
    // dedented back to the providers level or above.
    let providersEnd = entryEnd;
    for (let i = providersIdx + 1; i < entryEnd; i++) {
      if (isBlank(lines[i])) continue;
      if (indentOf(lines[i]) <= providersIndent) { providersEnd = i; break; }
    }

    // Remove a previous block for the same provider id, then append ours at
    // the end of the providers map. Anything else stays untouched.
    const ownLine = new RegExp(`^ {${childIndent}}${escape(args.id)}:.*$`);
    const ownIdx = lines.findIndex((l, i) => i > providersIdx && i < providersEnd && ownLine.test(l));
    let cutStart = -1;
    let cutEnd = -1;
    if (ownIdx >= 0) {
      cutStart = ownIdx;
      cutEnd = providersEnd;
      for (let i = ownIdx + 1; i < providersEnd; i++) {
        if (isBlank(lines[i])) continue;
        if (indentOf(lines[i]) <= childIndent) { cutEnd = i; break; }
      }
      lines.splice(cutStart, cutEnd - cutStart);
      insertBlock(lines, providersEnd - (cutEnd - cutStart), block);
    } else {
      insertBlock(lines, providersEnd, block);
    }
    return lines.join(eol);
  }

  // Entry exists but has no providers map yet — add one under config: (or a
  // fresh config: right before the entry ends).
  const configIdx = lines.findIndex((l, i) => i > entryStart && i < entryEnd && /^ {2}config:\s*(#.*)?$/.test(l));
  const insertAt = configIdx >= 0 ? configIdx + 1 : entryEnd;
  lines.splice(insertAt, 0,
    ...(configIdx >= 0
      ? ['    providers:', ...block]
      : ['  config:', '    providers:', ...block]));
  return lines.join(eol);
}

/** Insert `block` right after the last non-blank line before `from`. */
function insertBlock(lines, from, block) {
  let at = Math.min(Math.max(from, 0), lines.length);
  while (at > 0 && isBlank(lines[at - 1])) at--;
  lines.splice(at, 0, ...block);
}

/* ------------------------------------------------------------------ */
/* .credentials.yaml surgery                                           */
/* ------------------------------------------------------------------ */

/**
 * Upsert `refs.<envName>` in the credentials text. Other refs and all grant
 * records are preserved verbatim; `text === null` creates a minimal file.
 */
export function upsertCredentialRef(text, envName, apiKey) {
  const { eol, lines } = text === null
    ? { eol: '\n', lines: ['version: 1', 'records: {}'] }
    : splitKeepEol(text);

  const valueLine = `  ${envName}: ${yamlString(apiKey)}`;
  const refsIdx = lines.findIndex((l) => /^refs:\s*(#.*)?$/.test(l));

  if (refsIdx < 0) {
    lines.push('refs:', valueLine);
    return lines.join(eol);
  }

  let refsEnd = lines.length;
  for (let i = refsIdx + 1; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) === 0) { refsEnd = i; break; }
  }

  const ownLine = new RegExp(`^ {2}${escape(envName)}:.*$`);
  const ownIdx = lines.findIndex((l, i) => i > refsIdx && i < refsEnd && ownLine.test(l));
  if (ownIdx >= 0) {
    lines.splice(ownIdx, 1, valueLine);
  } else {
    let at = refsEnd;
    while (at > refsIdx + 1 && isBlank(lines[at - 1])) at--;
    lines.splice(at, 0, valueLine);
  }
  return lines.join(eol);
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export default {
  id: 'deepseek-harness',
  label: 'DeepSeek Harness',
  homepage: 'https://www.deepseek.com',
  level: 'auto',
  protocols: ['chat', 'responses', 'anthropic'],

  defaultPath: ({ env = process.env } = {}) => dshPatchPath(env),

  plan({ discovery, selected, providerId: id, providerName, baseUrl, apiKey, path, env = process.env }) {
    const patchPath = path || dshPatchPath(env);
    const credPath = dshCredentialsPath(env);
    const apiKeyEnv = envNameFor(id);
    const api = FORMAT[discovery.protocol] || 'openai-completions';

    const args = { id, providerName, apiKeyEnv, api, baseUrl, discovery, selected };
    const nextPatch = upsertPatchEntry(readTextIfExists(patchPath), args);
    const nextCred = upsertCredentialRef(readTextIfExists(credPath), apiKeyEnv, apiKey);

    if (nextPatch.includes(apiKey)) {
      throw new Error('internal error: the API key leaked into cordis.patch.yml; refusing to write');
    }

    return {
      writes: [
        { path: patchPath, text: nextPatch, mode: 'merge' },
        { path: credPath, text: nextCred, mode: 'merge' },
      ],
      snippet: [
        `# DeepSeek Harness — provider "${id}" (${api})`,
        `#  patch      : ${patchPath}  → llm-pi-ai.providers.${id}`,
        `#  credentials: ${credPath}  → refs.${apiKeyEnv}`,
        `#  models     : ${selected.map((m) => m.id).join(', ')}`,
      ].join('\n'),
      notes: [
        'The key lives in .credentials.yaml refs, never in cordis.patch.yml — that is DSH\'s own rule.',
        'Fully quit DeepSeek Harness (tray icon) and restart it for the patch to reload.',
        'Using the headless profile too? Rerun with DSH_PATCH pointing at ~/.dsh/profiles/headless/cordis.patch.yml.',
        ...baseNotes(discovery),
      ],
    };
  },
};
