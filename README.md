# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kunala23/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kunala23/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` — one patch tool for every AI edit format. It applies an edit that an
AI model wrote to a tree of text files, reading any of four formats to one
specification: unified diffs (even with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, and text-editor tool calls as JSON. Every file changes,
or nothing does.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / absent to read the patch from standard
input. `--format` picks one format (`unified`, `search-replace`, `v4a`,
`json`); `auto`, the default, detects it. `--check` reports what would
change without writing anything. `--strict` matches lines exactly, skipping
the whitespace-tolerant tiers.

An edit's old lines are found at the first of three matching tiers that has
an occurrence: exact, trailing whitespace ignored, then leading and trailing
whitespace ignored (with new lines re-indented to the file's own indent).
Unified hunks take the occurrence nearest their stated line number;
SEARCH/REPLACE blocks fail as ambiguous when the old lines occur more than
once; V4A chunks walk a cursor through the file, anchored by `@@` lines and
pinned to the end of the file by `*** End of File`.

Exit codes: `0` with one line per changed file (`A`/`D`/`M`, or `R old -> new`
for a move) plus `ok: <n> files`; `1` with one `error: <code> <path>` line per
failed edit plus `failed: <k> of <n> edits`, and no file written; `2` with a
single `error: ...` line for usage, unreadable patch, undetected format, or
parse errors.

## Files

- `main.ts` — the whole CLI. Node 22 and its standard library only; nothing
  is installed before it runs. When `MAKEFUN_ENV_URL` is set it hands the
  trial over to `runner.ts`, as the kit specifies.
- `runner.ts` — the kit's trial runner, kept as shipped.
- `LICENSE` — MIT.

## Local grading

The kit's practice set (100 checks with the house reference's expected
outcomes) is run with the check harness in the work directory; this entry
passes 100 of 100 on it, plus a hand-written edge suite covering sentences
of the specification the practice set does not show (usage errors, parse
faults, renames, CRLF and no-newline-at-end-of-file handling, tier-2
re-indentation, ambiguous blocks, V4A anchors and end-of-file chunks, JSON
fault lines, and all-or-nothing atomicity).

---

<sub>Entered on [make.fun](https://make.fun/?ref=t1ajmem7&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
