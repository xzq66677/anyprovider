/**
 * LiteLLM proxy (`config.yaml`).
 *
 * Useful as a translator: point your coding agent at LiteLLM and LiteLLM at a
 * chat-only gateway, e.g. to give Claude Code an anthropic-messages front door.
 *
 * Same YAML caution as Continue: create when absent, suggest when the file
 * already exists.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { home, yamlString } from './_shared.mjs';

export const litellmConfigPath = () => join(process.cwd(), 'litellm.config.yaml');

const PREFIX = { chat: 'openai', responses: 'openai', anthropic: 'anthropic' };

export default {
  id: 'litellm',
  label: 'LiteLLM',
  homepage: 'https://docs.litellm.ai',
  level: 'snippet',
  protocols: ['chat', 'responses', 'anthropic'],

  defaultPath: () => litellmConfigPath(),

  plan({ discovery, selected, baseUrl, apiKey, path }) {
    const target = path || litellmConfigPath();
    const prefix = PREFIX[discovery.protocol] || 'openai';

    const entries = selected.map((model) => [
      `  - model_name: ${yamlString(model.id)}`,
      '    litellm_params:',
      `      model: ${prefix}/${yamlString(model.id)}`,
      `      api_base: ${yamlString(baseUrl)}`,
      `      api_key: ${yamlString(apiKey)}`,
      `      max_tokens: ${model.maxOutputTokens}`,
    ].join('\n'));

    const body = `model_list:\n${entries.join('\n')}\n`;
    const exists = existsSync(target);

    return {
      writes: [{ path: target, text: body, mode: exists ? 'suggest' : 'create' }],
      snippet: body,
      notes: [
        'Run it with: litellm --config ' + target,
        exists ? 'The file already existed, so the entries went to a suggestion file — merge them into your model_list.' : '',
      ].filter(Boolean),
    };
  },
};
