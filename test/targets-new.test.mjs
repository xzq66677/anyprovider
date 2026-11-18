import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import zed from '../src/targets/zed.mjs';
import vscodeCopilot from '../src/targets/vscode-copilot.mjs';
import windsurf from '../src/targets/windsurf.mjs';
import dsh from '../src/targets/deepseek-harness.mjs';
import { TARGETS, TARGET_IDS, supportsProtocol } from '../src/targets/index.mjs';

let dir;
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

const chatDiscovery = {
  baseUrl: 'https://api.example.com/v1',
  protocol: 'chat',
  format: 'openai-chat-completions',
  protocolUrl: 'https://api.example.com/v1/chat/completions',
  providerReasoning: 'reasoning_effort',
  notes: [],
  models: [],
};

const anthropicDiscovery = {
  ...chatDiscovery,
  protocol: 'anthropic',
  format: 'anthropic-messages',
  protocolUrl: 'https://api.example.com/v1/messages',
  providerReasoning: 'thinking',
};

const anthropicSelected = [
  { id: 'claude-x', contextWindow: 200000, maxOutputTokens: 32000, reasoning: 'thinking' },
];

const selected = [
  { id: 'think-1', contextWindow: 262144, maxOutputTokens: 65536, reasoning: 'reasoning_effort' },
  { id: 'plain-2', contextWindow: 128000, maxOutputTokens: 8192, reasoning: null },
];

const opts = {
  providerId: 'custom-api-example-com',
  providerName: 'Example',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-key',
};

