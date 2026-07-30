# Design notes

## Why this exists

Claude Code's built-in status line reports API-equivalent cost. On a subscription that
number is not billed and is not what runs out, so it is replaced here with the two rate
limit windows Claude Code actually enforces, plus context window use.

## The bug that started it

The 5-hour window rendered as `5h 28.999999999999996%`.

`rate_limits.five_hour.used_percentage` arrives as an unrounded float. The original script
interpolated it straight into the output string. `ctx` and `7d` shared the same defect but
happened to receive integers, so they looked fine.

Fixed by `asPct()`, which rounds. Values strictly between 0 and 1 render as `<1` instead of
rounding down to `0`, so a window with real usage never reads as empty.

## Input

Claude Code pipes a session JSON object to the command on stdin. The fields used here:

```jsonc
{
  "workspace": { "current_dir": "…" },     // falls back to cwd
  "model":     { "display_name": "…" },
  "context_window": { "used_percentage": 5 },
  "rate_limits": {
    "five_hour": { "used_percentage": 28.999999999999996, "resets_at": 1785308400 },
    "seven_day": { "used_percentage": 1,  "resets_at": 1785902400 }
  }
}
```

Everything is treated as optional. Missing keys drop their segment; malformed JSON renders
the line with whatever is left.

## Reset countdown

`resets_at` is an absolute unix timestamp in seconds — verified against a live session,
where the 5-hour window reported a reset 9 minutes out and rendered `5h 29% (9m)`.

`untilReset()` turns it into a duration: `6d3h`, `2h13m`, `47m`, `<1m`. A timestamp in the
past returns null and the countdown is dropped, since the window has already rolled over
and the percentage next to it is about to be replaced. A missing or non-numeric value is
ignored the same way.

Shown for the 5-hour window only. The 7-day window resets nearly a week out, where a
countdown is noise rather than information.

Fixtures deliberately carry no `resets_at`. A hardcoded timestamp would make the suite pass
today and fail next week, so countdown cases compute theirs relative to `Date.now()`.

## Terminal handling

**Colour is on by default and disabled only on an explicit signal** (`NO_COLOR`,
`FORCE_COLOR=0`, `TERM=dumb`).

The usual `process.stdout.isTTY` check is wrong here. Claude Code captures the status line
through a pipe, so `isTTY` is always false; gating on it removes colour in every terminal,
including ones that render it perfectly. `test/run.js` guards this.

Only the 16 basic ANSI colours are emitted. They work on every terminal and inherit the
user's theme, which 256-colour and truecolor escapes do not.

Glyphs default to Unicode when the locale reports UTF-8, or when `TERM_PROGRAM` /
`WT_SESSION` is present — those terminals handle UTF-8 but frequently leave the locale
unset. `CLAUDE_STATUSLINE_STYLE` overrides the detection in either direction.

## Branch segment

**The status line spawns no processes.** The branch name is read from `.git/HEAD`.

It did not start that way. The first version ran `git status --porcelain --branch`, which
hands back branch, upstream divergence and dirtiness in one call — `main↑1↓2*`. The problem
is what `git status` does on the way: it refreshes the index and writes it back, taking
`.git/index.lock` to do so. Once, that is free. On every render of a status line, in a
repository where somebody is working, it races their own `git add` and `git commit` and
they get `Unable to create '.git/index.lock': File exists` from a command they typed.

`--no-optional-locks` (git 2.15+) fixes the lock specifically — it tells git to skip the
index write — and was the state of the code for a while. It still forks git on every
render, which is the part that was ultimately rejected: a status line should be free.

What that costs is real and worth stating plainly. **Dirtiness and ahead/behind are gone.**
Neither can be computed from files alone at any sensible cost — dirtiness needs a
working-tree-against-index diff, and the counts need a commit-graph walk that would mean
decompressing loose objects and parsing packfiles. Both were implemented, tested, and
removed on purpose. `test/run.js` asserts the states that used to decorate the branch name
now leave it bare, so nobody restores a marker the script can no longer honestly compute.

### Finding HEAD

`findGitDir()` walks up from the working directory looking for `.git`, and handles the case
where it is a **file** rather than a directory. Worktrees and submodules leave a pointer
there:

```
gitdir: /home/you/project/.git/worktrees/side
```

The path may be relative, and it is relative to the directory holding the file, not to the
process's working directory — resolving it the other way is a real bug, and there is a test
for it.

### Reading HEAD

| `.git/HEAD` contains | Rendered |
|---|---|
| `ref: refs/heads/main` | `main` |
| `ref: refs/heads/feature/x` | `feature/x` |
| `e0d0594…` (detached) | `e0d0594` |
| anything else | segment dropped |

A branch with no commits yet still has the `ref:` line, which is why a freshly initialised
repository shows its branch name.

## Home paths

`shortenPath()` collapses the home directory to `~` only when the next character is a
separator or the path ends there. A bare `startsWith()` also matches a sibling that merely
begins with the home path — `/home/ya` against `/home/yawning`, `C:\Users\me` against
`C:\Users\me-other` — and renders it as `~wning` / `~-other`.

Both sides are normalised (slashes one way, trailing separator dropped) before comparing,
so the test and the slice that follows agree on where home ends. The earlier version
compared `path.resolve(cwd)` but sliced the raw `cwd`, so a trailing separator on `$HOME`
also cost the first character of the remainder.

Tests for this build native-shaped paths (`C:\home\me` on Windows, `/home/me` elsewhere).
A POSIX-looking literal is not enough: `path.resolve()` rewrites it to `C:\…` on Windows,
which made an earlier draft of these cases pass there without exercising anything.

## Installers

There are two — `install.sh` and `install.ps1` — but one merge. Both call
`merge-settings.js`, which reads the existing `settings.json`, sets the `statusLine` key and
writes the rest back untouched.

Reimplementing the merge in PowerShell was rejected. `ConvertTo-Json` defaults to a depth of
2 and silently flattens everything below it, so a settings file with a `hooks` block comes
back out as `"@{hooks=System.Object[]}"`. `-Depth` fixes that, but the failure is quiet, the
blast radius is somebody's entire configuration, and Node is already a hard requirement for
the status line itself.

`install.sh` converts the repo path with `cygpath -m` when it is available. Under Git Bash
the path is `/c/...`, which is meaningless to the `cmd.exe` that may end up running the
command. MSYS does convert arguments on their way to a native program, so the written path
was already correct by accident — but the path *printed* by the installer was not the one
written, which is exactly the sort of thing that wastes an afternoon.

## Rejected

- **Running git at all** — every render forked a process against a repository someone else
  is using. Dirtiness and ahead/behind went with it; see above.
- **Parent-branch commit counts** — extra git calls per render, and the parent has to be
  guessed.
- **Git state from the session payload** — checked, not there. Claude Code sends
  `session_id`, `cwd`, `model`, `workspace`, `version`, `output_style`, `cost`,
  `context_window`, `exceeds_200k_tokens`, `fast_mode`, `thinking`, `effort` and
  `rate_limits`. Nothing about the repository, so there is no free branch, dirty flag or
  divergence count to pick up.
- **`process.stdout.isTTY` colour detection** — always false here; see above.
- **256-colour / truecolor** — breaks theme inheritance and older terminals.
- **Displaying cost** — not the binding constraint on a subscription.
