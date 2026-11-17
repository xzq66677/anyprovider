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
import { printDiscovery, printModels, printNotes, printResults, printSnippet } from './core/report.mjs';
import { TARGETS, TARGET_IDS, resolveTargets } from './targets/index.mjs';
import { bold, cyan, dim, fail, green, say, step, warn } from './core/format.mjs';

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
  say('    --target <ids>        comma separated, or "all"');
  say('');
  say(`  ${cyan('Discovery')}`);
  say('    --model <ids>         comma separated model ids (when /models is missing)');
  say('    --protocol <list>     restrict detection to chat,responses,anthropic');
  say('    --sample <n>          models to reasoning-probe (default 3, 0 = skip)');
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
  say('    --list-targets        show supported harnesses');
  say('');
  say(`  ${cyan('Targets')}  ${TARGET_IDS.join('  ')}`);
  say('');
}

async function readKey(args) {
  if (typeof args.keyFile === 'string') {
    const raw = readFileSync(args.keyFile, 'utf8').trim();
    if (!raw) throw new Error(`key file ${args.keyFile} is empty`);
    return raw.split(/\r?\n/)[0].trim();
  }
  if (typeof args.key === 'string') return args.key.trim();
  return (process.env.ANYPROVIDER_API_KEY || process.env.OPENAI_API_KEY || '').trim();
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
  if (args.version || args.v) { say(VERSION); return 0; }

  if (!args.base) { fail('\n  --base is required\n'); usage(); return 2; }
  if (!args.target) {
    fail('\n  --target is required (use --list-targets to see them, or "all")');
    return 2;
  }

  const apiKey = await readKey(args);
  if (!apiKey) {
    fail('\n  No API key: use --key-file, --key, or ANYPROVIDER_API_KEY');
    return 2;
  }

  const targets = resolveTargets(args.target);
  const quiet = !!args.json;

  const discovery = await discover({
    baseUrl: args.base,
    apiKey,
    modelIds: args.model ? String(args.model).split(/[,\s]+/).filter(Boolean) : [],
    protocols: args.protocol ? String(args.protocol).split(/[,\s]+/).filter(Boolean) : undefined,
    sample: args.sample !== undefined ? Number(args.sample) : DEFAULTS.sample,
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
  say('');
  return exitCode;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    fail(`\n  ${err?.message || err}\n`);
    process.exit(1);
  });
