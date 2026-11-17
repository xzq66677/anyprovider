/**
 * opencode — `~/.config/opencode/opencode.json` (or `.jsonc`).
 *
 * Two on-disk shapes exist and we support both:
 *   legacy: { "provider": { id: { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL", "apiKey" }, "models": {...} } } }
 *   current:{ "providers": { id: { "package": "@opencode/ai/providers/openai-compatible", "settings": { "baseURL" }, "env": [...], "models": {...} } } }
 *
 * Which one we write is decided by what the existing file already uses, so a
 * user on either version gets a config their build understands.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { home, parseJsonLoose, readTextIfExists, toJson } from './_shared.mjs';

const PACKAGE = {
  chat: '@opencode/ai/providers/openai-compatible',
  responses: '@opencode/ai/providers/openai-compatible/responses',
  anthropic: '@opencode/ai/providers/anthropic-compatible',
};

const LEGACY_NPM = {
  chat: '@ai-sdk/openai-compatible',
  responses: '@ai-sdk/openai-compatible',
  anthropic: '@ai-sdk/anthropic',
};

export function opencodeConfigPath() {
  if (process.env.OPENCODE_CONFIG) return process.env.OPENCODE_CONFIG;
  const dir = join(home(), '.config', 'opencode');
  const jsonc = join(dir, 'opencode.jsonc');
  const json = join(dir, 'opencode.json');
  if (existsSync(jsonc)) return jsonc;
  return json;
}

const modelsOf = (selected) => Object.fromEntries(
  selected.map((model) => [model.id, { name: model.id, limit: { context: model.contextWindow, output: model.maxOutputTokens } }]),
);

export default {
  id: 'opencode',
  label: 'opencode',
  homepage: 'https://opencode.ai',
  level: 'auto',
  protocols: ['chat', 'responses', 'anthropic'],

  defaultPath: () => opencodeConfigPath(),

  plan({ discovery, selected, providerId: id, providerName, baseUrl, apiKey, path }) {
    const target = path || opencodeConfigPath();
    const text = readTextIfExists(target);
    let root = {};
    try {
      root = text ? parseJsonLoose(text) ?? {} : {};
    } catch (err) {
      throw new Error(`${target} is not valid JSON(C) (${err.message}); refusing to touch it`);
    }

    const notes = [];
    const isLegacy = !!(root.provider && !root.providers);

    if (isLegacy) {
      root.provider ??= {};
      root.provider[id] = {
        npm: LEGACY_NPM[discovery.protocol],
        name: providerName,
        options: { baseURL: baseUrl, apiKey },
        models: modelsOf(selected),
      };
    } else {
      const envName = `${id.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_API_KEY`;
      root.$schema ??= 'https://opencode.ai/config.json';
      root.providers ??= {};
      root.providers[id] = {
        name: providerName,
        env: [envName],
        package: PACKAGE[discovery.protocol],
        settings: { baseURL: baseUrl },
        models: modelsOf(selected),
      };
      notes.push(
        `This opencode config reads the credential from $${envName}; set it before launching opencode:`,
        process.platform === 'win32' ? `  setx ${envName} "${apiKey}"` : `  export ${envName}="${apiKey}"`,
      );
    }

    return {
      writes: [{ path: target, text: toJson(root), mode: 'merge' }],
      snippet: null,
      notes,
    };
  },
};
