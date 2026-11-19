import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-gateway.mjs';
import { discover, DEFAULTS } from '../src/core/probe.mjs';
import { endpointCandidates, normalizeBase, providerIdFromHost } from '../src/core/endpoints.mjs';
import { visionBody, isVisionRejection, TINY_PNG_DATA_URL } from '../src/core/vision.mjs';

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

  it('probes vision per model and votes on the provider default', async () => {
    const events = [];
    const result = await discover({ baseUrl: mock.url, apiKey: mock.key, onEvent: (k, p) => {
      if (k === 'vision') events.push(p);
    } });

    const think = result.models.find((m) => m.id === 'mock-think');
    const plain = result.models.find((m) => m.id === 'mock-plain');
    assert.equal(think.vision, 'yes', 'the vision model accepts a 1x1 PNG');
    assert.ok(think.visionEvidence.length, 'image-token usage is kept as evidence');
    assert.equal(plain.vision, 'no', 'the plain model rejects the image with a vision-shaped 400');
    assert.equal(result.providerVision, null, 'a split vote has no provider-wide winner');
    assert.equal(events.length, 2, 'one vision event per probed model');
  });

  it('votes a provider-wide yes when every probed model accepts images', async () => {
    const allVision = await startMock({ visionModels: ['mock-think', 'mock-plain'] });
    try {
      const result = await discover({ baseUrl: allVision.url, apiKey: allVision.key });
      assert.equal(result.providerVision, 'yes');
      assert.ok(result.models.every((m) => m.vision === 'yes'));
      assert.ok(result.notes.some((n) => n.includes('accept images')));
    } finally {
      await allVision.close();
    }
  });

  it('can skip vision probing entirely', async () => {
    const result = await discover({ baseUrl: mock.url, apiKey: mock.key, visionSample: 0 });
    assert.equal(result.providerVision, null);
    assert.deepEqual(result.visionVotes, {});
    assert.ok(result.models.every((m) => m.vision === null));
    assert.ok(result.notes.some((n) => n.includes('Vision probing was skipped')));
  });
});

describe('vision probe bodies', () => {
  it('builds an image block for each protocol', () => {
    const chat = visionBody('chat', 'm');
    assert.equal(chat.messages[0].content[1].type, 'image_url');
    assert.match(chat.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);

    const resp = visionBody('responses', 'm');
    assert.ok(resp.input[0].content.some((c) => c.type === 'input_image'));
    assert.match(resp.input[0].content.find((c) => c.type === 'input_image').image_url, /^data:image\/png/);

    const anth = visionBody('anthropic', 'm');
    assert.equal(anth.messages[0].content[1].type, 'image');
    assert.equal(anth.messages[0].content[1].source.media_type, 'image/png');
  });

  it('omits the image in the control request', () => {
    const control = visionBody('chat', 'm', { withImage: false });
    assert.equal(control.messages[0].content.length, 1);
    assert.equal(control.messages[0].content[0].type, 'text');
  });

  it('recognises vision-shaped rejection messages', () => {
    assert.equal(isVisionRejection('This model does not support image inputs'), true);
    assert.equal(isVisionRejection('vision is not enabled for this endpoint'), true);
    assert.equal(isVisionRejection('invalid request'), false);
  });

  it('uses a tiny inline PNG with no file dependency', () => {
    assert.ok(TINY_PNG_DATA_URL.length < 200, 'the probe image stays tiny');
  });
});
