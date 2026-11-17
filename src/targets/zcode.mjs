/**
 * ZCode (Electron coding IDE) — `provider_config.json`.
 *
 * Location is indirect: `~/.zcode/v2/setting.json` may move the whole data dir
 * via `dataBaseDir`, and the live config then lives under
 * `<dataBaseDir>/.zcode/v2/provider_config.json`. A stale copy under
 * `~/.zcode/v2/` is usually left behind; editing that copy does nothing visible.
 *
 * Schema (validated by zod inside the app):
 *   config.providerConfigRules.providerRules[]   { providerId, providerName, enabled, config { group, visibility, access, api, personalModelIds, modelOrder } }
 *   config.modelConfigRules.manualProviderModelRules[] { modelId, providerId, config { enabled, properties, optionSpecs } }
 *   config.providerOrder[]
 *
 * The whole file is all-or-nothing: one bad rule makes ZCode drop the entire
 * config and run on an empty in-memory copy (the UI then shows no custom
 * providers at all, while the file on disk is still fine). We therefore
 * validate before returning any write.
 */

import { join } from 'node:path';
import { home, readJsonIfExists, readTextIfExists, toJson } from './_shared.mjs';
import { reasoningExpression, reasoningLevels } from '../core/reasoning.mjs';

const FORMAT = {
  chat: 'openai-chat-completions',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
};

export function zcodeConfigPath(env = process.env) {
  if (env.ZCODE_CONFIG) return env.ZCODE_CONFIG;
  const boot = readJsonIfExists(join(home(), '.zcode', 'v2', 'setting.json'));
  const dir = boot.json?.dataBaseDir;
  const candidates = [];
  if (dir) candidates.push(join(dir, '.zcode', 'v2', 'provider_config.json'));
  candidates.push(join(home(), '.zcode', 'v2', 'provider_config.json'));
  return candidates.find((p) => readTextIfExists(p) !== null) || candidates[candidates.length - 1];
}

export function validateZcodeConfig(root) {
  const problems = [];
  const cfg = root?.config;
  if (!cfg) return ['top-level "config" object is missing'];

  const rules = cfg.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return ['config.providerConfigRules.providerRules is missing'];
  rules.forEach((rule, i) => {
    if (!rule?.providerId) problems.push(`providerRules[${i}].providerId is missing`);
    if (!rule?.providerName) problems.push(`providerRules[${i}].providerName is missing`);
    if (rule?.config?.api) {
      if (!rule.config.api.type) problems.push(`providerRules[${i}].config.api.type is missing`);
      if (!rule.config.api.baseUrl) problems.push(`providerRules[${i}].config.api.baseUrl is missing`);
    }
    if (!Array.isArray(rule?.config?.personalModelIds)) {
      problems.push(`providerRules[${i}].config.personalModelIds must be an array`);
    }
  });

  const manual = cfg.modelConfigRules?.manualProviderModelRules;
  if (!Array.isArray(manual)) return problems.concat('config.modelConfigRules.manualProviderModelRules is missing');
  manual.forEach((rule, i) => {
    const tag = `manualProviderModelRules[${i}] (${rule?.modelId || '?'})`;
    if (!rule?.modelId) problems.push(`${tag}.modelId is missing`);
    if (!rule?.providerId) problems.push(`${tag}.providerId is missing`);
    if (typeof rule?.config?.enabled !== 'boolean') problems.push(`${tag}.config.enabled must be boolean`);
    const props = rule?.config?.properties;
    if (!props) {
      problems.push(`${tag}.config.properties is missing`);
    } else {
      if (!Number.isInteger(props.contextWindow) || props.contextWindow <= 0) {
        problems.push(`${tag}.properties.contextWindow must be a positive integer`);
      }
      for (const key of ['supportsJsonSchemaOutput', 'supportsNativeWebSearch', 'supportsMidConversationSystem']) {
        if (typeof props[key] !== 'boolean') problems.push(`${tag}.properties.${key} must be boolean`);
      }
      const inputFormat = props.inputFormat;
      if (!inputFormat || ['supportsImage', 'supportsVideo', 'supportsPdf'].some((k) => typeof inputFormat[k] !== 'boolean')) {
        problems.push(`${tag}.properties.inputFormat needs three boolean flags`);
      }
    }
    const specs = rule?.config?.optionSpecs;
    if (!specs || typeof specs !== 'object') {
      problems.push(`${tag}.config.optionSpecs is missing`);
    } else {
      if (!specs.reasoningLevel || !Array.isArray(specs.reasoningLevel.values) || !specs.reasoningLevel.values.length
        || typeof specs.reasoningLevel.map !== 'string') {
        problems.push(`${tag}.optionSpecs.reasoningLevel must be { values: [...], map: "..." } — omitting it makes ZCode reject the whole file`);
      }
      if (!specs.maxOutputTokens || !Number.isFinite(specs.maxOutputTokens.max)) {
        problems.push(`${tag}.optionSpecs.maxOutputTokens.max must be a number`);
      }
    }
  });

  return problems;
}

