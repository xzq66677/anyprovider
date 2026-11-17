/**
 * Claude Code — `~/.claude/settings.json`, `env` block.
 *
 * Claude Code only speaks the Anthropic Messages API, so a gateway must expose
 * `/v1/messages` for this target to be useful. If the probe found another
 * protocol we still write the file but say so loudly (a LiteLLM proxy in front
 * of the gateway is the usual fix).
 */

import { join } from 'node:path';
import { home, readJsonIfExists, toJson } from './_shared.mjs';

export const claudeSettingsPath = () => join(home(), '.claude', 'settings.json');

export default {
  id: 'claude-code',
  label: 'Claude Code',
  homepage: 'https://claude.com/claude-code',
  level: 'auto',
  protocols: ['anthropic'],

  defaultPath: () => claudeSettingsPath(),

  plan({ discovery, selected, baseUrl, apiKey, path }) {
    const target = path || claudeSettingsPath();
    const existing = readJsonIfExists(target);
    if (existing.error) throw new Error(`${target} is not valid JSON (${existing.error}); refusing to touch it`);

    const root = existing.json ?? {};
    const [primary, ...rest] = selected;
    const small = rest.find((m) => /haiku|mini|small|flash|lite/i.test(m.id)) || rest[0] || primary;

    root.env = {
      ...(root.env || {}),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: primary.id,
    };
    if (small) root.env.ANTHROPIC_SMALL_FAST_MODEL = small.id;

    const notes = [];
    if (discovery.protocol !== 'anthropic') {
      notes.push(
        `This gateway was detected as "${discovery.protocol}", not anthropic-messages.`,
        'Claude Code can only talk the Anthropic Messages protocol — put a translating proxy in front first, or use a different target.',
      );
    }
    notes.push('Restart any running `claude` session; env values are read at start-up.');

    return { writes: [{ path: target, text: toJson(root), mode: 'merge' }], snippet: null, notes };
  },
};
