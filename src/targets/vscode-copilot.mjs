/**
 * VS Code Copilot — `chatLanguageModels.json` (user data folder).
 *
 * The old `github.copilot.chat.customOAIModels` setting is deprecated; current
 * VS Code uses a `Custom Endpoint` provider (`vendor: "customendpoint"`) stored
 * in this JSON file, and supports three API types per provider *or* per model:
 * `chat-completions`, `responses`, `messages`.
 *
 * Notes that shape the output:
 *  - `url` should be the full endpoint including the API path; VS Code appends
 *    it otherwise, and an explicit one is unambiguous.
 *  - `maxInputTokens` + `maxOutputTokens` must not exceed the context window, and
 *    VS Code treats their sum as the context size — so input gets the remainder.
 *  - A model without `toolCalling: true` is not offered to agents.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { home, readJsonIfExists, toJson } from './_shared.mjs';

export function vscodeChatModelsPath() {
  if (process.env.VSCODE_CHAT_MODELS) return process.env.VSCODE_CHAT_MODELS;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home(), 'AppData', 'Roaming');
    const insiders = join(appData, 'Code - Insiders', 'User', 'chatLanguageModels.json');
    const stable = join(appData, 'Code', 'User', 'chatLanguageModels.json');
    if (!existsSync(stable) && existsSync(insiders)) return insiders;
    return stable;
  }
  if (process.platform === 'darwin') {
    return join(home(), 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json');
  }
  return join(home(), '.config', 'Code', 'User', 'chatLanguageModels.json');
}

const API_TYPE = {
  chat: 'chat-completions',
  responses: 'responses',
  anthropic: 'messages',
};

const EFFORT_FORMAT = {
  chat: 'chat-completions',
  responses: 'responses',
  anthropic: 'messages',
};

/** VS Code accepts only these levels in supportsReasoningEffort. */
const VSCODE_EFFORTS = ['minimal', 'low', 'medium', 'high'];

export default {
  id: 'vscode-copilot',
  label: 'VS Code Copilot',
  homepage: 'https://code.visualstudio.com/docs/copilot',
  level: 'auto',
  protocols: ['chat', 'responses', 'anthropic'],

  defaultPath: () => vscodeChatModelsPath(),

  plan({ discovery, selected, providerName, baseUrl, apiKey, path }) {
    const target = path || vscodeChatModelsPath();
    const existing = readJsonIfExists(target);
    if (existing.error) throw new Error(`${target} is not valid JSON (${existing.error}); refusing to touch it`);

    const providers = Array.isArray(existing.json) ? existing.json : [];
    const apiType = API_TYPE[discovery.protocol];

    const models = selected.map((model) => {
      const entry = {
        id: model.id,
        name: model.id,
        // Prefer the exact URL the probe proved works; it already contains the API path.
        url: discovery.protocolUrl || baseUrl,
        apiType,
        toolCalling: true,
        vision: false,
        maxInputTokens: Math.max(0, model.contextWindow - model.maxOutputTokens),
        maxOutputTokens: model.maxOutputTokens,
      };

      const knob = model.reasoning === undefined ? discovery.providerReasoning : model.reasoning;
      if (knob) {
        entry.thinking = true;
        const levels = discovery.protocol === 'anthropic'
          ? ['low', 'medium', 'high']
          : VSCODE_EFFORTS;
        entry.supportsReasoningEffort = levels;
        entry.reasoningEffortFormat = EFFORT_FORMAT[discovery.protocol];
      }
      return entry;
    });

    const provider = {
      name: providerName,
      vendor: 'customendpoint',
      apiKey,
      apiType,
      // `url` at provider level would make VS Code discover models instead of
      // using our verified list, so it stays on the model entries.
      models,
    };

    const filtered = providers.filter((p) => p?.name !== providerName);
    const merged = [...filtered, provider];

    return {
      writes: [{ path: target, text: toJson(merged), mode: 'merge' }],
      snippet: null,
      notes: [
        `Open the model picker → Manage Models, or run "Chat: Manage Language Models" to confirm "${providerName}" loaded.`,
        'This file stores the key in plaintext, like the rest of VS Code user data.',
        'Other providers already in the file are preserved.',
      ],
    };
  },
};
