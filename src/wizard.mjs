#!/usr/bin/env node
/**
 * anyprovider wizard — the same engine as the CLI, but it asks instead of
 * taking flags. Designed for people who have a key and a base URL and nothing
 * else, and for double-clicking (the launcher keeps the window open).
 */

import { existsSync } from 'node:fs';
import { DEFAULTS, discover } from './core/probe.mjs';
import { normalizeBase, providerIdFromHost } from './core/endpoints.mjs';
import { createPrompt } from './core/prompt.mjs';
import { executePlan } from './core/run.mjs';
import { TARGETS, parseTargetSelection, supportsProtocol } from './targets/index.mjs';
import { printNotes, printResults, printSnippet } from './core/report.mjs';
import { banner, bold, cyan, dim, green, mask, note, say, step, table, warn } from './core/format.mjs';

const prompt = createPrompt();
const { ask, askHidden, confirm } = prompt;

const VERSION = '0.1.0';

function looksLikeKey(value, apiKey) {
  return value === apiKey
    || /^sk-[A-Za-z0-9_-]{16,}$/.test(value)
    || /^[0-9a-f]{32,}$/i.test(value)
    || (apiKey.length >= 12 && value.includes(apiKey.slice(0, 12)));
}

function parseSelection(answer, count) {
  const text = String(answer || '').trim();
  if (!text || text === '*' || /^a(ll)?$/i.test(text)) return { all: true };
  if (/^q(uit)?$/i.test(text)) return { quit: true };
  if (/^m\b/i.test(text)) return { manual: text.replace(/^m\b\s*/i, '') };

  const indexes = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) indexes.push(i - 1);
      continue;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > count) return { invalid: true };
    indexes.push(n - 1);
  }
  return indexes.length ? { indexes: [...new Set(indexes)] } : { invalid: true };
}

