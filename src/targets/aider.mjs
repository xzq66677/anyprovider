/**
 * aider (`~/.aider.conf.yml` + env fallbacks).
 *
 * aider is a single-model CLI, so it gets the first selected model; the rest
 * are listed as `--model` alternatives in the notes.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { home, yamlString } from './_shared.mjs';

export const aiderConfigPath = () => join(home(), '.aider.conf.yml');

export default {
  id: 'aider',
  label: 'aider',
  homepage: 'https://aider.chat',
  level: 'snippet',
  protocols: ['chat'],

  defaultPath: () => aiderConfigPath(),

  plan({ selected, baseUrl, apiKey, path }) {
    const target = path || aiderConfigPath();
    const [primary] = selected;

    const body = [
      `openai-api-base: ${yamlString(baseUrl)}`,
      `openai-api-key: ${yamlString(apiKey)}`,
      `model: ${yamlString(`openai/${primary.id}`)}`,
      `weak-model: ${yamlString(`openai/${selected[1]?.id || primary.id}`)}`,
    ].join('\n') + '\n';

    const exists = existsSync(target);

    return {
      writes: [{ path: target, text: body, mode: exists ? 'suggest' : 'create' }],
      snippet: body,
      notes: [
        `Primary model: openai/${primary.id}. Others: ${selected.slice(1).map((m) => `--model openai/${m.id}`).join(', ') || 'none'}`,
        exists ? 'An aider config already existed, so the values went to a suggestion file — copy the keys you need.' : '',
      ].filter(Boolean),
    };
  },
};