before(() => { dir = mkdtempSync(join(tmpdir(), 'anyprovider-new-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe('registry', () => {
  it('exposes all twelve targets with unique ids', () => {
    assert.equal(TARGETS.length, 12);
    assert.equal(new Set(TARGET_IDS).size, 12);
    for (const id of ['zed', 'vscode-copilot', 'windsurf', 'deepseek-harness']) assert.ok(TARGET_IDS.includes(id), id);
  });

  it('gates protocols per target', () => {
    const claude = TARGETS.find((t) => t.id === 'claude-code');
    assert.equal(supportsProtocol(claude, 'chat'), false);
    assert.equal(supportsProtocol(claude, 'anthropic'), true);
    assert.equal(supportsProtocol(zed, 'chat'), true);
  });
});

describe('zed target', () => {
  it('writes an openai_compatible provider without a key in settings', () => {
    const path = join(dir, 'zed', 'settings.json');
    const plan = zed.plan({ discovery: chatDiscovery, selected, ...opts, path });
    const root = JSON.parse(plan.writes[0].text);

    const provider = root.language_models.openai_compatible['custom-api-example-com'];
    assert.equal(provider.api_url, 'https://api.example.com/v1');
    assert.equal(provider.available_models.length, 2);
    assert.equal(provider.available_models[0].max_tokens, 262144);
    assert.equal(provider.available_models[0].reasoning_effort, 'medium');
    assert.equal(provider.available_models[1].reasoning_effort, undefined, 'a model that rejected the knob gets none');
    assert.equal(JSON.stringify(root).includes('sk-test-key'), false, 'Zed keys must not live in settings.json');
    assert.ok(plan.snippet.includes('CUSTOM_API_EXAMPLE_COM_API_KEY'));
  });

  it('uses anthropic_compatible and strips /v1 for anthropic gateways', () => {
    const path = join(dir, 'zed', 'settings.json');
    const plan = zed.plan({ discovery: anthropicDiscovery, selected: anthropicSelected, ...opts, path });
    const root = JSON.parse(plan.writes[0].text);
    const provider = root.language_models.anthropic_compatible.Example;
    assert.equal(provider.api_url, 'https://api.example.com');
    assert.deepEqual(provider.available_models[0].mode, { type: 'thinking', budget_tokens: 4096 });
  });

  it('marks responses models as chat-completions-incapable', () => {
    const path = join(dir, 'zed', 'resp.json');
    const discovery = { ...chatDiscovery, protocol: 'responses', protocolUrl: 'https://api.example.com/v1/responses' };
    const plan = zed.plan({ discovery, selected, ...opts, path });
    const root = JSON.parse(plan.writes[0].text);
    assert.deepEqual(root.language_models.openai_compatible['custom-api-example-com'].available_models[0].capabilities, {
      chat_completions: false,
    });
  });

  it('preserves unrelated settings and providers', () => {
    const path = join(dir, 'zed', 'keep.json');
    write(path, JSON.stringify({ theme: 'One Dark', language_models: { openai_compatible: { other: { api_url: 'x' } } } }));
    const plan = zed.plan({ discovery: chatDiscovery, selected, ...opts, path });
    const root = JSON.parse(plan.writes[0].text);
    assert.equal(root.theme, 'One Dark');
    assert.ok(root.language_models.openai_compatible.other);
  });
});

describe('vscode-copilot target', () => {
  it('writes a customendpoint provider with per-model URLs', () => {
    const path = join(dir, 'vscode', 'chatLanguageModels.json');
    const plan = vscodeCopilot.plan({ discovery: chatDiscovery, selected, ...opts, path });
    const list = JSON.parse(plan.writes[0].text);

    assert.ok(Array.isArray(list));
    assert.equal(list.length, 1);
    const provider = list[0];
    assert.equal(provider.vendor, 'customendpoint');
    assert.equal(provider.apiType, 'chat-completions');
    assert.equal(provider.apiKey, 'sk-test-key');

    const [think, plain] = provider.models;
    assert.equal(think.url, 'https://api.example.com/v1/chat/completions');
    assert.equal(think.toolCalling, true);
    assert.equal(think.maxInputTokens + think.maxOutputTokens, 262144, 'input+output must equal the context window');
    assert.deepEqual(think.supportsReasoningEffort, ['minimal', 'low', 'medium', 'high']);
    assert.equal(think.reasoningEffortFormat, 'chat-completions');
    assert.equal(plain.thinking, undefined);
  });

  it('maps the anthropic protocol to the messages API type', () => {
    const path = join(dir, 'vscode', 'anthropic.json');
    const plan = vscodeCopilot.plan({ discovery: anthropicDiscovery, selected, ...opts, path });
    const [provider] = JSON.parse(plan.writes[0].text);
    assert.equal(provider.apiType, 'messages');
    assert.equal(provider.models[0].apiType, 'messages');
    assert.equal(provider.models[0].reasoningEffortFormat, 'messages');
  });

  it('replaces its own provider entry and keeps the others', () => {
    const path = join(dir, 'vscode', 'merge.json');
    write(path, JSON.stringify([{ name: 'Other', vendor: 'azure', models: [] }]));
    const first = vscodeCopilot.plan({ discovery: chatDiscovery, selected, ...opts, path });
    write(path, first.writes[0].text);
    const second = vscodeCopilot.plan({ discovery: chatDiscovery, selected, ...opts, path });
    const list = JSON.parse(second.writes[0].text);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((p) => p.name).sort(), ['Example', 'Other']);
  });
});

describe('windsurf target', () => {
  it('never writes into Windsurf, only captures a bundle to paste from', () => {
    const path = join(dir, 'windsurf', 'windsurf.json');
    const plan = windsurf.plan({ discovery: chatDiscovery, selected, ...opts, path });

    assert.equal(plan.writes[0].mode, 'merge');
    assert.ok(plan.writes[0].path.endsWith('windsurf.json'));

    const bundle = JSON.parse(plan.writes[0].text);
    const entry = bundle['custom-api-example-com'];
    assert.equal(entry.baseUrl, 'https://api.example.com/v1');
    assert.equal(entry.primaryModel, 'think-1');
    assert.deepEqual(entry.models, ['think-1', 'plain-2']);
    assert.ok(plan.snippet.includes('Base URL'));
    assert.ok(plan.notes.some((n) => n.includes('no settings file')));
  });

  it('stays out of the way when the bundle file is corrupt', () => {
    const path = join(dir, 'windsurf', 'broken.json');
    write(path, '{oops');
    assert.throws(() => windsurf.plan({ discovery: chatDiscovery, selected, ...opts, path }), /not valid JSON/);
  });
});

/* ------------------------------------------------------------------ */

const PATCH_FIXTURE = `# Your patch layer for this dsh profile.
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ollama:
        displayName: Ollama (本地)
        apiKeyEnv: OLLAMA_API_KEY
        api: openai-completions
        baseURL: http://localhost:11434/v1
        models:
          - id: qwen3:8b
            name: qwen3:8b
            contextWindow: 16384
      custom-api-example-com:
        displayName: Stale
        apiKeyEnv: CUSTOM_API_EXAMPLE_COM_API_KEY
        api: openai-completions
        baseURL: https://old.example.com/v1
        models:
          - id: old-model
            name: old-model
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
`;

const CRED_FIXTURE = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: not-a-real-secret
refs:
  SPARK_API_KEY: ak-fake
  CUSTOM_API_EXAMPLE_COM_API_KEY: sk-stale-key
`;

const dshEnv = (credPath) => ({ DSH_CREDENTIALS: credPath });

describe('deepseek-harness target', () => {
  it('creates both files from scratch and keeps the key out of the patch', () => {
    const patchPath = join(dir, 'dsh', 'fresh', 'cordis.patch.yml');
    const credPath = join(dir, 'dsh', 'fresh', '.credentials.yaml');
    const plan = dsh.plan({ discovery: chatDiscovery, selected, ...opts, path: patchPath, env: dshEnv(credPath) });

    assert.equal(plan.writes.length, 2);
    assert.equal(plan.writes[0].mode, 'merge');
    assert.equal(plan.writes[1].mode, 'merge');

    const patch = plan.writes[0].text;
    assert.ok(patch.includes('- id: llm-pi-ai'), 'llm-pi-ai entry created');
    assert.ok(patch.includes('name: "@deepseek-ai/dsh-llm-pi-ai"'));
    assert.ok(patch.includes('      custom-api-example-com:'), 'provider block at child indent');
    assert.ok(patch.includes('        apiKeyEnv: CUSTOM_API_EXAMPLE_COM_API_KEY'));
    assert.ok(patch.includes('        api: openai-completions'));
    assert.ok(patch.includes('        baseURL: https://api.example.com/v1'));
    assert.ok(patch.includes('          - id: think-1'));
    assert.ok(patch.includes('            contextWindow: 262144'));
    assert.ok(patch.includes('            maxTokens: 65536'));
    assert.ok(patch.includes('        reasoningEfforts:'), 'reasoning model gets the efforts map');
    assert.ok(patch.includes('            off: null'));
    assert.ok(!patch.includes('sk-test-key'), 'the key must never reach the patch file');
    assert.ok(patch.includes('          - id: plain-2'), 'both models listed');
    // The no-knob model must not claim a reasoning map of its own.
    const plainIdx = patch.indexOf('- id: plain-2');
    const plainChunk = patch.slice(plainIdx, patch.indexOf('- id:', plainIdx + 5) === -1 ? patch.length : patch.indexOf('- id:', plainIdx + 5));
    assert.ok(!plainChunk.includes('reasoningEfforts'), 'a model that rejected every knob gets no reasoningEfforts');

    const cred = plan.writes[1].text;
    assert.ok(cred.includes('version: 1'));
    assert.ok(cred.includes('  CUSTOM_API_EXAMPLE_COM_API_KEY: sk-test-key'));
  });

  it('maps the anthropic protocol to anthropic-messages', () => {
    const patchPath = join(dir, 'dsh', 'anthropic', 'cordis.patch.yml');
    const credPath = join(dir, 'dsh', 'anthropic', '.credentials.yaml');
    const plan = dsh.plan({ discovery: anthropicDiscovery, selected: anthropicSelected, ...opts, path: patchPath, env: dshEnv(credPath) });
    assert.ok(plan.writes[0].text.includes('        api: anthropic-messages'));
  });

  it('merges into an existing patch without touching other providers or entries', () => {
    const patchPath = join(dir, 'dsh', 'merge', 'cordis.patch.yml');
    const credPath = join(dir, 'dsh', 'merge', '.credentials.yaml');
    write(patchPath, PATCH_FIXTURE);
    write(credPath, CRED_FIXTURE);

    const plan = dsh.plan({ discovery: chatDiscovery, selected, ...opts, path: patchPath, env: dshEnv(credPath) });
    const patch = plan.writes[0].text;

    // Other providers survive verbatim.
    assert.ok(patch.includes('      ollama:'));
    assert.ok(patch.includes('        displayName: Ollama (本地)'));
    assert.ok(patch.includes('          - id: qwen3:8b'));
    // Other entries survive, in order, before and after ours.
    assert.ok(patch.indexOf('- id: ui-theme') < patch.indexOf('- id: llm-pi-ai'));
    assert.ok(patch.includes('- id: agent-default-model'));
    assert.ok(patch.includes('    provider: deepseek-official'));
    // The stale provider block was replaced, not duplicated.
    assert.equal(patch.split('      custom-api-example-com:').length - 1, 1);
    assert.ok(!patch.includes('https://old.example.com'), 'stale block is gone');
    assert.ok(!patch.includes('old-model'), 'stale models are gone');

    const cred = plan.writes[1].text;
    assert.ok(cred.includes('  SPARK_API_KEY: ak-fake'), 'other refs preserved');
    assert.ok(cred.includes('      secret: not-a-real-secret'), 'grant records preserved');
    assert.equal(cred.split('CUSTOM_API_EXAMPLE_COM_API_KEY:').length - 1, 1, 'ref replaced, not duplicated');
    assert.ok(cred.includes('  CUSTOM_API_EXAMPLE_COM_API_KEY: sk-test-key'), 'ref updated to the new key');
    assert.ok(!cred.includes('sk-stale-key'));
  });

  it('is idempotent across reruns', () => {
    const patchPath = join(dir, 'dsh', 'idem', 'cordis.patch.yml');
    const credPath = join(dir, 'dsh', 'idem', '.credentials.yaml');
    write(patchPath, PATCH_FIXTURE);
    write(credPath, CRED_FIXTURE);

    const first = dsh.plan({ discovery: chatDiscovery, selected, ...opts, path: patchPath, env: dshEnv(credPath) });
    write(patchPath, first.writes[0].text);
    write(credPath, first.writes[1].text);

    const second = dsh.plan({ discovery: chatDiscovery, selected, ...opts, path: patchPath, env: dshEnv(credPath) });
    const patch = second.writes[0].text;
    const cred = second.writes[1].text;

    assert.equal(patch.split('      custom-api-example-com:').length - 1, 1);
    assert.equal(patch.split('- id: llm-pi-ai').length - 1, 1);
    assert.equal(patch.split('- id: agent-default-model').length - 1, 1);
    assert.equal(patch.split('      ollama:').length - 1, 1);
    assert.equal(patch.split('- id: ui-theme').length - 1, 1);
    assert.equal(cred.split('CUSTOM_API_EXAMPLE_COM_API_KEY:').length - 1, 1);
    assert.equal(cred.split('  SPARK_API_KEY: ak-fake').length - 1, 1);
  });

  it('adds a providers map when the llm-pi-ai entry lacks one', () => {
    const patchPath = join(dir, 'dsh', 'bare', 'cordis.patch.yml');
    const credPath = join(dir, 'dsh', 'bare', '.credentials.yaml');
    write(patchPath, [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    someOtherKey: 1',
    ].join('\n'));
    const plan = dsh.plan({ discovery: chatDiscovery, selected, ...opts, path: patchPath, env: dshEnv(credPath) });
    const patch = plan.writes[0].text;
    assert.ok(patch.includes('    providers:'));
    assert.ok(patch.includes('      custom-api-example-com:'));
    assert.ok(patch.includes('    someOtherKey: 1'), 'existing config keys preserved');
    const providersAt = patch.indexOf('    providers:');
    assert.ok(providersAt > patch.indexOf('  config:'), 'providers goes under config:');
  });
});
