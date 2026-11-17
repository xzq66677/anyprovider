/**
 * The probe engine: from "I only have an API key and a base URL" to a full,
 * per-model description of what the gateway can actually do.
 *
 * Everything here is learned empirically because gateways lie, docs rot, and
 * `/models` is very often missing or hand-maintained.
 */

import { request, errorText, numbersAbove, isAuthStatus } from './http.mjs';
import { endpointCandidates, normalizeBase, PROTOCOLS, PROTOCOL_FORMATS } from './endpoints.mjs';
import { REASONING_CANDIDATES, reasoningEvidence } from './reasoning.mjs';

export const DEFAULTS = {
  contextWindow: 128_000,
  maxOutputTokens: 32_000,
  sample: 3,
  concurrency: 4,
  timeout: 30_000,
  /** Deliberately absurd, so the gateway's own 400 tells us the real ceiling. */
  overshoot: 1_000_000,
  prompt: 'What is 17 times 19? Answer with the number only.',
};

const noop = () => {};

export function modelListFrom(json) {
  if (!json) return [];
  const list = Array.isArray(json.data) ? json.data
    : Array.isArray(json.models) ? json.models
      : Array.isArray(json) ? json
        : [];
  return list
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && typeof m.id === 'string' && m.id.trim())
    .map((m) => ({ ...m, id: m.id.trim() }));
}

export const contextWindowOf = (m) =>
  m?.context_length ?? m?.context_window ?? m?.max_context_length
  ?? m?.max_model_len ?? m?.top_provider?.context_length ?? null;

export const maxOutputOf = (m) =>
  m?.max_completion_tokens ?? m?.max_output_tokens ?? m?.max_tokens
  ?? m?.top_provider?.max_completion_tokens ?? null;

function bodyFor(protocol, model, extra = {}, tokens = 64) {
  const prompt = DEFAULTS.prompt;
  if (protocol === 'chat') {
    return { model, messages: [{ role: 'user', content: prompt }], max_tokens: tokens, stream: false, ...extra };
  }
  if (protocol === 'responses') {
    return { model, input: prompt, max_output_tokens: tokens, stream: false, ...extra };
  }
  return { model, max_tokens: tokens, messages: [{ role: 'user', content: prompt }], ...extra };
}

