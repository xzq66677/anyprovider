/**
 * Human-readable reporting shared by the CLI and the wizard.
 */

import { bullet, dim, green, mask, note, red, say, table, yellow } from './format.mjs';

/** Compact, human-readable vision label with colour. */
export function visionText(vision) {
  if (vision === 'yes') return green('yes');
  if (vision === 'no') return yellow('no');
  if (vision === 'unknown') return yellow('unknown');
  return dim('not probed');
}

export function printDiscovery(discovery) {
  say('');
  say(`  ${dim('base URL')}  ${discovery.baseUrl}`);
  say(`  ${dim('format  ')}  ${discovery.format || dim('unknown')}`);
  say(`  ${dim('models  ')}  ${discovery.models.length} (from ${discovery.modelsEndpoint || 'manual list'})`);
  if (discovery.providerReasoning) {
    say(`  ${dim('reasoning')} ${green(discovery.providerReasoning)}`);
  } else {
    say(`  ${dim('reasoning')} ${yellow('none accepted')}`);
  }
  const visionParts = Object.entries(discovery.visionVotes || {});
  if (visionParts.length) {
    const summary = visionParts.map(([k, v]) => `${k}:${v}`).join('  ');
    say(`  ${dim('vision   ')} ${discovery.providerVision ? green(providerVisionText(discovery.providerVision)) : yellow('mixed/unknown')}  ${dim(`(${summary})`)}`);
  } else {
    say(`  ${dim('vision   ')} ${dim('not probed')}`);
  }
}

function providerVisionText(v) {
  return v === 'yes' ? 'some models accept images' : 'most models reject images';
}

export function printModels(models) {
  say('');
  table(
    ['#', 'model id', 'context', 'max out', 'reasoning', 'vision'],
    models.map((m, i) => [
      String(i + 1),
      m.id,
      String(m.contextWindow),
      String(m.maxOutputTokens),
      m.reasoning || '-',
      visionText(m.vision),
    ]),
  );
}

export function printNotes(notes = []) {
  if (!notes.length) return;
  say('');
  for (const line of notes) bullet(line.startsWith('  ') ? dim(line.trim()) : dim(line));
}

export function printSnippet(snippet) {
  if (!snippet) return;
  say('');
  say(dim('  --- snippet ---'));
  for (const line of snippet.split('\n')) say(`  ${line}`);
}

export function printResults(results) {
  say('');
  for (const r of results) {
    const action = r.dryRun ? 'would write' : 'wrote';
    say(`  ${green('✓')} ${action} ${r.path}${r.dryRun ? '' : ` ${dim(`(${r.bytes} bytes)`)}`}`);
    if (r.backedUp) note(`    backup: ${r.backedUp}`);
  }
}

/** Human colour/label for a key-health status. */
export function healthText(h) {
  if (!h) return dim('未检测');
  const map = {
    valid: green('✓ 有效'),
    invalid: red('✗ 失效'),
    unknown: yellow('? 未知'),
    env: yellow('$ 环境变量'),
    unchecked: dim('未检测'),
  };
  return map[h.status] || dim(h.status || '未检测');
}

/**
 * Print the key inventory table. Each row is one credential, with the
 * platforms/hosts and the harnesses it appears in.
 */
export function printKeyInventory(entries, { checked = false } = {}) {
  say('');
  if (!entries.length) {
    note('  本机没有找到已存的 API Key。先用向导导入一个，或用 --key-save 存进 Key 库。');
    say('');
    return;
  }
  table(
    ['#', '平台', 'Key', '状态', '来自'],
    entries.map((e, i) => [
      String(i + 1),
      e.platform || '未知',
      e.apiKey ? mask(e.apiKey) : (e.keyEnv ? `$${e.keyEnv}` : '-'),
      healthText(e.health),
      e.sources.join('、'),
    ]),
  );
  say('');
  for (const e of entries) {
    if (e.health?.detail) note(`   ${e.platform}: ${dim(e.health.detail)}${e.health.cached ? dim('（缓存）') : ''}`);
  }
  say('');
  note('   检测用的是 GET /models（只验鉴权、不生成内容、通常免费）；结果缓存 24h，不会每次都发请求。');
  if (!checked) note('   现在只显示缓存/未检测。加 --check 才发请求；--force 忽略缓存强制重测。');
  say('');
}

