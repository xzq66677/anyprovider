/**
 * Key inventory — read back the API keys already stored in local harness
 * configs and in our own vault, then group them by credential.
 *
 * Read-only: this module never writes or modifies a harness config. Different
 * harnesses store things in wildly different shapes, so we use a generic
 * recursive walk over JSON configs plus a line scan for YAML/JSONC. Zed and
 * current opencode deliberately keep the key in an env var (not the file) —
 * those findings are reported with `keyEnv` and no plaintext key.
 *
 * Everything is injectable (`resolvePath`, `readText`) so tests can point at
 * temporary fixtures instead of the real machine.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { hostOf } from './endpoints.mjs';
import { readVault, vaultPath } from './keys.mjs';
import { TARGETS } from '../targets/index.mjs';
import { readHealth, healthPath, resolveHealth, DEFAULT_TTL_HOURS } from './keyhealth.mjs';

const KEY_FIELD = /^(apiKey|api_key|apikey|auth[_-]?token|access[_-]?token|token|key)$/i;
const URL_FIELD = /^(baseURL|baseUrl|base_url|apiBase|api_base|api_url|url|endpoint|protocolUrl)$/i;
const NAME_FIELD = /^(name|providerName|displayName|label)$/i;

const looksLikeUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());
const looksLikeKey = (v) => typeof v === 'string' && v.trim().length >= 8
  && !looksLikeUrl(v) && !/^\$\{?[A-Z0-9_]+\}?$/.test(v.trim());

function defaultReadText(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch { return null; }
}

/** Strip JSONC comments + trailing commas so hand-edited files still parse. */
function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned);
}

/**
 * Recursively aggregate credential signals. Harnesses scatter a provider's key
 * and URL across nested objects (e.g. ZCode: config.access.apiKey and
 * config.api.baseUrl), so we collect signals from the whole subtree and emit a
 * finding at each level that sees any of them. `groupFindings` later collapses
 * the duplicates by key. Provider blocks with several distinct keys still keep
 * one finding per leaf, so nothing is lost.
 */
function collect(node, out) {
  if (!node || typeof node !== 'object') return { name: null, baseUrl: null, apiKey: null, keyEnv: null };
  const agg = { name: null, baseUrl: null, apiKey: null, keyEnv: null };
  if (!Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (KEY_FIELD.test(k) && looksLikeKey(v)) agg.apiKey = String(v).trim();
      else if (URL_FIELD.test(k) && looksLikeUrl(v)) agg.baseUrl = String(v).trim();
      else if (NAME_FIELD.test(k) && typeof v === 'string' && v.trim()) agg.name = v.trim();
      if (typeof v === 'string') {
        // Either an explicit $REF, a bare ENV_NAME value (opencode's `env: [...]`),
        // or a `${ENV}` template. Only accept UPPER_SNAKE names ending in _API_KEY.
        const m = v.match(/\$?\{?([A-Z][A-Z0-9_]*_API_KEY)\}?/);
        if (m) agg.keyEnv = m[1];
      }
      // opencode stores env refs as an array: env: ["CUSTOM_X_API_KEY"]
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'string') {
            const m = item.match(/^([A-Z][A-Z0-9_]*_API_KEY)$/);
            if (m) { agg.keyEnv = m[1]; break; }
          }
        }
      }
    }
  }
  for (const value of Object.values(node)) {
    const child = collect(value, out);
    agg.apiKey ||= child.apiKey;
    agg.baseUrl ||= child.baseUrl;
    agg.name ||= child.name;
    agg.keyEnv ||= child.keyEnv;
  }
  if (agg.apiKey || agg.baseUrl || agg.keyEnv) out.push({ ...agg });
  return agg;
}

function walkJson(node, out) { collect(node, out); }

