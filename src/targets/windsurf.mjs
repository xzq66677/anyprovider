/**
 * Windsurf / Devin Desktop — **no config file exists**.
 *
 * As of the current public documentation, Cascade lets you pick from the models
 * the product offers and allows BYOK for *its own* provider list; there is no
 * documented consumer-facing way to set an arbitrary OpenAI-compatible base URL
 * plus model id, and no settings file to write. Rather than invent one and
 * corrupt someone's install, this target:
 *
 *   1. records the discovered provider in `~/.anyprovider/providers.json`;
 *   2. prints the exact values to paste into Windsurf's BYOK dialog;
 *   3. points at the supported way to use a custom gateway (ACP agent).
 *
 * If Windsurf later documents a config surface, this adapter simply starts
 * writing it — the probe side needs no change.
 */

import { join } from 'node:path';
import { baseNotes, home, readJsonIfExists, toJson } from './_shared.mjs';

export const windsurfBundlePath = () => join(home(), '.anyprovider', 'windsurf.json');

export default {
  id: 'windsurf',
  label: 'Windsurf (guided)',
  homepage: 'https://windsurf.com',
  level: 'snippet',
  protocols: ['chat', 'responses', 'anthropic'],

  defaultPath: () => windsurfBundlePath(),

  plan({ discovery, selected, providerId, providerName, baseUrl, apiKey, path }) {
    const target = path || windsurfBundlePath();
    const existing = readJsonIfExists(target);
    if (existing.error) throw new Error(`${target} is not valid JSON (${existing.error}); refusing to touch it`);

    const bundle = existing.json ?? {};
    const [primary] = selected;
    bundle[providerId] = {
      name: providerName,
      // Windsurf's BYOK dialog wants a base URL, not a full endpoint path.
      baseUrl,
      apiKey,
      models: selected.map((m) => m.id),
      primaryModel: primary?.id ?? null,
      format: discovery.format,
      note: 'Windsurf has no documented custom-endpoint config file; paste these into its BYOK dialog.',
      capturedAt: new Date().toISOString(),
    };

    const snippet = [
      `# ${providerName}`,
      `Base URL : ${baseUrl}`,
      `API Key  : ${apiKey}`,
      `Model ID : ${primary?.id ?? '<pick one>'}`,
      '',
      '# In Windsurf: model picker → "Add model" / BYOK → pick an OpenAI or Anthropic',
      '# compatible provider, then paste the three values above.',
    ].join('\n');

    return {
      writes: [{ path: target, text: toJson(bundle), mode: 'merge' }],
      snippet,
      notes: [
        'Windsurf documents no settings file for arbitrary custom endpoints, so nothing was written into Windsurf itself.',
        'If its BYOK dialog only accepts its own provider list, use an ACP agent (OpenCode, Claude Agent, Gemini CLI) inside Windsurf instead — that path takes a base URL today.',
        ...baseNotes(discovery),
      ],
    };
  },
};
