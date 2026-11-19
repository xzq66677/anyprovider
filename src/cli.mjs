#!/usr/bin/env node
/**
 * anyprovider — probe an unknown LLM gateway, then write the config your coding
 * agent needs.
 *
 *   anyprovider --base https://api.example.com/v1 --key-file ./key.txt --target opencode
 *
 * Nothing is written without --write; the default is a dry run that prints what
 * would change.
 */

import { readFileSync } from 'node:fs';
import { DEFAULTS, discover } from './core/probe.mjs';
import { providerIdFromHost } from './core/endpoints.mjs';
import { executePlan } from './core/run.mjs';
import { createPrompt } from './core/prompt.mjs';
import { addKey, readVault, resolveKey, vaultPath } from './core/keys.mjs';
import { printDiscovery, printKeyInventory, printModels, printNotes, printResults, printSnippet } from './core/report.mjs';
import { buildInventory } from './core/keyscan.mjs';
import { TARGETS, TARGET_IDS, installedTargets, resolveTargets, parseTargetSelection, supportsProtocol } from './targets/index.mjs';
import { bold, cyan, dim, fail, green, mask, note, say, step, table, warn } from './core/format.mjs';

const VERSION = '0.1.0';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) { args._.push(token); continue; }
    const body = token.replace(/^--?/, '');
    const eq = body.indexOf('=');
    const rawKey = eq >= 0 ? body.slice(0, eq) : body;
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq >= 0) { args[key] = body.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

function usage() {
  say('');
  say(`  ${bold('anyprovider')} ${dim(VERSION)} — one probe, every harness.`);
  say('');
  say(`  ${cyan('Usage')}`);
  say('    anyprovider --base <url> --key <key> --target <ids> [--write]');
  say('');
  say(`  ${cyan('Required')}`);
  say('    --base <url>          gateway base URL (with or without /v1)');
  say('    --key-file <path>     file containing the API key (preferred)');
  say('    --key <key>           API key inline (visible in shell history)');
  say('                          or set ANYPROVIDER_API_KEY / OPENAI_API_KEY');
  say('    --target <ids>        comma separated; "all" = every adapter, "installed" = found on disk');
  say('                          omit to be asked which tool to import into');
  say('');
  say(`  ${cyan('Discovery')}`);
  say('    --model <ids>         comma separated model ids (when /models is missing)');
  say('    --protocol <list>     restrict detection to chat,responses,anthropic');
  say('    --sample <n>          models to reasoning-probe (default 3, 0 = skip)');
  say('    --vision-sample <n>   models to image-probe (default 3, 0 = skip)');
  say('    --deep                probe every model individually (slow, thorough)');
  say('    --default-context <n> context window when the gateway reports none (128000)');
  say('    --default-maxout <n>  max output when it cannot be probed (32000)');
  say('    --timeout <ms>        per-request timeout (30000)');
  say('');
  say(`  ${cyan('Output')}`);
  say('    --write               actually write configs (default: dry run)');
  say('    --name <text>         display name (default: host)');
  say('    --id <text>           provider id (default: derived from host)');
  say('    --json                machine-readable discovery output');
  say('    --interactive         ask for the import target even without a TTY');
  say('    --list-targets        show supported harnesses');
  say('');
  say(`  ${cyan('Key vault')}  (~/.anyprovider/keys.json)`);
  say('    --key-list            list saved keys (masked)');
  say('    --key-from <ref>      use a saved key by alias, id or 1-based index');
  say('                          also supplies --base when it is omitted');
  say('    --key-save            save this key under --name (or the host) for reuse');
  say('');
  say(`  ${cyan('Key inventory')}`);
  say('    --keys-status         list keys already stored in local harnesses + vault');
  say('    --check               with --keys-status: probe validity via free GET /models');
  say('    --force               ignore the 24h cache and re-check');
  say('    --check-ttl <hours>   cache lifetime in hours (default 24)');
  say('                          combines with --json for machine-readable output');
  say('');
  say(`  ${cyan('Targets')}  ${TARGET_IDS.join('  ')}`);
  say('');
}

async function readKey(args, saved = null) {
  if (typeof args.keyFile === 'string') {
    const raw = readFileSync(args.keyFile, 'utf8').trim();
    if (!raw) throw new Error(`key file ${args.keyFile} is empty`);
    return raw.split(/\r?\n/)[0].trim();
  }
  if (typeof args.key === 'string') return args.key.trim();
  if (saved) return saved.apiKey;
  return (process.env.ANYPROVIDER_API_KEY || process.env.OPENAI_API_KEY || '').trim();
}

/**
 * Ask which harness to import into. Shared by the CLI (when --target is
 * omitted) so a terminal user gets the same guided experience as the wizard.
 * Accepts indexes, ids, "all", or an empty answer for the detected defaults.
 */
export async function chooseTargets({ question, input, output } = {}) {
  const prompt = createPrompt({ input, output });
  const { ask } = prompt;
  try {
    const found = installedTargets();
    say('');
    if (found.length) {
      table(
        ['#', 'id', 'tool', 'config'],
        found.map((t, i) => {
          let path = '-';
          try { path = t.defaultPath({ env: process.env }); } catch { /* keep defaults */ }
          return [String(i + 1), t.id, t.label, path];
        }),
      );
    } else {
      note('   No installed harness detected on this machine.');
      note('   Type a target id (or "all") to continue; --list-targets shows every id.');
    }
    say('');
    note('   Only locally installed harnesses are listed.   Enter = all listed   id / all = any target');
    const fallback = found.length ? found.map((t) => t.id).join(' ') : '';
    const answer = await ask(cyan(question || '   › Which tool should I import into?'), fallback);

    return parseTargetSelection(answer, found);
  } finally {
    prompt.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { usage(); return 0; }
  if (args.listTargets) {
    say('');
    for (const t of TARGETS) {
      say(`  ${cyan(t.id.padEnd(12))} ${t.label}${t.homepage ? dim(`  ${t.homepage}`) : ''}`);
    }
    say('');
    return 0;
  }
  if (args.keyList) {
    let store;
    try { store = readVault(vaultPath()); }
    catch (err) { fail(`\n  ${err.message}`); return 2; }
    say('');
    if (!store.keys.length) {
      note('  Key 库是空的 —— 用 --key-save 保存一个，或用向导的「存进 Key 库」。');
    } else {
      table(
        ['#', 'name', 'base URL', 'key'],
        store.keys.map((k, i) => [String(i + 1), k.name, k.baseUrl, mask(k.apiKey)]),
      );
    }
    say('');
    return 0;
  }
  if (args.keysStatus) {
    const check = !!args.check;
    const force = !!args.force;
    const ttl = args.checkTtl !== undefined ? Number(args.checkTtl) : undefined;
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0)) {
      fail('\n  --check-ttl must be a number of hours (>= 0)');
      return 2;
    }
    let result;
    try {
      result = await buildInventory({
        check,
        force,
        ...(ttl !== undefined ? { ttlHours: ttl } : {}),
        ...(check && !args.json ? { onProgress: (kind, e) => {
          if (kind === 'checked') warn(`  检测 ${e.platform}: ${e.health.status}`);
        } } : {}),
      });
    } catch (err) { fail(`\n  ${err.message}`); return 2; }
    if (result.warnings.length) for (const w of result.warnings) warn(`  ${w}`);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        entries: result.entries.map((e) => ({
          platform: e.platform,
          names: e.names,
          apiKeyMasked: e.apiKey ? `${e.apiKey.slice(0, 6)}…${e.apiKey.slice(-4)}` : null,
          keyEnv: e.keyEnv,
          sources: e.sources,
          health: e.health,
        })),
      }, null, 2)}\n`);
      return 0;
    }
    say('');
    step(1, check ? '已存 Key 一览（含有效性检测）' : '已存 Key 一览');
    printKeyInventory(result.entries, { checked: check });
    return 0;
  }

  if (args.version || args.v) { say(VERSION); return 0; }

  let savedKey = null;
  if (args.keyFrom !== undefined) {
    if (args.keyFrom === true) {
      fail('\n  --key-from needs a reference (alias, id or index); use --key-list to see them');
      return 2;
    }
    try { savedKey = resolveKey(String(args.keyFrom), readVault(vaultPath())); }
    catch (err) { fail(`\n  ${err.message}`); return 2; }
    if (!args.base) args.base = savedKey.baseUrl;
  }

  if (!args.base) { fail('\n  --base is required\n'); usage(); return 2; }
  const apiKey = await readKey(args, savedKey);
  if (!apiKey) {
    fail('\n  No API key: use --key-file, --key, --key-from, or ANYPROVIDER_API_KEY');
    return 2;
  }

  const quiet = !!args.json;
  let targets;
  if (args.target) {
    targets = resolveTargets(args.target);
  } else if (!quiet && (process.stdin.isTTY || args.interactive)) {
    const picked = await chooseTargets({ question: '   › 你目前需要向哪个里面导入？' });
    if (!picked.length) { fail('\n  No target selected.'); return 2; }
    targets = picked;
  } else {
    fail('\n  --target is required (use --list-targets to see them, "all", or run without it to be asked)');
    return 2;
  }

  const discovery = await discover({
    baseUrl: args.base,
    apiKey,
    modelIds: args.model ? String(args.model).split(/[,\s]+/).filter(Boolean) : [],
    protocols: args.protocol ? String(args.protocol).split(/[,\s]+/).filter(Boolean) : undefined,
    sample: args.sample !== undefined ? Number(args.sample) : DEFAULTS.sample,
    visionSample: args.visionSample !== undefined ? Number(args.visionSample) : DEFAULTS.visionSample,
    deep: !!args.deep,
    timeout: args.timeout ? Number(args.timeout) : DEFAULTS.timeout,
    defaults: {
      ...(args.defaultContext ? { contextWindow: Number(args.defaultContext) } : {}),
      ...(args.defaultMaxout ? { maxOutputTokens: Number(args.defaultMaxout) } : {}),
    },
    onEvent: quiet ? undefined : (kind, payload) => {
      if (kind === 'models') warn(`  models: ${payload.count} from ${payload.url}`);
      if (kind === 'protocol-attempt' && payload.ok) warn(`  protocol: ${payload.protocol} (${payload.url})`);
      if (kind === 'max-output') warn(`  max output: ${payload.ceiling ?? 'unknown'} (applies to ${payload.appliesTo})`);
      if (kind === 'vision') warn(`  vision: ${payload.model} → ${payload.supported === true ? 'yes' : payload.supported === false ? 'no' : 'unknown'}`);
    },
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ discovery, targets: targets.map((t) => t.id) }, null, 2)}\n`);
    return discovery.protocol ? 0 : 1;
  }

  printDiscovery(discovery);
  printNotes(discovery.notes);

  if (!discovery.protocol || !discovery.models.length) {
    fail('\n  Could not map this gateway. See the notes above.');
    return 1;
  }

  const wanted = args.model ? String(args.model).split(/[,\s]+/).filter(Boolean) : null;
  let selected = discovery.models;
  if (wanted) {
    const byId = new Map(discovery.models.map((m) => [m.id, m]));
    selected = wanted.map((id) => byId.get(id)).filter(Boolean);
    const missing = wanted.filter((id) => !byId.has(id));
    if (missing.length) warn(`  requested model(s) not offered by the gateway: ${missing.join(', ')}`);
    if (!selected.length) { fail('\n  None of the requested models exist.'); return 1; }
  }
  printModels(selected);

  const providerId = args.id || providerIdFromHost(discovery.baseUrl);
  const providerName = args.name || new URL(discovery.baseUrl).host;

  const dryRun = !args.write;
  let exitCode = 0;
  let stepIndex = 0;

  for (const target of targets) {
    stepIndex += 1;
    step(stepIndex, `${target.label}`);
    if (!supportsProtocol(target, discovery.protocol)) {
      warn(`   skipped: this gateway speaks ${discovery.protocol}, ${target.label} needs ${target.protocols.join('/')}`);
      continue;
    }
    try {
      const plan = target.plan({
        discovery,
        selected,
        providerId,
        providerName,
        baseUrl: discovery.baseUrl,
        apiKey,
        path: null,
      });
      const { results, notes } = executePlan(plan, { dryRun, log: () => {} });
      printResults(results);
      printNotes(notes);
      printSnippet(plan.snippet);
    } catch (err) {
      exitCode = 1;
      fail(`\n  ${target.label}: ${err.message}`);
    }
  }

  say('');
  if (dryRun) {
    warn('  Dry run — nothing was written. Re-run with --write to apply.');
  } else if (exitCode === 0) {
    say(`  ${green('✓')} Config written for ${targets.map((t) => t.id).join(', ')}.`);
    say(dim('  Restart the applications involved so they reload their config.'));
  } else {
    warn('  Some targets failed — see the messages above. The others were written.');
  }

  if (args.keySave) {
    const name = typeof args.name === 'string' && args.name ? args.name : new URL(discovery.baseUrl).host;
    try {
      addKey({ name, baseUrl: discovery.baseUrl, apiKey }, vaultPath());
      say(`  ${green('✓')} Key「${name}」saved to vault — reuse with --key-from "${name}".`);
    } catch (err) {
      warn(`  Could not save key: ${err.message}`);
    }
  }
  say('');
  return exitCode;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    fail(`\n  ${err?.message || err}\n`);
    process.exit(1);
  });
