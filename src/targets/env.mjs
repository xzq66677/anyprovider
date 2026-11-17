/**
 * Generic escape hatch: a portable JSON bundle plus env exports.
 *
 * This is the target to use when your harness is not in the list — every
 * harness ends up needing "base URL + key + model id + limits", and this
 * prints exactly that, in a form you can paste anywhere.
 */

import { join } from 'node:path';
import { defaults, home, readJsonIfExists, toJson } from './_shared.mjs';

export const registryPath = () => defaults.registryPath();

export default {
  id: 'env',
  label: 'Generic (.env / JSON bundle)',
  homepage: null,
  level: 'auto',
  protocols: ['chat', 'responses', 'anthropic'],

  defaultPath: () => join(home(), '.anyprovider', 'providers.json'),

  plan({ discovery, selected, providerId: id, providerName, baseUrl, apiKey, path }) {
    const target = path || registryPath();
    const existing = readJsonIfExists(target);
    if (existing.error) throw new Error(`${target} is not valid JSON (${existing.error}); refusing to touch it`);

    const registry = existing.json ?? { version: 1, providers: {} };
    registry.providers ??= {};
    registry.providers[id] = {
      id,
      name: providerName,
      baseUrl,
      apiKey,
      format: discovery.format,
      endpoint: discovery.protocolUrl,
      models: Object.fromEntries(
        selected.map((m) => [m.id, {
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          reasoning: m.reasoning ?? null,
        }]),
      ),
      discoveredAt: new Date().toISOString(),
    };

    const [primary] = selected;
    const envName = id.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
    const snippet = [
      `# ${providerName}`,
      `export OPENAI_BASE_URL="${baseUrl}"`,
      `export OPENAI_API_KEY="${apiKey}"`,
      `export OPENAI_MODEL="${primary.id}"`,
      `# generic form used by this tool:`,
      `export ${envName}_BASE_URL="${baseUrl}"`,
      `export ${envName}_API_KEY="${apiKey}"`,
    ].join('\n');

    return {
      writes: [{ path: target, text: toJson(registry), mode: 'merge' }],
      snippet,
      notes: [`A machine-readable copy is kept in ${target} (contains the API key — keep it private).`],
    };
  },
};
