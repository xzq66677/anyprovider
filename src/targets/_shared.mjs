/**
 * Shared helpers for target adapters.
 *
 * An adapter is a pure function set — it never writes files itself, it only
 * returns text. `src/core/apply.mjs` does the writing (with backups).
 *
 * Contract:
 *   {
 *     id, label, homepage, protocols, level,
 *     defaultPath({ env }) -> string,
 *     plan({ discovery, selected, providerId, providerName, baseUrl, apiKey, path, env })
 *       -> { writes: [{ path, text, mode }], snippet, notes }
 *   }
 *
 * mode:
 *   'merge'   — we can merge into an existing file with certainty
 *   'create'  — write only when the file does not exist yet, else suggest
 *   'suggest' — always a sibling suggestion file
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const home = () => homedir();

export function readTextIfExists(path) {
  try {
    if (!existsSync(path)) return null;
    // Windows editors love a UTF-8 BOM; JSON.parse and YAML tooling hate it.
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

export function readJsonIfExists(path) {
  const text = readTextIfExists(path);
  if (text === null) return { json: null, text: null, error: null };
  try {
    return { json: JSON.parse(text), text, error: null };
  } catch (err) {
    return { json: null, text, error: err.message };
  }
}

export const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Strip JSONC-ish comments so a hand-edited opencode.jsonc still parses. */
export function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned);
}

export function yamlString(value) {
  const str = String(value);
  if (/^[A-Za-z0-9_./:@-]+$/.test(str)) return str;
  return JSON.stringify(str);
}

export function providerId(raw, prefix = 'custom') {
  const slug = String(raw)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  return `${prefix}-${slug || 'provider'}`;
}

export function markedBlock(tag, body, comment = '#') {
  return `${comment} >>> anyprovider:${tag} — 由 anyprovider 生成，重跑会整块替换 >>>\n${body}\n${comment} <<< anyprovider:${tag} <<<\n`;
}

/** Replace our marked block if present, otherwise append it. */
export function upsertBlock(text, tag, body, comment = '#') {
  const start = `${comment} >>> anyprovider:${tag}`;
  const end = `${comment} <<< anyprovider:${tag}`;
  const block = markedBlock(tag, body, comment);
  const base = text ?? '';
  const from = base.indexOf(start);
  if (from >= 0) {
    const to = base.indexOf(end, from);
    const stop = to >= 0 ? base.indexOf('\n', to) + 1 : base.length;
    return base.slice(0, from) + block + base.slice(stop);
  }
  return `${base}${base && !base.endsWith('\n') ? '\n' : ''}${base ? '\n' : ''}${block}`;
}

/** Common notes every adapter appends. */
export function baseNotes(discovery) {
  const notes = [];
  if (!discovery.providerReasoning) {
    notes.push('No reasoning knob was accepted by this gateway — models are configured without a reasoning option.');
  }
  if (discovery.models.some((m) => m.sources?.maxOutput === 'default')) {
    notes.push('Some max-output values are defaults because the gateway would not report a ceiling.');
  }
  return notes;
}

export const defaults = {
  registryPath: () => join(home(), '.anyprovider', 'providers.json'),
};
