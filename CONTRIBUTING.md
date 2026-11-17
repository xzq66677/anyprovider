# Contributing

Thanks for helping. This project stays deliberately small: zero dependencies,
plain ESM, Node 18+.

## Setup

```bash
git clone <your fork>
cd anyprovider
node --test test/          # no install step, no dependencies
```

To exercise the CLI by hand, start the mock gateway first — it mimics the awkward
parts of real gateways (incomplete `/models`, a `/v1` path that only exists after
probing, one model that rejects every reasoning knob, an oversize `max_tokens`
that returns the real ceiling in the error message):

```bash
npm run mock                                  # prints a base URL and key
node src/cli.mjs --base <printed url> --key sk-test --target env
```

## Adding a target

1. Add `src/targets/<id>.mjs` exporting the object described at the top of
   `src/targets/_shared.mjs`.
2. Register it in `src/targets/index.mjs` (order controls the wizard menu).
3. Add a test in `test/targets.test.mjs` using a temporary directory — never the
   real home directory.
4. Document it in `docs/targets.md` and in both READMEs' target table.

Adapters never write files. They return `{ writes, notes, snippet }` and
`src/core/run.mjs` applies the safety policy (`merge` / `create` / `suggest`).

## Style

- No dependencies. If you think you need one, open an issue first.
- Comments explain *why*, especially where a format is surprising or was learned
  the hard way.
- Keep error messages actionable — say what to do next, not just what broke.
- `node --check` every file you touch; the CI matrix runs Node 18/20/22 on Linux,
  macOS and Windows.
