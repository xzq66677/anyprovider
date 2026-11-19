import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import zcode, { validateZcodeConfig } from '../src/targets/zcode.mjs';
import opencode from '../src/targets/opencode.mjs';
import claudeCode from '../src/targets/claude-code.mjs';
import continueTarget from '../src/targets/continue.mjs';
import env from '../src/targets/env.mjs';
import { parseTargetSelection, TARGETS } from '../src/targets/index.mjs';
import { executePlan } from '../src/core/run.mjs';
import { applyWrites } from '../src/core/apply.mjs';

let dir;
const opts = {
  providerId: 'custom-api-example-com',
  providerName: 'Example',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-key',
};

const discovery = {
  baseUrl: 'https://api.example.com/v1',
  protocol: 'chat',
  format: 'openai-chat-completions',
  protocolUrl: 'https://api.example.com/v1/chat/completions',
  providerReasoning: 'reasoning_effort',
  notes: [],
  models: [],
};

const selected = [
  { id: 'think-1', contextWindow: 262144, maxOutputTokens: 65536, reasoning: 'reasoning_effort' },
  { id: 'plain-2', contextWindow: 128000, maxOutputTokens: 65536, reasoning: null },
];

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

before(() => { dir = mkdtempSync(join(tmpdir(), 'anyprovider-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe('zcode target', () => {
  it('writes a config that passes its own strict validation', () => {
    const path = join(dir, 'zcode', 'provider_config.json');
    const plan = zcode.plan({ discovery, selected, ...opts, path });
    assert.equal(plan.writes.length, 1);

    const text = plan.writes[0].text;
    const root = JSON.parse(text);
    assert.deepEqual(validateZcodeConfig(root), []);

    const rule = root.config.providerConfigRules.providerRules[0];
    assert.equal(rule.providerId, 'custom-api-example-com');
    assert.equal(rule.config.api.type, 'openai-chat-completions');
    assert.deepEqual(rule.config.personalModelIds, ['think-1', 'plain-2']);

    const manual = root.config.modelConfigRules.manualProviderModelRules;
    assert.equal(manual.length, 2);
    assert.equal(manual[0].config.optionSpecs.reasoningLevel.map, '{"reasoning_effort": reasoningLevel}');
    // The model that rejected every knob still needs a reasoningLevel object —
    // omitting it makes ZCode drop the whole file.
    assert.deepEqual(manual[1].config.optionSpecs.reasoningLevel, { values: ['enabled'], map: '{}' });
  });

  it('reflects the probe result in supportsImage, defaulting to false', () => {
    const withVision = [
      { ...selected[0], vision: 'yes' },
      { ...selected[1], vision: 'no' },
    ];
    const path = join(dir, 'zcode', 'vision.json');
    const plan = zcode.plan({ discovery, selected: withVision, ...opts, path });
    const manual = JSON.parse(plan.writes[0].text).config.modelConfigRules.manualProviderModelRules;
    assert.equal(manual[0].config.properties.inputFormat.supportsImage, true);
    assert.equal(manual[1].config.properties.inputFormat.supportsImage, false);

    // Unprobed models stay conservative unless the provider voted yes.
    const unprobed = zcode.plan({ discovery: { ...discovery, providerVision: 'yes' }, selected, ...opts, path });
    const m2 = JSON.parse(unprobed.writes[0].text).config.modelConfigRules.manualProviderModelRules;
    assert.equal(m2[0].config.properties.inputFormat.supportsImage, true);
    assert.equal(m2[1].config.properties.inputFormat.supportsImage, true);
  });

  it('is idempotent', () => {
    const path = join(dir, 'zcode', 'provider_config.json');
    const first = zcode.plan({ discovery, selected, ...opts, path });
    write(path, first.writes[0].text);
    const second = zcode.plan({ discovery, selected, ...opts, path });
    const root = JSON.parse(second.writes[0].text);
    assert.equal(root.config.providerConfigRules.providerRules.length, 1);
    assert.equal(root.config.modelConfigRules.manualProviderModelRules.length, 2);
    assert.equal(root.config.providerOrder.length, 1);
  });

  it('refuses to touch a file it cannot parse', () => {
    const path = join(dir, 'zcode', 'broken.json');
    write(path, '{ not json');
    assert.throws(() => zcode.plan({ discovery, selected, ...opts, path }), /not valid JSON/);
  });

  it('flags a config that would be rejected instead of writing it', () => {
    const root = {
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { manualProviderModelRules: [{ modelId: 'x', providerId: 'p', config: { enabled: true, optionSpecs: {} } }] },
      },
    };
    const problems = validateZcodeConfig(root);
    assert.ok(problems.some((p) => p.includes('optionSpecs.reasoningLevel')));
  });
});

describe('opencode target', () => {
  it('uses the current "providers" shape on a fresh file', () => {
    const path = join(dir, 'opencode', 'opencode.json');
    const plan = opencode.plan({ discovery, selected, ...opts, path });
    const root = JSON.parse(plan.writes[0].text);
    assert.equal(root.$schema, 'https://opencode.ai/config.json');
    const provider = root.providers['custom-api-example-com'];
    assert.equal(provider.package, '@opencode/ai/providers/openai-compatible');
    assert.equal(provider.settings.baseURL, opts.baseUrl);
    assert.deepEqual(provider.models['think-1'].limit, { context: 262144, output: 65536 });
    // The key is never inlined in the new format; it is referenced via env.
    assert.equal(JSON.stringify(root).includes('sk-test-key'), false);
    assert.deepEqual(provider.env, ['CUSTOM_API_EXAMPLE_COM_API_KEY']);
  });

  it('keeps the legacy "provider" shape when the file already uses it', () => {
    const path = join(dir, 'opencode', 'legacy.json');
    write(path, JSON.stringify({
      provider: { openai: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api.openai.com/v1' } } },
    }));
    const plan = opencode.plan({ discovery, selected, ...opts, path });
    const root = JSON.parse(plan.writes[0].text);
    assert.ok(root.provider.openai, 'existing providers are preserved');
    assert.equal(root.provider['custom-api-example-com'].npm, '@ai-sdk/openai-compatible');
    assert.equal(root.provider['custom-api-example-com'].options.apiKey, 'sk-test-key');
    assert.equal(root.providers, undefined);
  });

  it('tolerates jsonc comments in an existing file', () => {
    const path = join(dir, 'opencode', 'commented.jsonc');
    write(path, '{\n  // my providers\n  "providers": {}\n}\n');
    const plan = opencode.plan({ discovery, selected, ...opts, path });
    const root = JSON.parse(plan.writes[0].text);
    assert.ok(root.providers['custom-api-example-com']);
  });
});

describe('other targets', () => {
  it('claude-code writes the env block and warns on the wrong protocol', () => {
    const path = join(dir, 'claude', 'settings.json');
    const plan = claudeCode.plan({ discovery, selected, ...opts, path });
    const root = JSON.parse(plan.writes[0].text);
    assert.equal(root.env.ANTHROPIC_BASE_URL, opts.baseUrl);
    assert.equal(root.env.ANTHROPIC_AUTH_TOKEN, 'sk-test-key');
    assert.equal(root.env.ANTHROPIC_MODEL, 'think-1');
    assert.ok(plan.notes.some((n) => n.includes('anthropic-messages')));
  });

  it('continue only creates a file when none exists, otherwise suggests', () => {
    const path = join(dir, 'continue', 'config.yaml');
    const fresh = continueTarget.plan({ discovery, selected, ...opts, path });
    assert.equal(fresh.writes[0].mode, 'create');

    write(path, 'models:\n  - name: mine\n');
    const existing = continueTarget.plan({ discovery, selected, ...opts, path });
    assert.equal(existing.writes[0].mode, 'suggest');

    const { results } = executePlan(existing, { dryRun: false });
    assert.match(results[0].path, /config\.anyprovider\.yaml$/);
    assert.equal(readFileSync(path, 'utf8'), 'models:\n  - name: mine\n', 'the original file is untouched');
  });

  it('env keeps a machine-readable registry', () => {
    const path = join(dir, 'registry', 'providers.json');
    const plan = env.plan({ discovery, selected, ...opts, path });
    const root = JSON.parse(plan.writes[0].text);
    const entry = root.providers['custom-api-example-com'];
    assert.equal(entry.baseUrl, opts.baseUrl);
    assert.equal(entry.models['think-1'].contextWindow, 262144);
    assert.match(plan.snippet, /OPENAI_BASE_URL/);
  });
});

describe('interactive target selection', () => {
  it('parses indexes, ids and all into target objects', () => {
    assert.deepEqual(parseTargetSelection('1,3').map((t) => t.id), ['zcode', 'claude-code']);
    assert.deepEqual(parseTargetSelection('opencode env').map((t) => t.id), ['opencode', 'env']);
    assert.equal(parseTargetSelection('all').length, TARGETS.length);
    assert.equal(parseTargetSelection('a').length, TARGETS.length);
  });

  it('ignores unknown tokens and de-duplicates', () => {
    assert.deepEqual(parseTargetSelection('2 2 nope').map((t) => t.id), ['opencode']);
    assert.deepEqual(parseTargetSelection('').map((t) => t.id), []);
  });

  it('maps displayed numbers to the supplied installed-only list', () => {
    const installed = TARGETS.filter((t) => t.id === 'zcode' || t.id === 'opencode');
    assert.deepEqual(parseTargetSelection('1', installed).map((t) => t.id), ['zcode']);
    assert.deepEqual(parseTargetSelection('2 1', installed).map((t) => t.id), ['opencode', 'zcode']);
    // ids and "all" still reach targets that are not in the menu
    assert.deepEqual(parseTargetSelection('claude-code', installed).map((t) => t.id), ['claude-code']);
    assert.equal(parseTargetSelection('all', installed).length, TARGETS.length);
  });
});

describe('applyWrites', () => {
  it('backs up and writes atomically', () => {
    const path = join(dir, 'apply', 'file.json');
    applyWrites([{ path, text: '{"a":1}\n' }], { log: () => {} });
    const res = applyWrites([{ path, text: '{"a":2}\n' }], { log: () => {} });

    assert.equal(readFileSync(path, 'utf8'), '{"a":2}\n');
    assert.ok(res[0].backedUp && existsSync(res[0].backedUp));
    assert.equal(readFileSync(res[0].backedUp, 'utf8'), '{"a":1}\n');
  });

  it('writes nothing in a dry run', () => {
    const path = join(dir, 'apply', 'dry.json');
    const res = applyWrites([{ path, text: '{}\n' }], { dryRun: true, log: () => {} });
    assert.equal(res[0].dryRun, true);
    assert.equal(existsSync(path), false);
  });
});
