/**
 * Cline / Roo Code (VS Code extensions) — user settings.json.
 *
 * Both read their settings from the VS Code user settings file, using flat
 * `cline.*` keys. Any other VS Code settings present are preserved.
 */

import { join } from 'node:path';
import { home, readJsonIfExists, toJson } from './_shared.mjs';

export function vscodeSettingsPath() {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || join(home(), 'AppData', 'Roaming');
    return join(appData, 'Code', 'User', 'settings.json');
  }
  if (platform === 'darwin') return join(home(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  return join(home(), '.config', 'Code', 'User', 'settings.json');
}

/** VS Code allows comments and trailing commas in settings.json. */
function parseSettings(text) {
  if (!text) return {};
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned);
}

export default {
  id: 'cline',
  label: 'Cline / Roo Code',
  homepage: 'https://cline.bot',
  level: 'auto',
  protocols: ['chat'],

  defaultPath: () => vscodeSettingsPath(),

  plan({ selected, baseUrl, apiKey, path }) {
    const target = path || vscodeSettingsPath();
    const existing = readJsonIfExists(target);
    let root;
    try {
      root = parseSettings(existing.text);
    } catch (err) {
      throw new Error(`${target} is not valid JSON(C) (${err.message}); refusing to touch it`);
    }

    const [primary] = selected;
    root['cline.apiProvider'] = 'openai';
    root['cline.openAiBaseUrl'] = baseUrl;
    root['cline.openAiApiKey'] = apiKey;
    root['cline.openAiModelId'] = primary.id;

    // Roo Code mirrors Cline's keys under its own prefix.
    root['roo-cline.apiProvider'] = 'openai';
    root['roo-cline.openAiBaseUrl'] = baseUrl;
    root['roo-cline.openAiApiKey'] = apiKey;
    root['roo-cline.openAiModelId'] = primary.id;

    return {
      writes: [{ path: target, text: toJson(root), mode: 'merge' }],
      snippet: null,
      notes: [
        `Only "${primary.id}" is set as the active model — switch models inside the extension panel.`,
        'Reload the VS Code window for the extension to pick up new settings.',
      ],
    };
  },
};
