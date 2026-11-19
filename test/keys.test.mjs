import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addKey, readVault, removeKey, renameKey, resolveKey, vaultPath, writeVault,
} from '../src/core/keys.mjs';

function tempVault() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-vault-'));
  return join(dir, '.anyprovider', 'keys.json');
}

describe('local API key vault', () => {
  it('starts empty when the file does not exist', () => {
    assert.deepEqual(readVault(tempVault()), { version: 1, keys: [] });
  });

  it('honours ANYPROVIDER_HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ap-home-'));
    assert.equal(vaultPath({ ANYPROVIDER_HOME: dir }), join(dir, '.anyprovider', 'keys.json'));
  });

  it('adds keys and resolves them by index, alias or id', () => {
    const p = tempVault();
    const a = addKey({ name: '中转 A', baseUrl: 'https://a.example.com/v1', apiKey: 'sk-a' }, p);
    const b = addKey({ name: '中转 B', baseUrl: 'https://b.example.com/v1', apiKey: 'sk-b' }, p);
    assert.equal(readVault(p).keys.length, 2);

    const store = readVault(p);
    assert.equal(resolveKey('1', store).id, a.id);
    assert.equal(resolveKey('2', store).id, b.id);
    assert.equal(resolveKey('中转 b', store).id, b.id);
    assert.equal(resolveKey(b.id, store).name, '中转 B');
    assert.throws(() => resolveKey('nope', store), /找不到/);
    assert.throws(() => resolveKey('9', store), /没有第/);
  });

  it('rejects duplicates and empty fields without writing', () => {
    const p = tempVault();
    addKey({ name: 'A', baseUrl: 'https://a.example.com', apiKey: 'sk-a' }, p);
    assert.throws(() => addKey({ name: 'a', baseUrl: 'https://b.example.com', apiKey: 'sk-b' }, p), /同名/);
    assert.throws(() => addKey({ name: '', baseUrl: 'https://b.example.com', apiKey: 'sk-b' }, p), /名字/);
    assert.throws(() => addKey({ name: 'B', baseUrl: '', apiKey: 'sk-b' }, p), /地址/);
    assert.throws(() => addKey({ name: 'B', baseUrl: 'https://b.example.com', apiKey: '' }, p), /Key/);
    assert.equal(readVault(p).keys.length, 1);
  });

  it('renames and removes by any reference', () => {
    const p = tempVault();
    const a = addKey({ name: 'Old', baseUrl: 'https://a.example.com', apiKey: 'sk-a' }, p);
    addKey({ name: 'Other', baseUrl: 'https://o.example.com', apiKey: 'sk-o' }, p);

    renameKey('old', 'New', p);
    assert.equal(resolveKey('new', readVault(p)).id, a.id);
    assert.throws(() => renameKey('new', 'other', p), /同名/);

    removeKey(a.id, p);
    assert.deepEqual(readVault(p).keys.map((k) => k.name), ['Other']);
    assert.throws(() => removeKey('new', p), /找不到/);
  });

  it('keeps a backup and refuses to overwrite a damaged file', () => {
    const p = tempVault();
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, '{not json', 'utf8');
    assert.throws(() => readVault(p), /合法 JSON/);
    assert.throws(() => addKey({ name: 'A', baseUrl: 'https://a.example.com', apiKey: 'sk-a' }, p), /合法 JSON/);
    assert.equal(readFileSync(p, 'utf8'), '{not json');

    writeFileSync(p, JSON.stringify({ version: 1 }), 'utf8');
    assert.throws(() => readVault(p), /keys 数组/);

    writeFileSync(p, JSON.stringify({ version: 1, keys: [] }), 'utf8');
    writeVault({ version: 1, keys: [{ id: 'x' }] }, p);
    assert.equal(readVault(p).keys[0].id, 'x');
    assert.ok(readdirSync(join(p, '..')).some((f) => f.startsWith('keys.json.bak-')));
  });
});
