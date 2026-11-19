/**
 * Cheap API-key health checks.
 *
 * Cost matters, so we never send a completion here. A `GET /models` request
 * only authenticates and lists models — on virtually every gateway it is free
 * (no tokens are generated). Status mapping:
 *   2xx with a model list -> valid
 *   401 / 403            -> invalid (the key was rejected)
 *   429                  -> valid-but-rate-limited (the key was recognised)
 *   anything else / net  -> unknown (don't guess)
 *
 * Results are cached to ~/.anyprovider/key-health.json with a timestamp and a
 * TTL (default 24h). Nothing is sent unless the caller explicitly asks for a
 * check; a plain status view only reads the cache.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { endpointCandidates } from './endpoints.mjs';
import { request } from './http.mjs';

export const HEALTH_VERSION = 1;
export const DEFAULT_TTL_HOURS = 24;

export function healthPath(env = process.env) {
  return join(env.ANYPROVIDER_HOME || homedir(), '.anyprovider', 'key-health.json');
}

export function readHealth(path = healthPath()) {
  if (!existsSync(path)) return { version: HEALTH_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
      throw new Error('bad structure');
    }
    return { version: parsed.version || HEALTH_VERSION, entries: parsed.entries };
  } catch (err) {
    throw new Error(`Key 健康缓存 ${path} 损坏（${err.message}）；为避免误判已停止操作`);
  }
}

export function writeHealth(store, path = healthPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* unsupported fs */ }
  return path;
}

/** Stable cache key: base URL + key fingerprint (never store the raw key). */
export function healthKey(baseUrl, apiKey) {
  let hash = 0;
  const s = `${baseUrl || ''}|${apiKey || ''}`;
  for (let i = 0; i < s.length; i += 1) { hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0; }
  return `${(hash >>> 0).toString(16)}-${s.length}`;
}

export function isFresh(entry, ttlHours = DEFAULT_TTL_HOURS, now = Date.now()) {
  if (!entry || !entry.checkedAt) return false;
  const age = now - new Date(entry.checkedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < ttlHours * 3600_000;
}

/**
 * Probe one credential via GET /models across candidate URLs.
 * @param {{baseUrl:string, apiKey:string, mode?:string, timeout?:number, requester?:Function}} args
 */
export async function probeHealth({ baseUrl, apiKey, mode = 'chat', timeout = 8000, requester = request }) {
  if (!baseUrl || !apiKey) return { status: 'unknown', detail: '缺少地址或 Key', checkedAt: new Date().toISOString() };
  const urls = endpointCandidates(baseUrl).models.slice(0, 3);
  let sawAuth = false;
  let lastDetail = '';
  for (const url of urls) {
    const res = await requester(url, { apiKey, mode, method: 'GET', timeout });
    if (res.status === 401 || res.status === 403) { sawAuth = true; lastDetail = `HTTP ${res.status}`; continue; }
    if (res.status === 200) {
      const count = Array.isArray(res.json?.data) ? res.json.data.length
        : Array.isArray(res.json?.models) ? res.json.models.length
          : Array.isArray(res.json) ? res.json.length : null;
      return {
        status: 'valid',
        detail: count === null ? 'GET /models 返回 200（鉴权通过）' : `列出 ${count} 个模型`,
        checkedAt: new Date().toISOString(),
        modelCount: count,
      };
    }
    if (res.status === 429) {
      return { status: 'valid', detail: 'Key 被识别，但触发限流 (429)', checkedAt: new Date().toISOString() };
    }
    if (res.status > 0) lastDetail = `HTTP ${res.status}`;
    else lastDetail = res.text ? String(res.text).slice(0, 80) : '网络错误';
  }
  return {
    status: sawAuth ? 'invalid' : 'unknown',
    detail: sawAuth ? `鉴权被拒 (${lastDetail})` : (lastDetail || '无法连接网关'),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Resolve statuses for a list of entries, using cache unless `force`.
 * `check` gates all network activity — without it, only cached results appear.
 * Mutates and returns the store.
 */
export async function resolveHealth({
  entries,
  store,
  path = healthPath(),
  check = false,
  force = false,
  ttlHours = DEFAULT_TTL_HOURS,
  timeout = 8000,
  requester = request,
  onProgress = () => {},
} = {}) {
  const tasks = [];
  for (const e of entries) {
    if (!e.apiKey) {
      e.health = { status: 'env', detail: e.keyEnv ? `Key 存放在环境变量 ${e.keyEnv}，无法从配置文件读取` : '未找到明文 Key', checkedAt: null };
      continue;
    }
    const ck = healthKey(e.baseUrl, e.apiKey);
    const cached = store.entries[ck];
    if (!check) {
      e.health = cached
        ? { ...cached, stale: !isFresh(cached, ttlHours) }
        : { status: 'unchecked', detail: '未检测（加 --check 只发免费的列模型请求）', checkedAt: null };
      continue;
    }
    if (!force && isFresh(cached, ttlHours)) {
      e.health = { ...cached, stale: false, cached: true };
      onProgress('cached', e);
      continue;
    }
    tasks.push({ e, ck });
  }

  for (const { e, ck } of tasks) {
    const result = await probeHealth({ baseUrl: e.baseUrl, apiKey: e.apiKey, timeout, requester });
    store.entries[ck] = result;
    e.health = { ...result, cached: false };
    onProgress('checked', e);
  }
  if (tasks.length) writeHealth(store, path);
  return store;
}
