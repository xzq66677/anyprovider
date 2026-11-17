/**
 * Reasoning ("thinking") support is the single most vendor-specific part of an
 * OpenAI-compatible gateway: every one of them invented a different knob.
 *
 * We never trust documentation — we send a one-token request per candidate and
 * keep the first one that does not 400. Order is by how common the knob is in
 * the wild.
 */

export const REASONING_CANDIDATES = {
  chat: [
    { param: 'reasoning_effort', probe: { reasoning_effort: 'low' } },
    { param: 'thinking', probe: { thinking: { type: 'enabled' } } },
    { param: 'reasoning', probe: { reasoning: { effort: 'low' } } },
    { param: 'enable_thinking', probe: { enable_thinking: true } },
    { param: 'chat_template_kwargs', probe: { chat_template_kwargs: { thinking: true } } },
  ],
  responses: [
    { param: 'reasoning', probe: { reasoning: { effort: 'low' } } },
    { param: 'reasoning_effort', probe: { reasoning_effort: 'low' } },
  ],
  anthropic: [
    { param: 'thinking', probe: { thinking: { type: 'enabled', budget_tokens: 1024 } } },
  ],
};

/** Reasoning levels most UIs expose. `none` only makes sense for reasoning_effort. */
export function reasoningLevels(param) {
  if (param === 'reasoning_effort') return ['none', 'low', 'medium', 'high'];
  if (param) return ['low', 'medium', 'high'];
  return [];
}

/**
 * Body patch for a concrete level. Used by adapters that must materialize the
 * mapping (static JSON/YAML harnesses), and by `--explain` output.
 */
export function reasoningPatch(param, level = 'medium', maxOutputTokens = 4096) {
  switch (param) {
    case 'reasoning_effort':
      return { reasoning_effort: level };
    case 'thinking':
      return { thinking: { type: 'enabled', budget_tokens: maxOutputTokens } };
    case 'reasoning':
      return { reasoning: { effort: level } };
    case 'enable_thinking':
      return { enable_thinking: true };
    case 'chat_template_kwargs':
      return { chat_template_kwargs: { thinking: true } };
    default:
      return {};
  }
}

/**
 * Harnesses like ZCode store the mapping as a JS expression string evaluated with
 * `reasoningLevel` and `maxOutputTokens` in scope.
 */
export function reasoningExpression(param) {
  const map = reasoningPatch(param);
  if (!param) return null;
  // Re-render with the variables instead of literal values.
  switch (param) {
    case 'reasoning_effort': return '{"reasoning_effort": reasoningLevel}';
    case 'thinking': return '{"thinking": {"type": "enabled", "budget_tokens": maxOutputTokens}}';
    case 'reasoning': return '{"reasoning": {"effort": reasoningLevel}}';
    case 'enable_thinking': return '{"enable_thinking": true}';
    case 'chat_template_kwargs': return '{"chat_template_kwargs": {"thinking": true}}';
    default: return JSON.stringify(map);
  }
}

/** Where a gateway echoes reasoning back — a strong signal it actually reasons. */
export function reasoningEvidence(protocol, json) {
  const found = [];
  if (!json) return found;

  if (protocol === 'chat') {
    const msg = json.choices?.[0]?.message || {};
    for (const key of ['reasoning_content', 'reasoning', 'reasoning_details', 'thinking', 'thinking_content']) {
      if (msg[key]) found.push(`message.${key}`);
    }
  } else if (protocol === 'anthropic') {
    for (const block of json.content || []) {
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') found.push(`content.${block.type}`);
    }
  } else {
    for (const item of json.output || []) {
      if (item?.type === 'reasoning') found.push('output.reasoning');
    }
  }

  const tokens = json.usage?.completion_tokens_details?.reasoning_tokens
    ?? json.usage?.output_tokens_details?.reasoning_tokens;
  if (typeof tokens === 'number' && tokens > 0) found.push(`reasoning_tokens=${tokens}`);

  return found;
}
