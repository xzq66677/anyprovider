/**
 * Local API key vault.
 *
 * A key is reusable: save it once with a name and a base URL, then pick it in
 * the wizard and import it into as many harnesses as you like. Stored next to
 * the discovery registry under ~/.anyprovider/keys.json.
 *
 * The file contains plaintext keys (same convention as providers.json). Writes
 * are atomic, timestamped backups are kept, and permissions are tightened on
 * both the file and its backup where the OS supports it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const VAULT_VERSION = 1;

/** `ANYPROVIDER_HOME` lets tests and power users relocate the whole folder. */
export function vaultPath(env = process.env) {
  return join(env.ANYPROVIDER_HOME || homedir(), '.anyprovider', 'keys.json');
}

export function readVault(path = vaultPath()) {
  if (!existsSync(path)) return { version: VAULT_VERSION, keys: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Key 库 ${path} 不是合法 JSON（${err.message}）；为避免丢数据，已停止操作`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.keys)) {
    throw new Error(`Key 库 ${path} 结构不合法（缺少 keys 数组）；为避免丢数据，已停止操作`);
  }
  return { version: parsed.version || VAULT_VERSION, keys: parsed.keys };
}

function tighten(path) {
  try { chmodSync(path, 0o600); } catch { /* not supported on this filesystem */ }
}

export function writeVault(store, path = vaultPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  const backup = existed ? `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}` : null;
  if (backup) writeFileSync(backup, readFileSync(path));

  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  tighten(path);
  if (backup) tighten(backup);
  return { path, backup };
}

/** Resolve a 1-based index, an id, or an exact (case-insensitive) alias. */
export function resolveKey(ref, store) {
  const text = String(ref ?? '').trim();
  if (/^\d+$/.test(text)) {
    const key = store.keys[Number(text) - 1];
    if (!key) throw new Error(`Key 库里没有第 ${text} 项`);
    return key;
  }
  const key = store.keys.find((k) => k.id === text || k.name.toLowerCase() === text.toLowerCase());
  if (!key) throw new Error(`Key 库里找不到「${text}」`);
  return key;
}

function validName(name, store, exceptId = null) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('名字不能为空');
  if (store.keys.some((k) => k.id !== exceptId && k.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`已存在同名 Key「${clean}」`);
  }
  return clean;
}

export function addKey({ name, baseUrl, apiKey }, path = vaultPath()) {
  const store = readVault(path);
  const cleanName = validName(name, store);
  const url = String(baseUrl ?? '').trim();
  const key = String(apiKey ?? '').trim();
  if (!url) throw new Error('地址不能为空');
  if (!key) throw new Error('Key 不能为空');

  const now = new Date().toISOString();
  const entry = {
    id: randomUUID().slice(0, 8),
    name: cleanName,
    baseUrl: url,
    apiKey: key,
    createdAt: now,
    updatedAt: now,
  };
  store.keys.push(entry);
  writeVault(store, path);
  return entry;
}

export function renameKey(ref, newName, path = vaultPath()) {
  const store = readVault(path);
  const target = resolveKey(ref, store);
  target.name = validName(newName, store, target.id);
  target.updatedAt = new Date().toISOString();
  writeVault(store, path);
  return target;
}

export function removeKey(ref, path = vaultPath()) {
  const store = readVault(path);
  const target = resolveKey(ref, store);
  store.keys = store.keys.filter((k) => k.id !== target.id);
  writeVault(store, path);
  return target;
}