async function main() {
  banner(`anyprovider ${VERSION}`, '从一个 API Key 开始，把供应商接进任何 harness');

  /* 1. base URL */
  step(1, 'API 地址是？');
  note('   例：https://api.example.com/v1    （带不带 /v1 都行，我会自己试）');
  let baseUrl;
  for (;;) {
    const raw = await ask(cyan('   › 地址：'));
    try {
      baseUrl = normalizeBase(raw);
      break;
    } catch {
      warn('   这不像一个地址，再输一次（例：https://api.example.com/v1）');
    }
  }

  /* 2. key */
  step(2, 'API Key 是？');
  note('   直接粘贴，回车确认（输入不回显）。');
  const apiKey = await askHidden(cyan('   › Key ：'));
  if (!apiKey) { warn('   没填 Key，退出。'); return 1; }
  note(`   已收到 ${mask(apiKey)}`);

  /* 3. name */
  const host = (() => { try { return new URL(baseUrl).host; } catch { return 'api'; } })();
  step(3, '给这个供应商起个名字？');
  let providerName = await ask(cyan('   › 显示名：'), host);
  if (looksLikeKey(providerName, apiKey)) {
    warn(`   这串看着像 API Key，不适合当名字，改用域名：${host}`);
    providerName = host;
  }
  const providerId = providerIdFromHost(baseUrl);

  /* 4. probe */
  step(4, '正在探测这个网关 …');
  const discovery = await discover({
    baseUrl,
    apiKey,
    onEvent: (kind, payload) => {
      if (kind === 'models') note(`   ✓ 模型列表 ${payload.count} 个（${payload.url}）`);
      if (kind === 'models-none') note('   · 没有 /models 列表');
      if (kind === 'protocol-attempt' && payload.ok) note(`   ✓ API 格式 ${payload.protocol}（${payload.url}）`);
      if (kind === 'max-output') note(`   ✓ 最大输出 ${payload.ceiling ?? '未知'}（影响 ${payload.appliesTo} 个模型）`);
      if (kind === 'reasoning' && payload.param) note(`   · ${payload.model} 接受 ${payload.param}`);
      if (kind === 'vision') note(`   ${payload.supported === true ? '✓' : '·'} ${payload.model} 图像输入：${payload.supported === true ? '支持' : payload.supported === false ? '不支持' : '未知'}`);
    },
  });

  if (discovery.authError) {
    warn(`   ✗ Key 被拒绝：${discovery.authError}`);
    return 1;
  }

  if (!discovery.models.length) {
    warn('   这个网关没有提供 /models 列表，只能手工填模型 ID。');
    const typed = await ask(cyan('   › 模型 ID（多个用逗号分隔）：'));
    const ids = typed.split(/[,\s，]+/).filter(Boolean);
    if (!ids.length) { warn('   没有模型，退出。'); return 1; }
    const again = await discover({ baseUrl, apiKey, modelIds: ids });
    Object.assign(discovery, again);
  }

  if (!discovery.protocol) {
    warn('   ✗ 三种 API 格式都没通，可能地址或 Key 不对。');
    printNotes(discovery.notes);
    return 1;
  }

  note(`   格式 ${discovery.format}   推理 ${discovery.providerReasoning || '不支持'}`);

  /* 5. selection */
  step(5, '要导入哪些模型？');
  say('');
  const visionLabel = (v) => v === 'yes' ? '支持' : v === 'no' ? '不支持' : v === 'unknown' ? '未知' : '-';
  table(
    ['#', '模型 ID', '上下文', '最大输出', '推理', '视觉'],
    discovery.models.map((m, i) => [
      String(i + 1), m.id, String(m.contextWindow), String(m.maxOutputTokens), m.reasoning || '-', visionLabel(m.vision),
    ]),
  );
  say('');
  note('   回车 = 全部    1,3-5 = 指定序号    M 模型ID = 手工指定    Q = 退出');

  let chosen;
  for (;;) {
    const answer = await ask(cyan('   › 选择：'));
    const parsed = parseSelection(answer, discovery.models.length);
    if (parsed.quit) { note('   已退出，什么都没改。'); return 0; }
    if (parsed.invalid) { warn('   没看懂，重输一次。'); continue; }
    if (parsed.all) { chosen = discovery.models; break; }
    if (parsed.indexes) { chosen = parsed.indexes.map((i) => discovery.models[i]); break; }
    const ids = String(parsed.manual).split(/[,\s，]+/).filter(Boolean);
    if (!ids.length) { warn('   没写模型 ID。'); continue; }
    const byId = new Map(discovery.models.map((m) => [m.id, m]));
    chosen = ids.map((id) => byId.get(id) || {
      id,
      contextWindow: DEFAULTS.contextWindow,
      maxOutputTokens: DEFAULTS.maxOutputTokens,
      reasoning: discovery.providerReasoning,
      manual: true,
    });
    break;
  }

  /* 6. targets */
  step(6, '写进哪些工具？');
  say('');
  table(
    ['#', 'id', '工具', '配置文件', '状态'],
    TARGETS.map((t, i) => {
      let path = '—';
      let state = dim('—');
      try {
        path = t.defaultPath({ env: process.env });
        state = existsSync(path) ? green('已安装') : dim('未找到');
      } catch { /* keep defaults */ }
      return [String(i + 1), t.id, t.label, path, state];
    }),
  );
  const installed = TARGETS.filter((t) => {
    try { return existsSync(t.defaultPath({ env: process.env })); } catch { return false; }
  });
  const fallback = installed.length ? installed.map((t) => t.id) : ['env'];
  say('');
  note('   空格或逗号分隔序号 / id，回车 = 上面状态为「已安装」的那些');

  const answer = await ask(cyan('   › 目标：'), fallback.join(' '));
  const picked = parseTargetSelection(answer);
  if (!picked.length) { warn('   没选任何目标，退出。'); return 1; }

  /* 7. preview + apply */
  step(7, '预览');
  const plans = [];
  for (const target of picked) {
    if (!supportsProtocol(target, discovery.protocol)) {
      warn(`   ✗ ${target.label}: 这个网关是 ${discovery.protocol} 格式，它只认 ${target.protocols.join('/')}，跳过`);
      continue;
    }
    try {
      plans.push({ target, plan: target.plan({ discovery, selected: chosen, providerId, providerName, baseUrl, apiKey, path: null }) });
    } catch (err) {
      warn(`   ✗ ${target.label}: ${err.message}`);
    }
  }
  if (!plans.length) { warn('   没有可写的目标。'); return 1; }

  for (const { target, plan } of plans) {
    say(`\n   ${bold(target.label)}`);
    for (const write of plan.writes) say(`     文件 ${write.path}  ${dim(`(${write.mode || 'merge'})`)}`);
    printNotes(plan.notes);
    printSnippet(plan.snippet);
  }

  say('');
  if (!(await confirm(cyan('   › 写入吗？'), true))) { note('   已取消，什么都没改。'); return 0; }

  for (const { target, plan } of plans) {
    const { results, notes } = executePlan(plan, { dryRun: false });
    say(`\n   ${bold(target.label)}`);
    printResults(results);
    printNotes(notes);
  }

  say('');
  say(green(bold('   ✓ 完成')));
  say(dim('   改完配置要重启对应程序才会生效；ZCode 需要从托盘右键 Quit 再打开。'));
  return 0;
}

main()
  .then(async (code) => {
    await prompt.pause(dim('\n按回车关闭窗口 …'));
    process.exit(code ?? 0);
  })
  .catch(async (err) => {
    warn(`\n出错了：${err?.message || err}`);
    await prompt.pause(dim('\n按回车关闭 …'));
    process.exit(1);
  });
