/**
 * Continue (`~/.continue/config.yaml`).
 *
 * YAML lists cannot be appended safely — a stray line silently makes the whole
 * file invalid — so we only generate a full file when none exists. Otherwise we
 * emit a suggestion file next to it and let the user paste the entries.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { home, yamlString } from './_shared.mjs';

export const continueConfigPath = () => join(home(), '.continue', 'config.yaml');

export default {
  id: 'continue',
  label: 'Continue',
  homepage: 'https://continue.dev',
  level: 'snippet',
  protocols: ['chat'],

  defaultPath: () => continueConfigPath(),

  plan({ selected, baseUrl, apiKey, path }) {
    const target = path || continueConfigPath();
    const entries = selected.map((model) => [
      `  - name: ${yamlString(model.id)}`,
      '    provider: openai',
      `    model: ${yamlString(model.id)}`,
      `    apiBase: ${yamlString(baseUrl)}`,
      `    apiKey: ${yamlString(apiKey)}`,
      `    contextLength: ${model.contextWindow}`,
      '    defaultCompletionOptions:',
      `      maxTokens: ${model.maxOutputTokens}`,
    ].join('\n'));

    const body = `models:\n${entries.join('\n')}\n`;
    const exists = existsSync(target);

    return {
      writes: [{ path: target, text: body, mode: exists ? 'suggest' : 'create' }],
      snippet: body,
      notes: exists
        ? [`${target} already exists — the block was written to a suggestion file. Merge the "models:" entries by hand.`]
        : [],
    };
  },
};
