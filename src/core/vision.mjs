/**
 * Vision (image input) capability probing.
 *
 * Gateways rarely advertise image support honestly, so we ask the model: a
 * tiny 1x1 PNG is sent through each protocol's native image block. A text-only
 * content-array request is used as the control, so a gateway that rejects all
 * content arrays is reported as "unknown" instead of "no vision".
 *
 * This is best-effort: a gateway that accepts the request but silently drops
 * the image is indistinguishable from one that truly understands it. Any
 * image-token usage echoed back is recorded as stronger evidence.
 */

import { request, errorText, isAuthStatus } from './http.mjs';

/** 1x1 transparent PNG — a few dozen bytes, harmless to send. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
export const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

export const VISION_PROMPT = 'What is in this image? Answer with one word.';

const REJECTION_PATTERNS = [
  /image/i, /vision/i, /multi-?modal/i, /media[_ -]?type/i, /base64/i,
  /input_image/i, /image_url/i,
  /only[ -]?(text|string)/i, /(text|string)[ -]?only/i,
  /unsupported.{0,40}content/i, /content.{0,40}unsupported/i,
  /not support/i, /does not support/i, /invalid.{0,20}content/i,
];

/** Does an error message look like the gateway rejected the image itself? */
export function isVisionRejection(text) {
  const s = String(text || '');
  return REJECTION_PATTERNS.some((re) => re.test(s));
}

/**
 * Build the probe body for a protocol. `withImage: false` is the control —
 * same shape, same text, no image block.
 */
export function visionBody(protocol, model, { withImage = true, tokens = 16 } = {}) {
  const text = VISION_PROMPT;
  if (protocol === 'chat') {
    const content = [{ type: 'text', text }];
    if (withImage) content.push({ type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } });
    return { model, messages: [{ role: 'user', content }], max_tokens: tokens, stream: false };
  }
  if (protocol === 'responses') {
    const content = [{ type: 'input_text', text }];
    if (withImage) content.push({ type: 'input_image', image_url: TINY_PNG_DATA_URL });
    return { model, input: [{ role: 'user', content }], max_output_tokens: tokens, stream: false };
  }
  const content = [{ type: 'text', text }];
  if (withImage) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } });
  }
  return { model, messages: [{ role: 'user', content }], max_tokens: tokens };
}

export function isReplyShaped(protocol, json) {
  if (!json) return false;
  if (protocol === 'chat') return Array.isArray(json.choices);
  if (protocol === 'responses') return Array.isArray(json.output) || json.object === 'response';
  return Array.isArray(json.content) || json.type === 'message';
}

/** Image-token accounting in the response is a stronger signal than a bare 200. */
export function visionEvidence(protocol, json) {
  const found = [];
  if (!json) return found;
  const details = [
    json.usage?.prompt_tokens_details,
    json.usage?.input_tokens_details,
    json.usage?.completion_tokens_details,
    json.usage?.output_tokens_details,
  ];
  for (const d of details) {
    for (const key of ['image_tokens', 'input_image_tokens']) {
      if (typeof d?.[key] === 'number' && d[key] > 0) found.push(`${key}=${d[key]}`);
    }
  }
  if (protocol === 'anthropic') {
    for (const block of json.content || []) {
      if (block?.type === 'image' || block?.type === 'image_url') found.push(`content.${block.type}`);
    }
  }
  return found;
}

const verdict = (supported, status, evidence, reason, probe) =>
  ({ supported, status, evidence, reason, probe });

/**
 * Ask one model whether it accepts an image. Returns
 * `supported: true | false | null` (null = inconclusive).
 */
export async function probeVision({ protocol, url, apiKey, model, timeout }) {
  const image = await request(url, {
    apiKey, mode: protocol, method: 'POST', timeout,
    body: visionBody(protocol, model, { withImage: true }),
  });
  const evidence = visionEvidence(protocol, image.json);
  if (image.ok && isReplyShaped(protocol, image.json)) {
    return verdict(true, image.status, evidence, null, 'image-request');
  }

  const reason = errorText(image, 400);
  if (isVisionRejection(reason)) {
    return verdict(false, image.status, [], reason, 'error-text');
  }

  // The rejection was vague. Did the gateway accept the same array without an
  // image? If yes, the image is what was refused; if no, the format itself is
  // unsupported and we genuinely cannot tell.
  const control = await request(url, {
    apiKey, mode: protocol, method: 'POST', timeout,
    body: visionBody(protocol, model, { withImage: false }),
  });
  if (control.ok && isReplyShaped(protocol, control.json)) {
    return verdict(false, image.status, [], reason || 'image request rejected, text-only accepted', 'control+image');
  }
  if (isAuthStatus(image.status) || isAuthStatus(control.status)) {
    return verdict(null, image.status, [], reason || 'authentication rejected the probe', 'auth');
  }
  return verdict(null, image.status, [], reason || 'inconclusive image probe', 'inconclusive');
}

/** Normalise a probe result into the terse value stored on each model row. */
export const visionLabel = (r) =>
  !r ? null : r.supported === true ? 'yes' : r.supported === false ? 'no' : 'unknown';
