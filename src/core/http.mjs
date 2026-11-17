/**
 * Tiny fetch wrapper: one place for auth headers, timeouts and error extraction.
 * No dependencies — Node 18+ global fetch only.
 */

export const DEFAULT_TIMEOUT = 30_000;

/**
 * @param {string} url
 * @param {{apiKey?: string, mode?: 'chat'|'responses'|'anthropic', method?: string, body?: unknown, timeout?: number}} opts
 * @returns {Promise<{status:number, ok:boolean, json:any, text:string, ms:number}>}
 */
export async function request(url, opts = {}) {
  const { apiKey, mode = 'chat', method = 'GET', body, timeout = DEFAULT_TIMEOUT } = opts;
  const headers = { 'content-type': 'application/json' };

  if (mode === 'anthropic') {
    // Anthropic-native endpoints use x-api-key, and OpenAI-compatible gateways that
    // expose /v1/messages usually accept either; sending both is harmless.
    if (apiKey) { headers['x-api-key'] = apiKey; headers.authorization = `Bearer ${apiKey}`; }
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json — keep raw text */ }
    return { status: res.status, ok: res.ok, json, text, ms: Date.now() - started };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      status: 0,
      ok: false,
      json: null,
      text: aborted ? `timeout after ${timeout}ms` : `network error: ${err?.message || err}`,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort human message out of an error response. */
export function errorText(res, max = 300) {
  if (!res) return 'no response';
  const candidates = [
    res.json?.error?.message,
    res.json?.error?.msg,
    res.json?.message,
    res.json?.msg,
    res.json?.detail,
    typeof res.json?.error === 'string' ? res.json.error : null,
  ].filter((v) => typeof v === 'string' && v.trim());
  const text = candidates[0] || res.text || `HTTP ${res.status}`;
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Pull every plausible token-cap number out of an overshoot error message. */
export function numbersAbove(text, min = 1000) {
  return (String(text).match(/\d[\d,_]{2,}/g) || [])
    .map((n) => Number(n.replace(/[,_]/g, '')))
    .filter((n) => Number.isFinite(n) && n >= min);
}

export const isAuthStatus = (status) => status === 401 || status === 403;
export const isRateLimit = (status) => status === 429;
