import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanKeys, groupFindings } from '../src/core/keyscan.mjs';
import {
  healthPath, readHealth, writeHealth, healthKey, isFresh,
  probeHealth, resolveHealth, DEFAULT_TTL_HOURS,
} from '../src/core/keyhealth.mjs';

const cfgText = JSON.stringify({
  config: {
    providerConfigRules: {
      providerRules: [{
        providerId: 'p1', providerName: 'MyGateway',
        config: {
          access: { type: 'api-key', apiKey: 'sk-abcdefgh12345678' },
          api: { baseUrl: 'https://api.example.com/v1' },
        },
      }],
    },
  },
});
const zedText = JSON.stringify({
  language_models: { openai_compatible: { gw: { api_url: 'https://api.example.com/v1', env: 'GW_API_KEY' } } },
});
const yamlText = 'models:\n  - name: m1\n    apiBase: https://api.example.com/v1\n    apiKey: sk-abcdefgh12345678\n';

function fixtureTargets() {
  const paths = {
    zcode: '/fake/provider_config.json',
    zed: '/fake/settings.json',
    continue: '/fake/config.yaml',
  };
  const text = {
    '/fake/provider_config.json': cfgText,
    '/fake/settings.json': zedText,
    '/fake/config.yaml': yamlText,
  };
  const targets = ['zcode', 'zed', 'continue'].map((id) => ({
    id, label: id, defaultPath: () => paths[id],
  }));
  return { targets, readText: (p) => text[p] ?? null };
}

test('scanKeys reads keys from JSON configs, env-only providers, and YAML', () => {
  const { targets, readText } = fixtureTargets();
  const { findings } = scanKeys({ targets, readText });
  assert.ok(findings.some((f) => f.source === 'zcode' && f.apiKey === 'sk-abcdefgh12345678' && f.baseUrl === 'https://api.example.com/v1'));
  assert.ok(findings.some((f) => f.source === 'continue' && f.apiKey === 'sk-abcdefgh12345678'));
  // zed keeps the key out of the file — should be reported with a URL but no key
  assert.ok(findings.some((f) => f.source === 'zed' && !f.apiKey && f.baseUrl));
});

test('scanKeys includes vault keys and reports parse warnings without throwing', () => {
  const { targets, readText } = fixtureTargets();
  const withBroken = targets.concat([{ id: 'broken', label: 'Broken', defaultPath: () => '/fake/broken.json' }]);
  const { findings, warnings } = scanKeys({
    targets: withBroken,
    readText: (p) => (p === '/fake/broken.json' ? 'not json {' : readText(p)),
    vaultKeys: [{ name: 'VaultKey', baseUrl: 'https://vault.example.com/v1', apiKey: 'sk-vaultkey12345678' }],
  });
  assert.ok(findings.some((f) => f.source === 'vault' && f.name === 'VaultKey'));
  assert.ok(warnings.some((w) => w.includes('broken')));
});

test('groupFindings merges the same credential across harnesses', () => {
  const { targets, readText } = fixtureTargets();
  const { findings } = scanKeys({ targets, readText });
  const groups = groupFindings(findings);
  const g = groups.find((x) => x.apiKey === 'sk-abcdefgh12345678');
  assert.ok(g);
  assert.equal(g.platform, 'api.example.com');
  assert.ok(g.sources.some((s) => s.includes('zcode')));
  assert.ok(g.sources.some((s) => s.includes('continue')));
  // zed has no key, so it forms its own env/no-key group
  assert.ok(groups.some((x) => x.apiKey === null));
});

test('probeHealth maps 200 to valid and 401 to invalid using GET /models', async () => {
  const calls = [];
  const okRequester = async (url, opts) => {
    calls.push([url, opts.method]);
    assert.equal(opts.method, 'GET');
    return { status: 200, ok: true, json: { data: [{ id: 'm1' }, { id: 'm2' }] }, text: '{}' };
  };
  const valid = await probeHealth({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk-x12345678', requester: okRequester });
  assert.equal(valid.status, 'valid');
  assert.equal(valid.modelCount, 2);
  assert.ok(calls.length >= 1);

  const badRequester = async () => ({ status: 401, ok: false, json: null, text: 'unauthorized' });
  const invalid = await probeHealth({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk-bad123456', requester: badRequester });
  assert.equal(invalid.status, 'invalid');
});

test('health cache: fresh entries are reused without a request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-health-'));
  const path = join(dir, 'key-health.json');
  const store = { version: 1, entries: {} };
  const baseUrl = 'https://api.cached.com/v1';
  const apiKey = 'sk-cachedkey123456';
  const ck = healthKey(baseUrl, apiKey);
  store.entries[ck] = { status: 'valid', detail: 'cached', checkedAt: new Date().toISOString() };
  writeHealth(store, path);

  let requests = 0;
  const requester = async () => { requests += 1; return { status: 200, ok: true, json: { data: [] }, text: '{}' }; };
  const entries = [{ baseUrl, apiKey }];
  const s = readHealth(path);
  await resolveHealth({ entries, store: s, path, check: true, force: false, requester });
  assert.equal(requests, 0, 'fresh cache must not send a request');
  assert.equal(entries[0].health.cached, true);

  // force bypasses the cache
  await resolveHealth({ entries, store: readHealth(path), path, check: true, force: true, requester });
  assert.equal(requests, 1, 'force must re-check');
  assert.equal(entries[0].health.cached, false);
});

test('isFresh honours TTL; missing/short key entries are marked env', async () => {
  const old = { checkedAt: new Date(Date.now() - 25 * 3600_000).toISOString() };
  assert.equal(isFresh(old, DEFAULT_TTL_HOURS), false);
  assert.equal(isFresh({ checkedAt: new Date().toISOString() }, DEFAULT_TTL_HOURS), true);

  const entries = [{ baseUrl: null, apiKey: null, keyEnv: 'GW_API_KEY' }];
  await resolveHealth({ entries, store: { version: 1, entries: {} }, check: true });
  assert.equal(entries[0].health.status, 'env');
  assert.ok(entries[0].health.detail.includes('GW_API_KEY'));
});

test('healthPath respects ANYPROVIDER_HOME', () => {
  const p = healthPath({ ANYPROVIDER_HOME: '/tmp/somewhere' });
  assert.ok(p.includes('.anyprovider') && p.endsWith('key-health.json'));
});
