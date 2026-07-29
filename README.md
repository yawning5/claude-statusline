# claude-statusline

A single-line status line for [Claude Code](https://claude.com/claude-code). No dependencies, one file.

```
▌ ~/dir │ main↑1↓2* │ Opus 5 (1M context) │ ctx 5% │ 5h 29% (2h13m) │ 7d 1%
```

On a subscription the API-equivalent cost is not what constrains you, so this shows the
**rate limit windows** instead — the 5-hour and 7-day usage — alongside context window use.

## Install

```sh
git clone <this-repo> ~/claude-statusline
~/claude-statusline/install.sh
```

`install.sh` merges the `statusLine` key into `~/.claude/settings.json` and backs up the
existing file first. Your other settings are left alone. Start a new session to pick it up.

To wire it up by hand instead, copy the `statusLine` block from `settings.example.json`
into `~/.claude/settings.json` and replace the path.

Requires Node 18+, which Claude Code already depends on.

## What each segment means

| Segment | Meaning |
|---|---|
| `~/dir` | Working directory. Deep paths collapse to `root/…/parent/dir`. |
| `main` | Git branch. Omitted outside a repo. |
| `↑2` | 2 commits on your branch that the upstream does not have — **unpushed**, run `git push`. |
| `↓3` | 3 commits on the upstream you do not have — **unpulled**, run `git pull`. |
| `↑1↓2` | Diverged. Pull or rebase before you can push. |
| `*` | Uncommitted changes, tracked or untracked. |
| `Opus 5` | Active model. |
| `ctx 5%` | Context window used. |
| `5h 29%` | 5-hour rate limit window used. |
| `(2h13m)` | Time until that window resets. `6d3h`, `2h13m`, `47m`, `<1m`. Omitted if Claude Code does not report a reset time. |
| `7d 1%` | 7-day rate limit window used. |

Counts come from the branch's configured upstream. A branch with no upstream
(`git checkout -b feature` and nothing else) shows no counts — there is nothing to compare
against. They are **not** relative to a parent branch; git does not record one.

Percentages turn green under 50%, yellow under 80%, red at or above. Values between 0 and
1% render as `<1%` rather than rounding down to a misleading `0%`.

## Terminal compatibility

Colour and glyphs adapt automatically, and can be forced:

| Variable | Effect |
|---|---|
| `NO_COLOR` (any value) | Drop colour. Follows the [NO_COLOR](https://no-color.org/) convention. |
| `FORCE_COLOR=0` | Drop colour. |
| `FORCE_COLOR=1\|2\|3` | Keep colour even when something else would disable it. |
| `TERM=dumb` | Drop colour. |
| `CLAUDE_STATUSLINE_STYLE=ascii` | Force the ASCII glyph set. |
| `CLAUDE_STATUSLINE_STYLE=unicode` | Force the Unicode glyph set. |

Glyphs default to Unicode when the locale (`LC_ALL`/`LC_CTYPE`/`LANG`) says UTF-8, or when
`TERM_PROGRAM`/`WT_SESSION` is set — terminals that render UTF-8 fine but often leave the
locale unset. Otherwise everything degrades to ASCII:

```
▌ ~/dir │ main↑1↓2* │ Opus 5 │ ctx 5% │ 5h 29% (2h13m)      unicode
| ~/dir | main^1v2* | Opus 5 | ctx 5% | 5h 29% (2h13m)      ascii
```

Only the 16 basic ANSI colours are used, so it renders the same everywhere and inherits
your terminal theme. No 256-colour or truecolor escapes.

Set these in your shell profile, not in the `statusLine` command — Claude Code runs the
command through your shell, so the environment carries over.

### One thing worth knowing if you fork this

Do not gate colour on `process.stdout.isTTY`. Claude Code captures the status line through
a **pipe**, so `isTTY` is always false and that check silently strips colour in every
terminal. `test/run.js` has a regression test for exactly this.

## Development

```sh
node test/run.js
```

43 checks covering percentage rounding, the reset countdown, path shortening, malformed
input, every colour and glyph switch, and the git segment against real temporary
repositories — ahead, behind, diverged, dirty, detached HEAD, no upstream, and a repo with
no commits yet.

Fixtures carry no absolute timestamps. Countdown cases build `resets_at` relative to the
current time so they do not rot.

`statusline.js` reads Claude Code's session JSON on stdin. To see the real payload:

```sh
echo '{}' | node statusline.js          # minimal
```

To capture what your own session sends, add a one-line dump at the top of the stdin `end`
handler, look at the file, then take it back out.

## Design notes

`docs/design.md` records the decisions and the git output shapes the parser handles.
