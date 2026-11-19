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
import { addKey, readVault, removeKey, renameKey, resolveKey, vaultPath } from './core/keys.mjs';
import { executePlan } from './core/run.mjs';
import { TARGETS, installedTargets, parseTargetSelection, supportsProtocol } from './targets/index.mjs';
import { printNotes, printResults, printSnippet } from './core/report.mjs';
import { banner, bold, cyan, dim, green, mask, note, say, step, table, warn } from './core/format.mjs';

const prompt = createPrompt();
const { ask, askHidden, confirm } = prompt;

const VERSION = '0.1.0';

/* Step numbers are allocated as we go, so choosing a saved key (which skips
   the URL/key/name questions) never leaves a gap in the displayed sequence. */
let stepNo = 0;
const nextStep = (title) => { stepNo += 1; step(stepNo, title); };

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

/** Rename / delete saved keys. Returns to the caller when the user backs out. */
async function manageVault(vault) {
  for (;;) {
    let saved;
    try { saved = readVault(vault).keys; } catch (err) { warn(`   ${err.message}`); return; }
    say('');
    if (!saved.length) { note('   Key 库是空的，先存一个再说。'); return; }
    table(
      ['#', '别名', '地址', 'Key'],
      saved.map((k, i) => [String(i + 1), k.name, k.baseUrl, mask(k.apiKey)]),
    );
    note('   r<序号> 改名   d<序号> 删除   回车返回');
    const answer = String(await ask(cyan('   › 管理：'), '')).trim();
    if (!answer || /^b(ack)?$/i.test(answer)) return;
    const m = answer.match(/^([rd])(\d+)$/i);
    if (!m) { warn('   没看懂，例：r1 / d2 / 回车'); continue; }
    try {
      const key = resolveKey(m[2], { keys: saved });
      if (m[1].toLowerCase() === 'r') {
        const nn = String(await ask(cyan(`   › 新别名 [${key.name}]：`), key.name)).trim();
        renameKey(key.id, nn, vault);
        note('   已改名。');
      } else if (await confirm(cyan(`   › 确认删除「${key.name}」？`), false)) {
        removeKey(key.id, vault);
        note('   已删除。');
      }
    } catch (err) { warn(`   ${err.message}`); }
  }
}