function looksLikeReply(protocol, res) {
  if (!res.ok || !res.json) return false;
  if (protocol === 'chat') return Array.isArray(res.json.choices) || !!res.json.object?.includes?.('completion');
  if (protocol === 'responses') return Array.isArray(res.json.output) || res.json.object === 'response';
  return Array.isArray(res.json.content) || res.json.type === 'message';
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Find the model list. Returns the first candidate that answers 200 with a list.
 * A 401/403 aborts immediately — a wrong key should not be retried 6 times.
 */
async function fetchModels({ endpoints, apiKey, timeout, onEvent }) {
  const attempts = [];
  for (const url of endpoints.models) {
    const res = await request(url, { apiKey, timeout });
    attempts.push({ url, status: res.status, error: res.ok ? null : errorText(res, 160) });
    if (isAuthStatus(res.status)) {
      return { models: [], authError: `${errorText(res, 200)}`, attempts, authStatus: res.status };
    }
    if (res.ok) {
      const models = modelListFrom(res.json);
      if (models.length) {
        onEvent('models', { url, count: models.length });
        return { models, url, attempts, authError: null };
      }
    }
  }
  onEvent('models-none', { attempts });
  return { models: [], url: null, attempts, authError: null };
}

/** Try chat → responses → anthropic, first 200 wins. */
async function detectProtocol({ endpoints, apiKey, model, protocols, timeout, onEvent }) {
  const order = protocols?.length ? protocols.filter((p) => PROTOCOLS.includes(p)) : PROTOCOLS;
  const attempts = [];
  for (const protocol of order) {
    for (const url of endpoints[protocol]) {
      const res = await request(url, {
        apiKey,
        mode: protocol,
        method: 'POST',
        timeout,
        body: bodyFor(protocol, model, {}, protocol === 'responses' ? 32 : 64),
      });
      const ok = looksLikeReply(protocol, res);
      attempts.push({ protocol, url, status: res.status, ok, error: ok ? null : errorText(res, 160) });
      onEvent('protocol-attempt', attempts[attempts.length - 1]);
      if (isAuthStatus(res.status)) {
        return { protocol: null, url: null, attempts, authError: errorText(res, 200), authStatus: res.status };
      }
      if (ok) {
        return { protocol, url, attempts, format: PROTOCOL_FORMATS[protocol], authError: null };
      }
    }
  }
  return { protocol: null, url: null, attempts, authError: null };
}

/** Send one request per candidate knob until one is accepted. */
async function probeReasoning({ protocol, url, apiKey, model, timeout }) {
  const baseline = await request(url, { apiKey, mode: protocol, method: 'POST', timeout, body: bodyFor(protocol, model, {}, 512) });
  if (!baseline.ok) {
    return { param: null, evidence: [], error: errorText(baseline, 200), baselineOk: false };
  }
  const baseEvidence = reasoningEvidence(protocol, baseline.json);

  for (const candidate of REASONING_CANDIDATES[protocol] || []) {
    const res = await request(url, {
      apiKey,
      mode: protocol,
      method: 'POST',
      timeout,
      body: bodyFor(protocol, model, candidate.probe, 512),
    });
    if (res.ok) {
      const evidence = reasoningEvidence(protocol, res.json);
      return {
        param: candidate.param,
        evidence: evidence.length ? evidence : baseEvidence,
        baselineEvidence: baseEvidence,
        // Accepted but no reasoning payload: the knob is ignored, not honoured.
        silent: evidence.length === 0 && baseEvidence.length === 0,
        baselineOk: true,
      };
    }
  }
  return { param: null, evidence: baseEvidence, baselineOk: true };
}

/** Overshoot on purpose; the 400 message usually contains the true ceiling. */
async function probeMaxOutput({ protocol, url, apiKey, model, timeout, overshoot }) {
  const big = protocol === 'responses'
    ? { max_output_tokens: overshoot }
    : { max_tokens: overshoot };
  const res = await request(url, {
    apiKey,
    mode: protocol,
    method: 'POST',
    timeout,
    body: bodyFor(protocol, model, big, overshoot),
  });
  if (res.ok || isAuthStatus(res.status)) return null;
  const numbers = numbersAbove(errorText(res, 1000)).filter((n) => n < overshoot);
  return numbers.length ? Math.max(...numbers) : null;
}

/**
 * Main entry point.
 *
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.apiKey
 * @param {string[]} [options.modelIds]   manual IDs when /models is missing
 * @param {string[]} [options.protocols]  restrict / reorder protocol detection
 * @param {number}   [options.sample]     how many models get a reasoning probe
 * @param {boolean}  [options.deep]       probe *every* model individually
 * @param {number}   [options.concurrency]
 * @param {number}   [options.timeout]
 * @param {object}   [options.defaults]   {contextWindow, maxOutputTokens}
 * @param {(kind: string, payload: any) => void} [options.onEvent]
 */
export async function discover(options) {
  const {
    apiKey,
    modelIds = [],
    protocols,
    sample = DEFAULTS.sample,
    deep = false,
    concurrency = DEFAULTS.concurrency,
    timeout = DEFAULTS.timeout,
    onEvent = noop,
  } = options;

  if (!apiKey) throw new Error('apiKey is required');
  const baseUrl = normalizeBase(options.baseUrl);
  const defaults = { ...DEFAULTS };
  for (const key of ['contextWindow', 'maxOutputTokens', 'timeout', 'overshoot', 'prompt', 'concurrency', 'sample']) {
    const value = options.defaults?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) defaults[key] = value;
  }
  const endpoints = endpointCandidates(baseUrl);

  const notes = [];
  const result = {
    baseUrl,
    endpoints,
    modelsEndpoint: null,
    protocol: null,
    protocolUrl: null,
    format: null,
    authError: null,
    models: [],
    providerReasoning: null,
    reasoningVotes: {},
    notes,
    attempts: {},
  };

  /* 1. model list ------------------------------------------------------- */
  const list = await fetchModels({ endpoints, apiKey, timeout, onEvent });
  result.modelsEndpoint = list.url || null;
  result.attempts.models = list.attempts;
  if (list.authError) {
    result.authError = list.authError;
    notes.push(`Key rejected by every /models candidate (HTTP ${list.authStatus}).`);
    return result;
  }

  let models = list.models;
  if (modelIds.length) {
    const wanted = [...new Set(modelIds.map((s) => s.trim()).filter(Boolean))];
    const missing = wanted.filter((id) => !models.some((m) => m.id === id));
    models = wanted.map((id) => models.find((m) => m.id === id) || { id, manual: true });
    if (missing.length) notes.push(`Not advertised by /models, imported as given: ${missing.join(', ')}`);
  } else if (!models.length) {
    notes.push('This gateway exposes no /models list — pass model IDs explicitly (--model id1,id2).');
    return result;
  }
  if (!models.length) return result;

  /* 2. protocol --------------------------------------------------------- */
  const probeModel = models.find((m) => !m.manual)?.id || models[0].id;
  const detected = await detectProtocol({ endpoints, apiKey, model: probeModel, protocols, timeout, onEvent });
  result.attempts.protocol = detected.attempts;
  if (detected.authError) {
    result.authError = detected.authError;
    notes.push(`Key rejected on completion endpoints: ${detected.authError}`);
    return result;
  }
  if (!detected.protocol) {
    const statuses = [...new Set(detected.attempts.map((a) => a.status))].join('/');
    notes.push(`No protocol answered (statuses tried: ${statuses}). Check the base URL and that the key has model access.`);
    return result;
  }
  result.protocol = detected.protocol;
  result.protocolUrl = detected.url;
  result.format = detected.format;

  /* 3. reasoning -------------------------------------------------------- */
  const probeable = models.filter((m) => !m.manual);
  const picks = deep
    ? probeable
    : [...probeable]
      .sort((a, b) => (contextWindowOf(a) ? 1 : 0) - (contextWindowOf(b) ? 1 : 0))
      .slice(0, Math.max(0, sample));

  const sampled = new Map();
  if (picks.length) {
    const results = await mapLimit(picks, Math.min(concurrency, 3), async (m) => {
      const r = await probeReasoning({ protocol: result.protocol, url: result.protocolUrl, apiKey, model: m.id, timeout });
      onEvent('reasoning', { model: m.id, ...r });
      return r;
    });
    picks.forEach((m, i) => sampled.set(m.id, results[i]));

    const votes = {};
    for (const r of results) if (r.param) votes[r.param] = (votes[r.param] || 0) + 1;
    result.reasoningVotes = votes;
    const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    result.providerReasoning = winner ? winner[0] : null;
  }

  /* 4. per-model parameters --------------------------------------------- */
  let sharedMaxOutput = null;
  let sharedMaxOutputSource = null;

  const rows = await mapLimit(models, concurrency, async (m) => {
    const row = {
      id: m.id,
      contextWindow: contextWindowOf(m) || defaults.contextWindow,
      maxOutputTokens: maxOutputOf(m) || null,
      sources: {
        context: contextWindowOf(m) ? 'model-list' : 'default',
        maxOutput: maxOutputOf(m) ? 'model-list' : null,
      },
      probe: sampled.get(m.id) || null,
      manual: !!m.manual,
    };

    if (deep && !m.manual) {
      if (!row.probe) {
        row.probe = await probeReasoning({ protocol: result.protocol, url: result.protocolUrl, apiKey, model: m.id, timeout });
        onEvent('reasoning', { model: m.id, ...row.probe });
      }
      if (!row.maxOutputTokens) {
        const ceiling = await probeMaxOutput({
          protocol: result.protocol, url: result.protocolUrl, apiKey, model: m.id, timeout, overshoot: defaults.overshoot,
        });
        if (ceiling) {
          row.maxOutputTokens = ceiling;
          row.sources.maxOutput = 'probe';
        }
      }
    }
    return row;
  });

  // One overshoot for everything still missing a ceiling — same gateway, same cap.
  const lacking = rows.filter((r) => !r.maxOutputTokens);
  if (lacking.length) {
    const target = lacking.find((r) => r.id === probeModel) || lacking[0];
    sharedMaxOutput = await probeMaxOutput({
      protocol: result.protocol, url: result.protocolUrl, apiKey, model: target.id, timeout, overshoot: defaults.overshoot,
    });
    sharedMaxOutputSource = sharedMaxOutput ? 'probe' : 'default';
    onEvent('max-output', { model: target.id, ceiling: sharedMaxOutput, appliesTo: lacking.length });
  }

  for (const row of rows) {
    if (!row.maxOutputTokens) {
      row.maxOutputTokens = sharedMaxOutput || defaults.maxOutputTokens;
      row.sources.maxOutput = sharedMaxOutputSource || 'default';
    }
    // A model we actually asked and that rejected every knob really has no
    // reasoning support — it must NOT inherit the provider-wide winner.
    // Models we never touched (or whose baseline call failed) inherit it.
    const probed = !!row.probe && !row.probe.error;
    row.reasoning = probed ? row.probe.param : result.providerReasoning;
    row.probed = probed;
    row.reasoningEvidence = row.probe?.evidence || [];
    if (row.probe?.error) row.probeError = row.probe.error;
  }

  result.models = rows;
  if (rows.some((r) => r.sources.maxOutput === 'default')) {
    notes.push(`Max output could not be probed for some models; using ${defaults.maxOutputTokens}.`);
  }
  if (rows.some((r) => r.sources.maxOutput === 'probe')) {
    notes.push('Max output values marked "probe" come from the gateway\'s own 400 error message.');
  }
  if (!picks.length && !deep) {
    notes.push('Reasoning probing was skipped, so no reasoning option was configured. Re-run without --sample 0 to detect it.');
  } else if (!result.providerReasoning) {
    notes.push('No reasoning knob was accepted — models get no reasoning option.');
  }

  return result;
}
