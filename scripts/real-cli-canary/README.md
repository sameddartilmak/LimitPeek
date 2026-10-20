# Real-CLI canary

Checks that our readers still understand what the **latest** release of each
third-party coding CLI writes to disk. A vendor that moves or reshapes its
usage files shows up here as a FAIL before a customer sees an empty row.

```
npm run canary:cli                                 # all tools
npm run canary:cli -- --only=qwen,kimi,grok        # a subset
npm run canary:cli -- --keep                       # keep the throwaway homes
npm run canary:cli -- --update-fixtures            # refresh test/fixtures/real-cli
```

It needs internet (npm registry, Google Cloud Storage for Grok). It is not part
of `npm test`. Windows only. No account, subscription or real API key is used.

## What it does

For each tool:

1. Finds the latest version: the npm registry's `latest` tag for
   `@qwen-code/qwen-code`, `@moonshot-ai/kimi-code`, `@openai/codex` and
   `@anthropic-ai/claude-code`; the `stable` channel file in the
   `grok-build-public-artifacts` bucket for Grok Build.
2. Installs it once per version into
   `%LOCALAPPDATA%\UsageNotch-canary\tools\<tool>\<version>`
   (`npm install --prefix`, never global; the Grok `.exe` is downloaded there
   and its Authenticode signature must be valid and from X.AI LLC / X Corp.
   before every run). The two newest versions per tool are kept.
3. Runs it once, headless, in a fresh home under
   `%LOCALAPPDATA%\UsageNotch-canary\runs\<stamp>\<tool>\home`, with
   `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and the tool's own
   `*_HOME` pointing there, every inherited `CLAUDE*`, `ANTHROPIC*`, `OPENAI*`,
   `CODEX*`, `QWEN*`, `KIMI*`, `GROK*`, `XAI*` and `npm_*` variable removed,
   and the model API pointed at `mock-server.js` on `127.0.0.1`.
4. Runs our reader from `src/core` over that home and checks the result.
5. Deletes the homes (unless `--keep`) and writes a JSON report.

| Tool | How it is run | Where our reader looks |
| --- | --- | --- |
| Qwen Code | `qwen --auth-type openai -p` with `OPENAI_BASE_URL`, `QWEN_HOME` | `.qwen/usage/token-usage-YYYY-MM.jsonl` |
| Kimi Code | `kimi -p` twice: `config.toml` provider (plan alias) and `KIMI_MODEL_*` env (alias `__kimi_env_model__`) | `.kimi-code/sessions/*/*/agents/*/wire.jsonl` |
| Grok Build | `grok --output-format plain -p <prompt>` with `GROK_XAI_API_BASE_URL`, `GROK_HOME` | `.grok/sessions/*/*/usage.json` |
| Codex CLI | `codex exec --skip-git-repo-check` with a `config.toml` model provider (`wire_api = "responses"`) | `.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Claude Code | `claude -p` with `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`, a fake `ANTHROPIC_API_KEY` | `.claude/projects/*/*.jsonl` |

## The fake model server

`mock-server.js` (Node built-ins only) answers OpenAI chat completions,
OpenAI Responses, Anthropic Messages (each streaming or not), Anthropic
`count_tokens` and `GET /models`. Every model call reports the same usage:

- prompt **1234** tokens, of which **1000** cached (uncached **234**)
- completion **56**, of which **7** reasoning
- xAI `cost_in_usd_ticks` **12345678** ($0.0012345678)

Routes it does not know get a 404 and are listed in the report
("mock had no route for ..."). Run it alone with
`node scripts/real-cli-canary/mock-server.js` to poke at a tool by hand.

## Reading the result

```
Tool         Version  Result  Reason
-----------  -------  ------  ------
Qwen Code    0.25.3   PASS    2 event(s), 2 call(s) counted of 2 served
Grok Build   1.0.62   PASS    1 event(s), 1 call(s) counted of 2 served
```

A PASS means the reader's totals are exactly *k* model calls' worth
(input 234k, cache read 1000k, cache write 0, output 56k) with
1 <= k <= the calls the mock served that tool, plus the per-tool contract
of `test/real-cli-output.test.js` (model ids, Kimi plan alias, Grok's reported
cost, Qwen priced above $0). "k of n served" below n is normal: tools make
background calls they never record (titles, memory extraction).

A FAIL gives the first reason in the table and the rest below it:

- **NO usage file where our reader looks** - the regression this exists for.
  The tool ran and was served, but wrote nothing where `src/core` reads. The
  report lists every file the tool wrote, with the ones that carry the mock's
  counts first: that is where the usage moved. Update the reader (and its
  header comment) from the vendor's source, then the fixture.
- **reader found 0 events** - the file is there, the format changed. The
  reason shows the record kinds found in it.
- **input/output/cacheRead ... expected ...** - the reader parses it but counts
  wrong (a field renamed, a total now inclusive, a double count).
- **models ...** - the model id or alias the tool records changed.
- **the mock was never called** - the tool did not reach the fake server (a
  CLI flag or environment variable changed); see the run's output tail.
- **signature refused** - the Grok binary is not validly signed by an accepted
  signer; it is deleted and not run.
- **REAL Claude config touched / changed during the run** (exit code 3) - see
  below.

Exit code: 0 all PASS, 1 any FAIL, 2 setup error, 3 real Claude config touched.
The JSON report (`%LOCALAPPDATA%\UsageNotch-canary\reports\canary-<stamp>.json`
and `last-report.json`) has per-tool run output tails, mock routes, files
written and totals. Personal paths in it are replaced by `<home>`, `<cache>`
and `~`.

## Claude Code safety

Claude Code is run with its home, config dir and app-data dirs all inside the
throwaway home, auto-update off, non-essential traffic off. It never runs
`claude update` and never touches any `claude.exe` other than the one it
started (leftover processes are matched by the canary's own cache path). The
real `~/.claude.json`, `~/.claude` (three levels deep) and any `CLAUDE_CONFIG_DIR`
are compared by mtime and size right before and after the run:

- a change carrying this run's random marker (it is in the prompt and the run
  directory name) is a leak: FAIL, exit 3, no fixture update;
- any other change also fails by default. A Claude Code session running at the
  same time can write there on its own; when the canary is launched from such
  a session, `--lenient-claude-home` lists those changes instead of failing.

Changed files are opened only to search for the marker; nothing in them is
logged and credential files are never opened.

## `--update-fixtures`

For each tool that PASSED and that `test/real-cli-output.test.js` covers
(Qwen, Kimi, Grok), replaces `test/fixtures/real-cli/<tool>/` with the fresh
output, using the rules in the test's header:

- Qwen: `usage/token-usage-*.jsonl` byte for byte;
- Kimi: each `wire.jsonl` trimmed to its `usage.record`, `forked` and
  `metadata` records, every other line replaced by `{type, trimmed, time}`;
- Grok: `usage.json` byte for byte, its `<encoded-cwd>` directory renamed to
  `C%3A%5Cwork`.

It refuses to write a fixture that contains your profile path or user name.
The test pins the old run's dates and versions, so the script prints what to
change in `test/real-cli-output.test.js` (versions, `NOW`, Grok's turn time);
make those edits and run `npm test`. Codex and Claude Code have no fixture in
that test, so they are checked but never copied.

## Housekeeping

Everything lives in `%LOCALAPPDATA%\UsageNotch-canary` (tools ~1 GB with two
versions each, an npm cache, reports). Deleting that folder is always safe.
