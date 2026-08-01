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
  "effort":    { "level": "high" },        // low|medium|high|xhigh|max|ultracode
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

## Effort label

`effort.level` is what `/effort` set. It is **not** in the status line JSON schema Claude
Code documents, so it was confirmed the only way that settles it: by dumping the actual
stdin of a live session, which carried `"effort": { "level": "high" }`. The level names
were read out of the Claude Code binary rather than guessed — `low`, `medium`, `high`,
`xhigh`, `max`, and `ultracode` (xhigh plus dynamic workflow orchestration, session-scoped).

### Borrowing Claude Code's palette

The level is printed by name, in the colour Claude Code paints it in its own `/effort`
menu. That menu's definition is in the binary, and it is the source of truth here:

```js
[{value:"low",       color:"warning"},
 {value:"medium",    color:"success"},
 {value:"high",      color:"permission"},
 {value:"xhigh",     color:"autoAccept-shimmer"},
 {value:"max",       color:"rainbow-animated"},
 {value:"ultracode", color:"violet-ripple"}]
```

Each token resolves through Claude Code's theme, which ships both a 24-bit and a 16-colour
version of itself — so the fallback below is also Claude Code's, not an invention:

| Level | Token | 24-bit | 16-colour |
|---|---|---|---|
| `low` | `warning` | `rgb(255,193,7)` | `yellowBright` |
| `medium` | `success` | `rgb(78,186,101)` | `greenBright` |
| `high` | `permission` | `rgb(87,105,247)` | `blueBright` |
| `xhigh` | `autoAccept-shimmer` | `rgb(208,180,255)` | `magentaBright` |
| `max` | `rainbow-animated` | ROYGBIV stops | ROYGBIV stops |
| `ultracode` | `violet-ripple` | `rgb(62,22,118)` → `rgb(140,80,240)` | — |

### Animations that cannot animate

`max` and `ultracode` are animated in Claude Code. A status line cannot be: it prints one
static string per render and does not control when the next render happens. Faking motion
was never on the table.

What is on the table is the **spatial** version of each — the colour spread across the
characters of the label instead of across time. `spread()` walks the label and paints each
character at its own position along 0..1, so `ultracode` carries the full ripple gradient
across its nine letters and `max` carries the spectrum across its three.

`max`'s stops are spread across the whole rainbow rather than taken in order. Taking them
in order would paint a three-character label red, orange, yellow — a fire, not a rainbow.

The ripple endpoints are Claude Code's own, interpolated the same way it does. Note that
`rainbow-animated` and `violet-ripple` have **no** entry in the 16-colour theme, because
they are special-cased renderers rather than palette entries. So the rainbow keeps working
without truecolor (its stops are ordinary palette colours) and the gradient does not —
`ultracode` drops to plain magenta rather than pretending to be a gradient.

### The one place 24-bit colour is used

`truecolorEnabled()` follows the shape of `unicodeEnabled()`: `COLORTERM=truecolor|24bit`
is the standard signal, `WT_SESSION` and `TERM_PROGRAM` are terminals known to support it
while frequently leaving `COLORTERM` unset, and `CLAUDE_STATUSLINE_TRUECOLOR` overrides
either way.

`Apple_Terminal` has to be named explicitly as an exclusion. It sets `TERM_PROGRAM` and
stops at 256 colours, so trusting `TERM_PROGRAM` blindly would send it escapes it cannot
render.

`test/run.js` pins `CLAUDE_STATUSLINE_TRUECOLOR=0` for every render that did not ask
otherwise. `WT_SESSION` and `TERM_PROGRAM` are present on some developers' machines and
absent on CI, and without pinning the same test would take different branches in the two
places.

An unrecognised level renders in magenta rather than dropping the segment. Two levels have
been added upstream already; a segment that silently disappeared on the third would look
like the feature broke, when the truth is that the table needs a line.

### Recovering ultracode

`ultracode` is the one level that never arrives. Establishing why took reading the binary,
and the answer is that it is not a level at all:

```js
CD=["low","medium","high","xhigh","max"];lUc={med:"medium"},cUc={ultracode:"xhigh"}
```

It lives in an **alias** table, not the level vocabulary. Setting it splits into two facts
written to two places — `{value:"xhigh",ultracode:!0}` — and the payload is built from only
the first, through a function that whitelists against `CD`. So `effort.level` reports
`xhigh`, which is not a bug: `xhigh` is genuinely the effort being applied.

Three other routes were checked and ruled out with evidence:

| Route | Verdict |
|---|---|
| `settings.json` | The `ultracode` key exists, but its own schema says *"interactive toggles never persist it"* — confirmed on disk: running `/effort ultracode` left the file byte-identical. |
| Environment | The only effort reader is `CLAUDE_CODE_EFFORT_LEVEL`, which parses a level, not a flag. |
| `~/.claude.json` unpin flags | Written by `/effort ultracode` — but also by plain `/effort xhigh`, and they are one-way latches. They cannot tell the two apart. |

What does work is the session transcript. Claude Code appends
`{"attachment":{"type":"ultra_effort_enter",…},"type":"attachment",…}` on entry and an
`ultra_effort_exit` on the way out, and it decides the live state by scanning its message
list backwards for whichever is newest:

```js
for(let i=e.length-1;i>=0;i--){let s=e[i];
  if(s.type==="attachment"){if(s.attachment.type==="ultra_effort_enter"){n="enter";break}
   if(s.attachment.type==="ultra_effort_exit"){n="exit";break}}
```

`ultracodeActive()` runs that same scan over the same records, reached through the
`transcript_path` the payload already provides. This is deliberately a copy of the product's
own state machine rather than a heuristic that happens to work.

Four things make it safe to rely on:

1. **Only `xhigh` triggers a read.** Ultracode pins effort to `xhigh`, so nothing else can
   be hiding it — and nothing else pays for a file read.
2. **The read is capped** at 256 KB from the end. The real marker in a heavy session sat
   88 KB from EOF, so the cap is generous, but it is a cap: a marker beyond it under-claims.
3. **The decision is a structural parse.** A substring match would be wrong, and provably
   so — a transcript containing a *conversation about* these records is a real case, and it
   was hit during development. Escaping saves a substring match by luck; `JSON.parse` plus a
   `type`/`isSidechain` check saves it on purpose.
4. **Markers older than this run are ignored.** A resumed session keeps its transcript but
   starts a new process, and ultracode does not survive a restart. The run's start comes
   from `~/.claude/sessions/<pid>.json`, matched on `session_id`.

Every failure path returns false, so the label falls back to the plain level. The one place
this can still assert something untrue is leaving ultracode: the exit marker is written on
the next prompt, so `ultracode` lingers for a moment. Measured on real data: 10.4 s entering,
6.0 s leaving.

The format is internal and undocumented, unlike `transcript_path` itself, which is in the
published status line schema. If it is renamed the scan finds nothing and the label quietly
becomes `xhigh` again — the failure is a silent downgrade, not a break.

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
