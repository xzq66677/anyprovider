import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-gateway.mjs';
import { discover, DEFAULTS } from '../src/core/probe.mjs';
import { endpointCandidates, normalizeBase, providerIdFromHost } from '../src/core/endpoints.mjs';

let mock;

before(async () => { mock = await startMock(); });
after(async () => { await mock.close(); });

describe('endpoints', () => {
  it('normalises a bare host to https', () => {
    assert.equal(normalizeBase('api.example.com/v1/'), 'https://api.example.com/v1');
  });

  it('rejects junk', () => {
    assert.throws(() => normalizeBase('http://'), /invalid base URL/);
  });

  it('tries the /v1 variant of a bare host', () => {
    const { chat } = endpointCandidates('https://api.example.com');
    assert.ok(chat.includes('https://api.example.com/v1/chat/completions'));
  });

  it('does not double up /v1', () => {
    const { chat } = endpointCandidates('https://api.example.com/v1');
    assert.ok(chat.includes('https://api.example.com/v1/chat/completions'));
    assert.ok(!chat.includes('https://api.example.com/v1/v1/chat/completions'));
  });

  it('derives a stable provider id', () => {
    assert.equal(providerIdFromHost('https://api.example.com/v1'), 'custom-api-example-com');
  });
});

describe('discover', () => {
  it('finds the models, the protocol and the token ceiling', async () => {
    const result = await discover({ baseUrl: mock.url, apiKey: mock.key });

    assert.equal(result.authError, null);
    assert.equal(result.protocol, 'chat');
    assert.equal(result.format, 'openai-chat-completions');
    assert.ok(result.protocolUrl.endsWith('/v1/chat/completions'));
    assert.deepEqual(result.models.map((m) => m.id).sort(), ['mock-plain', 'mock-think']);
    assert.equal(result.providerReasoning, 'reasoning_effort');

    const think = result.models.find((m) => m.id === 'mock-think');
    assert.equal(think.contextWindow, 262144);
    assert.equal(think.maxOutputTokens, 65536);
    assert.equal(think.reasoning, 'reasoning_effort');

    const plain = result.models.find((m) => m.id === 'mock-plain');
    assert.equal(plain.contextWindow, DEFAULTS.contextWindow, 'falls back to the default window');
    assert.equal(plain.maxOutputTokens, 65536, 'inherits the probed ceiling');
    assert.equal(plain.reasoning, null, 'a probed model that rejects every knob must not inherit the winner');
  });

  it('reports a rejected key instead of probing forever', async () => {
    const result = await discover({ baseUrl: mock.url, apiKey: 'sk-wrong' });
    assert.match(result.authError, /invalid api key/);
    assert.equal(result.models.length, 0);
    assert.equal(result.protocol, null);
  });

  it('accepts models that the gateway does not advertise', async () => {
    const result = await discover({ baseUrl: mock.url, apiKey: mock.key, modelIds: ['ghost-model'] });
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].id, 'ghost-model');
    assert.ok(result.notes.some((n) => n.includes('ghost-model')));
  });

  it('can skip reasoning probing entirely', async () => {
    const result = await discover({ baseUrl: mock.url, apiKey: mock.key, sample: 0 });
    assert.equal(result.providerReasoning, null);
    assert.ok(result.models.every((m) => m.reasoning === null));
  });
});
