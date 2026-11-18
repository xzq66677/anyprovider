/**
 * Zed — `~/.config/zed/settings.json` (Windows: `%APPDATA%\Zed\settings.json`).
 *
 * Two documented provider shapes matter here:
 *
 *   "language_models": {
 *     "openai_compatible":  { "<id>": { "api_url", "available_models": [...] } }
 *     "anthropic_compatible": { "<Name>": { "api_url", "available_models": [...] } }
 *   }
 *
 * Zed deliberately keeps API keys out of settings.json: keys live in the system
 * keychain, or in `<PROVIDER_ID_UPPER_SNAKE>_API_KEY`. We never inline the key —
 * we tell the user which variable to export instead.
 */

import { join } from 'node:path';
import { home, readJsonIfExists, toJson } from './_shared.mjs';

export function zedSettingsPath() {
  if (process.env.ZED_SETTINGS) return process.env.ZED_SETTINGS;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home(), 'AppData', 'Roaming');
    return join(appData, 'Zed', 'settings.json');
  }
  return join(home(), '.config', 'zed', 'settings.json');
}

/** Zed appends its own path, so the URL must stop at the version segment. */
function apiUrlFor(protocol, protocolUrl, baseUrl) {
  if (!protocolUrl) return baseUrl;
  const trimmed = protocolUrl.replace(/\/(chat\/completions|responses|messages)$/, '');
  // Anthropic-compatible providers want the bare origin; the /v1/messages path is added by Zed.
  if (protocol === 'anthropic') return trimmed.replace(/\/v1$/, '');
  return trimmed;
}

const ENV_SUFFIX = '_API_KEY';

export default {
  id: 'zed',
  label: 'Zed',
  homepage: 'https://zed.dev',
  level: 'auto',
  protocols: ['chat', 'responses', 'anthropic'],

  defaultPath: () => zedSettingsPath(),

  plan({ discovery, selected, providerId: id, providerName, baseUrl, path }) {
    const target = path || zedSettingsPath();
    const existing = readJsonIfExists(target);
    if (existing.error) throw new Error(`${target} is not valid JSON (${existing.error}); refusing to touch it`);

    const root = existing.json ?? {};
    root.language_models ??= {};

    const anthropic = discovery.protocol === 'anthropic';
    const bucket = anthropic ? 'anthropic_compatible' : 'openai_compatible';
    const key = anthropic ? providerName : id;
    root.language_models[bucket] ??= {};

    const models = selected.map((model) => {
      const entry = {
        name: model.id,
        display_name: model.id,
        max_tokens: model.contextWindow,
        max_output_tokens: model.maxOutputTokens,
      };

      // Zed sends OpenAI-style reasoning_effort on chat completions. Only claim
      // it when the gateway actually accepted that knob.
      const knob = model.reasoning === undefined ? discovery.providerReasoning : model.reasoning;
      if (!anthropic && knob === 'reasoning_effort') {
        entry.reasoning_effort = 'medium';
      }
      if (anthropic && knob === 'thinking') {
        entry.mode = { type: 'thinking', budget_tokens: Math.min(4096, Math.floor(model.maxOutputTokens / 2)) };
      }
      if (discovery.protocol === 'responses') {
        entry.capabilities = { chat_completions: false };
      }
      return entry;
    });

    root.language_models[bucket][key] = {
      api_url: apiUrlFor(discovery.protocol, discovery.protocolUrl, baseUrl),
      available_models: models,
    };

    // Zed derives the variable name from the provider key: `my-gateway` → MY_GATEWAY_API_KEY.
    const envName = `${String(key).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase()}${ENV_SUFFIX}`;

    return {
      writes: [{ path: target, text: toJson(root), mode: 'merge' }],
      snippet: [
        `# Zed keeps API keys out of settings.json — export the key instead:`,
        process.platform === 'win32' ? `setx ${envName} "${'<your-key>'}"` : `export ${envName}="<your-key>"`,
      ].join('\n'),
      notes: [
        `Zed reads the key from $${envName} (or its keychain via "agent: open settings"). Never paste it into settings.json.`,
        'Restart Zed after editing settings.json.',
      ],
    };
  },
};