/** YAML / flat-key fallback: find `field: value` lines and pair them up. */
function scanTextLines(text) {
  const out = [];
  let cur = {};
  const flush = () => {
    if (cur.baseUrl || cur.apiKey || cur.keyEnv) out.push({ ...cur });
    cur = {};
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) { flush(); continue; }
    const m = line.match(/^[\s-]*([A-Za-z0-9_.\-]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    const v = rawV.replace(/^['"]|['"]$/g, '').trim();
    if (KEY_FIELD.test(k) && looksLikeKey(v)) cur.apiKey = v;
    else if (URL_FIELD.test(k) && looksLikeUrl(v)) cur.baseUrl = v;
    else if (NAME_FIELD.test(k) && v) cur.name = v;
    else if (/^([A-Z][A-Z0-9_]*_API_KEY)$/.test(k)) cur.keyEnv = k;
  }
  flush();
  return out;
}

function findingsFromConfig(text, fmt = 'json') {
  if (!text) return [];
  const out = [];
  if (fmt === 'json') walkJson(parseJsonLoose(text), out);
  else out.push(...scanTextLines(text));
  // De-duplicate findings produced from nested wrappers (same key+url).
  const seen = new Set();
  return out.filter((f) => {
    if (!f.apiKey && !f.keyEnv && !f.baseUrl) return false;
    const sig = `${f.apiKey || ''}|${f.baseUrl || ''}|${f.keyEnv || ''}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

/**
 * Scan every harness config we can find plus the key vault.
 * @returns {{findings: Array, warnings: string[]}}
 */
export function scanKeys({
  targets = [],
  vaultKeys = [],
  env = process.env,
  resolvePath = null,
  readText = defaultReadText,
} = {}) {
  const findings = [];
  const warnings = [];
  const hook = typeof resolvePath === 'function' ? resolvePath : null;

  for (const target of targets) {
    let path = null;
    try { path = hook ? hook(target) : target.defaultPath({ env }); }
    catch { /* some path helpers need extra env */ }
    if (!path) continue;
    const text = readText(path);
    if (text === null || text === undefined) continue;

    const fmt = /\.ya?ml|\.conf|\.yml$/i.test(path) ? 'yaml' : 'json';
    let rows;
    try { rows = findingsFromConfig(text, fmt); }
    catch (err) { warnings.push(`${target.id}: 解析失败 (${err.message})`); continue; }

    for (const row of rows) {
      findings.push({
        source: target.id,
        sourceLabel: target.label || target.id,
        configFile: basename(path),
        ...row,
      });
    }
  }

  for (const k of vaultKeys || []) {
    findings.push({
      source: 'vault',
      sourceLabel: 'Key 库',
      configFile: 'keys.json',
      name: k.name,
      baseUrl: k.baseUrl,
      apiKey: k.apiKey,
      keyEnv: null,
    });
  }

  return { findings, warnings };
}

/** Group findings into one entry per credential (same key, or same url+env). */
export function groupFindings(findings = []) {
  const groups = new Map();
  for (const f of findings) {
    // A provider definition with a URL but no key and no env reference is not
    // a stored credential — skip it. Only real keys or explicit $ENV references
    // belong in a credential inventory.
    if (!f.apiKey && !f.keyEnv) continue;
    const identity = f.apiKey
      ? `key:${f.apiKey}`
      : `env:${f.baseUrl || ''}|${f.keyEnv || ''}`;
    if (!groups.has(identity)) {
      groups.set(identity, {
        id: identity,
        apiKey: f.apiKey || null,
        keyEnv: f.keyEnv || null,
        baseUrl: f.baseUrl || null,
        names: [],
        platform: f.baseUrl ? hostOf(f.baseUrl) : (f.keyEnv ? '环境变量' : '未知'),
        sources: [],
      });
    }
    const g = groups.get(identity);
    if (f.name && !g.names.includes(f.name)) g.names.push(f.name);
    if (!g.baseUrl && f.baseUrl) { g.baseUrl = f.baseUrl; g.platform = hostOf(f.baseUrl); }
    const src = `${f.sourceLabel}${f.configFile ? ` (${f.configFile})` : ''}`;
    if (!g.sources.includes(src)) g.sources.push(src);
  }
  return [...groups.values()];
}

/**
 * Full inventory pipeline used by both the CLI and the wizard: scan local
 * harness configs + the vault, group by credential, then attach health status.
 *
 * @param {object} opts
 * @param {boolean} [opts.check]    send free GET /models requests (default false)
 * @param {boolean} [opts.force]    ignore a fresh cache
 * @param {number}  [opts.ttlHours] cache TTL
 */
export async function buildInventory({
  check = false,
  force = false,
  ttlHours = DEFAULT_TTL_HOURS,
  timeout = 8000,
  env = process.env,
  requester,
  onProgress = () => {},
} = {}) {
  let vaultKeys = [];
  try { vaultKeys = readVault(vaultPath(env)).keys; } catch { /* corrupt vault → skip with no crash */ }

  const { findings, warnings } = scanKeys({ targets: TARGETS, vaultKeys, env });
  const entries = groupFindings(findings);

  const path = healthPath(env);
  let store;
  try { store = readHealth(path); }
  catch { store = { version: 1, entries: {} }; }

  const opts = { entries, store, path, check, force, ttlHours, timeout, onProgress };
  if (requester) opts.requester = requester;
  await resolveHealth(opts);
  return { entries, warnings, cachePath: path };
}
