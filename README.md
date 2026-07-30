# claude-statusline

[![test](https://github.com/yawning5/claude-statusline/actions/workflows/test.yml/badge.svg)](https://github.com/yawning5/claude-statusline/actions/workflows/test.yml)

A single-line status line for [Claude Code](https://claude.com/claude-code). No dependencies, one file.

```
▌ ~/dir │ main │ Opus 5 (1M context) │ ctx 5% │ 5h 29% (2h13m) │ 7d 1%
```

On a subscription the API-equivalent cost is not what constrains you, so this shows the
**rate limit windows** instead — the 5-hour and 7-day usage — alongside context window use.

## Install

Requires Node 18+, which Claude Code already depends on. Nothing else.

```sh
git clone https://github.com/yawning5/claude-statusline.git ~/claude-statusline
bash ~/claude-statusline/install.sh
```

Then start a new Claude Code session, or run `/statusline`, to pick it up.

`install.sh` merges the `statusLine` key into `~/.claude/settings.json` and backs the file
up first. Your other settings — theme, model, plugins — are left alone.

Run it with `bash` rather than `./install.sh`: downloading a ZIP or uploading through the
GitHub web UI drops the executable bit, and `bash` works either way. If you would rather
have it back:

```sh
chmod +x ~/claude-statusline/install.sh ~/claude-statusline/statusline.js
```

### Windows

`install.ps1` does the same thing without Git Bash, in either Windows PowerShell 5.1 or
PowerShell 7:

```powershell
git clone https://github.com/yawning5/claude-statusline.git $HOME\claude-statusline
& $HOME\claude-statusline\install.ps1
```

If PowerShell refuses to run it, the execution policy is blocking local scripts:

```powershell
powershell -ExecutionPolicy Bypass -File $HOME\claude-statusline\install.ps1
```

Both installers hand the JSON merge to `merge-settings.js`, so they cannot drift apart —
and the merge stays in Node deliberately. PowerShell's `ConvertTo-Json` flattens anything
past its default depth of 2, which would turn a real settings file's nested `hooks` block
into the string `"@{hooks=System.Object[]}"`.

### By hand

If you would rather not run a script, copy the `statusLine` block from
`settings.example.json` into `~/.claude/settings.json` and put your own absolute path in it:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/home/you/claude-statusline/statusline.js\"",
    "padding": 0
  }
}
```

Merge that key into the existing file — do not replace the whole thing, or you will drop
your other settings. Use double quotes around the path so the command also works when
`cmd.exe` runs it.

### Check it works

```sh
echo '{}' | node ~/claude-statusline/statusline.js
```

That should print a status line for your current directory. If it prints nothing, Node is
not on your `PATH` where Claude Code can see it.

## What each segment means

| Segment | Meaning |
|---|---|
| `~/dir` | Working directory. Deep paths collapse to `root/…/parent/dir`. |
| `main` | Git branch, read from `.git/HEAD`. Omitted outside a repo. Detached HEAD shows the short commit id. |
| `Opus 5` | Active model. |
| `ctx 5%` | Context window used. |
| `5h 29%` | 5-hour rate limit window used. |
| `(2h13m)` | Time until that window resets. `6d3h`, `2h13m`, `47m`, `<1m`. Omitted if Claude Code does not report a reset time. |
| `7d 1%` | 7-day rate limit window used. |

**The status line never runs git.** The branch name is read out of `.git/HEAD` — no
subprocess, on any render. That is a deliberate trade: a dirty-tree marker and
ahead/behind counts both need `git status` or a commit-graph walk, and `git status`
refreshes the index under `.git/index.lock`. The status line re-renders constantly, so
that lock loses races against the git commands you type yourself, and an
`Unable to create '.git/index.lock': File exists` on your own `git add` is a worse outcome
than a missing asterisk. Branch name only, for free.

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
▌ ~/dir │ main │ Opus 5 │ ctx 5% │ 5h 29% (2h13m)      unicode
| ~/dir | main | Opus 5 | ctx 5% | 5h 29% (2h13m)      ascii
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

55 checks covering percentage rounding, the reset countdown, path shortening, malformed
input, every colour and glyph switch, and the git segment against real temporary
repositories — nested subdirectories, worktrees where `.git` is a file, detached HEAD, a
repo with no commits yet, and a render with git nowhere on `PATH`, plus the settings merge
both installers share.

Fixtures carry no absolute timestamps. Countdown cases build `resets_at` relative to the
current time so they do not rot.

CI runs the same command on Linux, macOS and Windows across Node 18, 22 and 24, and runs
both installers against a throwaway `CLAUDE_CONFIG_DIR` — `install.ps1` under both
PowerShell 7 and Windows PowerShell 5.1. The suite drives real git and real path
separators, so a platform-specific break is a realistic failure mode rather than a
theoretical one; `fail-fast` is off so one platform going red does not hide the rest.

`statusline.js` reads Claude Code's session JSON on stdin. To see the real payload:

```sh
echo '{}' | node statusline.js          # minimal
```

To capture what your own session sends, add a one-line dump at the top of the stdin `end`
handler, look at the file, then take it back out.

## Design notes

`docs/design.md` records the decisions, including why the git subprocess was removed and
what that cost.