/** ZCode's own convention for "no reasoning knob": one level that sends nothing. */
const NO_REASONING = { values: ['enabled'], map: '{}' };

function reasoningSpec(param) {
  if (!param) return NO_REASONING;
  const values = reasoningLevels(param);
  const map = reasoningExpression(param);
  return map ? { values, map } : NO_REASONING;
}

export default {
  id: 'zcode',
  label: 'ZCode',
  homepage: 'https://zcode.ai',
  level: 'auto',
  protocols: ['chat', 'responses', 'anthropic'],

  defaultPath: ({ env = process.env } = {}) => zcodeConfigPath(env),

  plan({ discovery, selected, providerId: id, providerName, baseUrl, apiKey, path, env = process.env }) {
    const target = path || zcodeConfigPath(env);
    const existing = readJsonIfExists(target);
    if (existing.error) {
      throw new Error(`${target} is not valid JSON (${existing.error}); refusing to touch it`);
    }

    const root = existing.json ?? { schemaVersion: 1, config: {} };
    const cfg = (root.config ??= {});
    (cfg.providerConfigRules ??= {}).providerRules ??= [];
    (cfg.modelConfigRules ??= {}).manualProviderModelRules ??= [];
    cfg.providerOrder ??= [];

    cfg.providerConfigRules.providerRules = cfg.providerConfigRules.providerRules.filter((r) => r?.providerId !== id);
    cfg.providerConfigRules.providerRules.push({
      providerId: id,
      providerName,
      enabled: true,
      config: {
        group: 'standard-personal',
        visibility: 'visible',
        access: { type: 'api-key', apiKey },
        api: { type: FORMAT[discovery.protocol], baseUrl },
        personalModelIds: selected.map((m) => m.id),
        modelOrder: selected.map((m) => m.id),
      },
    });

    const manualRules = selected.map((model) => ({
      modelId: model.id,
      providerId: id,
      config: {
        enabled: true,
        properties: {
          contextWindow: model.contextWindow,
          supportsJsonSchemaOutput: true,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false,
          inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
        },
        optionSpecs: {
          maxOutputTokens: { max: model.maxOutputTokens },
          // `reasoning === null` means we asked this model and it rejected every
          // knob — it must not inherit the provider-wide winner.
          reasoningLevel: reasoningSpec(model.reasoning === undefined ? discovery.providerReasoning : model.reasoning),
        },
      },
    }));

    cfg.modelConfigRules.manualProviderModelRules = cfg.modelConfigRules.manualProviderModelRules
      .filter((r) => r?.providerId !== id)
      .concat(manualRules);

    cfg.providerOrder = [...new Set([...(cfg.providerOrder || []), id])];

    const problems = validateZcodeConfig(root);
    if (problems.length) {
      throw new Error(`generated config would be rejected by ZCode:\n  - ${problems.join('\n  - ')}`);
    }

    return {
      writes: [{ path: target, text: toJson(root), mode: 'merge' }],
      snippet: null,
      notes: [
        'ZCode must be fully quit from the tray icon, then restarted — closing the window does not reload providers.',
      ],
    };
  },
};
