/**
 * Endpoint discovery for unknown gateways.
 *
 * Base URLs arrive in every shape imaginable:
 *   https://api.x.com            → /v1/chat/completions
 *   https://api.x.com/v1         → /v1/chat/completions
 *   https://api.x.com/v1/        → same
 *   https://x.com/openai/v1      → /openai/v1/chat/completions
 *   https://x.com/v1beta         → /v1beta/chat/completions
 *
 * Instead of guessing, we build a small ordered candidate list and let the
 * probe decide empirically (a 200 wins, everything else is ignored).
 */

export const PROTOCOLS = ['chat', 'responses', 'anthropic'];

/** Protocol id → the value harnesses usually store in their config. */
export const PROTOCOL_FORMATS = {
  chat: 'openai-chat-completions',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
};

const SUFFIX = {
  chat: '/chat/completions',
  responses: '/responses',
  anthropic: '/messages',
  models: '/models',
};

export function stripTrailingSlashes(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** Add a scheme if the user typed a bare host. */
export function normalizeBase(raw) {
  let url = String(raw || '').trim();
  if (!url) throw new Error('base URL is required');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    // Validate early so the wizard fails fast instead of probing nonsense.
    new URL(url);
  } catch {
    throw new Error(`invalid base URL: ${raw}`);
  }
  return stripTrailingSlashes(url);
}

/**
 * Version-ish roots to try, most likely first.
 * `/v1` is by far the most common, `v1beta` shows up on Google-backed gateways.
 */
export function baseVariants(baseUrl) {
  const b = stripTrailingSlashes(baseUrl);
  const out = [b];
  // Strip one trailing version/namespace segment: /v1, /v1beta, /openai/v1, /api/v1, /compatible-mode/v1
  const versionish = b.match(/\/(v\d+[a-z]*|openai|api|compatible-mode)(\/v\d+[a-z]*)?$/i);
  if (versionish) out.push(b.slice(0, -versionish[0].length));
  else out.push(`${b}/v1`);
  return [...new Set(out.filter(Boolean))];
}

/**
 * Ordered candidate URLs per protocol.
 * @returns {{chat: string[], responses: string[], anthropic: string[], models: string[]}}
 */
export function endpointCandidates(baseUrl) {
  const bases = baseVariants(baseUrl);
  const build = (suffix) => {
    const urls = [];
    for (const b of bases) {
      // A base that already ends in /v1 must not become /v1/v1/...
      urls.push(`${b}${suffix}`);
      if (!/\/v\d+(beta)?$/.test(b)) urls.push(`${b}/v1${suffix}`);
    }
    return [...new Set(urls)];
  };
  return {
    chat: build(SUFFIX.chat),
    responses: build(SUFFIX.responses),
    anthropic: build(SUFFIX.anthropic),
    models: build(SUFFIX.models),
  };
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return 'api'; }
}

/** Stable provider id from a host: https://api.deep.example.com/v1 → deep-example-com */
export function providerIdFromHost(url, prefix = 'custom') {
  const host = hostOf(url).replace(/:\d+$/, '').replace(/^www\./, '');
  const slug = host.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${prefix}-${slug}`.slice(0, 40);
}
