# Security

## API keys

`anyprovider` handles real credentials. A few things are deliberate:

- Keys are **never** passed on the command line by default — prefer `--key-file`
  or the `ANYPROVIDER_API_KEY` environment variable. `--key` exists, but it lands
  in your shell history.
- The wizard reads the key with echo disabled, and only echoes back its length
  and last four characters.
- A key that looks like a key is refused as a provider display name, because some
  harnesses render that name in their UI.
- Some targets necessarily store the key in plaintext (`claude-code`, `cline`,
  `env`, legacy opencode configs). Those files are as sensitive as your shell
  history; the tool does not encrypt anything.

## What gets written

Every write of an existing file is preceded by a timestamped backup
(`<file>.bak-<ISO timestamp>`), and files are written via a temp file + rename so
an interrupted run cannot leave a truncated config.

When a target cannot merge into an existing file with certainty (YAML files such
as Continue or LiteLLM, for example), the tool writes a sibling
`<file>.anyprovider.<ext>` suggestion instead of touching the original.

## Reporting a problem

Open an issue at the repository's issue tracker. If the problem involves a
credential, rotate it first — do not paste keys, tokens, or full config files
containing them into an issue.