async function main() {
  banner(`anyprovider ${VERSION}`, '从一个 API Key 开始，把供应商接进任何 harness');

  /* 1. targets first — only the harnesses actually present on this machine */
  nextStep('你目前需要向哪个里面导入？（同一个 Key 可多选，稍后一键写入）');
  const installed = installedTargets();
  say('');
  if (installed.length) {
    table(
      ['#', 'id', '工具', '配置文件'],
      installed.map((t, i) => {
        let path = '—';
        try { path = t.defaultPath({ env: process.env }); } catch { /* keep defaults */ }
        return [String(i + 1), t.id, t.label, path];
      }),
    );
  } else {
    note('   本机没检测到已安装的 harness（没找到任何配置文件）。');
    note('   可直接输入 target id 或 A 指定目标；--list-targets 可查看全部 id。');
  }
  const fallback = installed.length ? installed.map((t) => t.id).join(' ') : '';
  say('');
  note('   上面只列本机已安装的 harness；序号 / id，空格或逗号分隔可多选');
  note('   回车 = 上面列出的全部；A = 全部；也可输入 id 指定未安装的项');

  let picked = [];
  for (;;) {
    const answer = await ask(cyan('   › 目标：'), fallback);
    const text = String(answer).trim();
    if (/^a(ll)?$/i.test(text) || text === '*') { picked = [...TARGETS]; break; }
    picked = parseTargetSelection(text, installed);
    if (picked.length) break;
    warn('   没选到任何目标，重输一次（例：1 3 或 zcode,opencode）');
  }
  note(`   已选 ${picked.length} 个：${picked.map((t) => t.id).join(', ')}`);

  /* 2. key source — reuse a saved key, or enter a new one */
  nextStep('这个 Key 从哪来？');
  const vault = vaultPath();
  let saved = [];
  try { saved = readVault(vault).keys; } catch (err) { warn(`   ${err.message}`); }

  let fromVault = null;
  for (;;) {
    say('');
    note('   1  输入一个新 Key');
    if (saved.length) note('   2  用已保存的 Key');
    const manageOpt = saved.length ? '3' : '2';
    note(`   ${manageOpt}  管理 Key 库（改名 / 删除）`);
    const answer = String(await ask(cyan('   › 来源：'), '1')).trim();
    if (answer === '1' || /^new$/i.test(answer)) break;
    if (answer === '2' && saved.length) {
      say('');
      table(
        ['#', '别名', '地址', 'Key'],
        saved.map((k, i) => [String(i + 1), k.name, k.baseUrl, mask(k.apiKey)]),
      );
      note('   输入序号选用；回车返回。');
      const pick = String(await ask(cyan('   › 选哪个 Key：'), '')).trim();
      if (!pick) continue;
      try { fromVault = resolveKey(pick, { keys: saved }); break; }
      catch (err) { warn(`   ${err.message}`); }
      continue;
    }
    if (answer === manageOpt) {
      await manageVault(vault);
      try { saved = readVault(vault).keys; } catch { saved = []; }
      continue;
    }
    warn('   没看懂，重输一次（例：1 / 2 / 3）');
  }

  let baseUrl, apiKey, providerName;
  if (fromVault) {
    ({ baseUrl, apiKey, name: providerName } = fromVault);
    note(`   已选用「${providerName}」 ${mask(apiKey)}`);
  } else {
    nextStep('API 地址是？');
    note('   例：https://api.example.com/v1    （带不带 /v1 都行，我会自己试）');
    for (;;) {
      const raw = await ask(cyan('   › 地址：'));
      try { baseUrl = normalizeBase(raw); break; }
      catch { warn('   这不像一个地址，再输一次（例：https://api.example.com/v1）'); }
    }

    nextStep('API Key 是？');
    note('   直接粘贴，回车确认（输入不回显）。');
    const typedKey = await askHidden(cyan('   › Key ：'));
    if (!typedKey) { warn('   没填 Key，退出。'); return 1; }
    apiKey = typedKey;
    note(`   已收到 ${mask(apiKey)}`);

    /* the user owns the display name; never silently rewrite their answer */
    const host = (() => { try { return new URL(baseUrl).host; } catch { return 'api'; } })();
    nextStep('给这个供应商起个名字？');
    note(`   名字由你定；直接回车才用域名建议值：${host}`);
    providerName = String(await ask(cyan('   › 显示名：'), '')).trim();
    if (!providerName) {
      providerName = host;
      note(`   用了建议值：${host}`);
    } else if (looksLikeKey(providerName, apiKey)) {
      warn(`   「${mask(providerName)}」看着像 API Key——名字你说了算，我就不替你改了。`);
      const keep = String(await ask(cyan('   › 仍用它？回车=保留，n=重输：'), 'y')).trim();
      if (/^n(o)?$/i.test(keep)) {
        providerName = String(await ask(cyan('   › 显示名：'), host)).trim() || host;
      }
    }
  }
  const providerId = providerIdFromHost(baseUrl);

  /* 5. probe */
  nextStep('正在探测这个网关 …');
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

  /* 6. selection */
  nextStep('要导入哪些模型？');
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

  /* 7. one-click apply to every harness picked in step 1 */
  nextStep(`一键写入 ${picked.length} 个工具`);
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
  note(`   上面 ${plans.length} 个工具会一次写入（同一个地址、同一个 Key）`);
  if (!(await confirm(cyan('   › 一键写入吗？'), true))) { note('   已取消，什么都没改。'); return 0; }

  const done = [];
  for (const { target, plan } of plans) {
    const { results, notes } = executePlan(plan, { dryRun: false });
    say(`\n   ${bold(target.label)}`);
    printResults(results);
    printNotes(notes);
    done.push(target.id);
  }

  say('');
  say(green(bold(`   ✓ 一键写入完成：${done.join(', ')}`)));
  say(dim('   改完配置要重启对应程序才会生效；ZCode 需要从托盘右键 Quit 再打开。'));

  /* a fresh key can be kept for next time — the user decides */
  if (!fromVault) {
    say('');
    if (await confirm(cyan(`   › 把「${providerName}」存进 Key 库，以后直接复用？`), true)) {
      try {
        const entry = addKey({ name: providerName, baseUrl, apiKey }, vault);
        note(`   已保存：${entry.name}（${entry.baseUrl}）；下次在「这个 Key 从哪来？」直接选它。`);
      } catch (err) {
        warn(`   没存进去：${err.message}`);
      }
    }
  }
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
