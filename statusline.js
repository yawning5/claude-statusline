#!/usr/bin/env node
// Claude Code status line.
// Reads the session JSON on stdin, prints one line:
//   ▌ ~/dir │ main │ Opus 5 │ ⚡H │ ctx 5% │ 5h 29% │ 7d 1%
//
// Spawns nothing. The branch name is read straight out of .git/HEAD, so a
// render can never contend with the git commands you are typing yourself.
//
// Terminal behaviour is tuned by the environment:
//   NO_COLOR / FORCE_COLOR=0 / TERM=dumb   drop colour
//   FORCE_COLOR=1|2|3                      keep colour regardless
//   CLAUDE_STATUSLINE_STYLE=ascii|unicode  force the glyph set
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const env = process.env;

// Colour is on unless something explicitly says otherwise. Deliberately NOT
// gated on process.stdout.isTTY: Claude Code captures the status line through a
// pipe, so isTTY is always false and that check would strip colour everywhere.
function colorEnabled() {
  if (env.FORCE_COLOR) return env.FORCE_COLOR !== '0';
  if ('NO_COLOR' in env) return false;
  if (env.TERM === 'dumb') return false;
  return true;
}

function unicodeEnabled() {
  const forced = (env.CLAUDE_STATUSLINE_STYLE || '').toLowerCase();
  if (forced === 'ascii') return false;
  if (forced === 'unicode') return true;
  if (/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) return true;
  // Terminals that render UTF-8 fine but often leave the locale unset.
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM);
}

const COLOR = colorEnabled();

// bolt: U+26A1 is emoji-presentation in most terminals, so it occupies two
// columns. That is fine here — nothing in this line is column-aligned — but it
// is exactly the kind of glyph the ascii fallback exists for.
const GLYPH = unicodeEnabled()
  ? { lead: '▌', sep: ' │ ', ellipsis: '…', bolt: '⚡' }
  : { lead: '|', sep: ' | ', ellipsis: '...', bolt: '*' };

// 16-colour ANSI only — the one palette every terminal agrees on.
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = {
  dim: sgr(2),
  dir: sgr('1;36'),
  green: sgr(92),
  yellow: sgr(93),
  red: sgr(91),
  magenta: sgr(95),
};

// green under 50%, yellow under 80%, red at or above
const byLoad = (pct, s) => (pct >= 80 ? C.red(s) : pct >= 50 ? C.yellow(s) : C.green(s));

// Percentages arrive as raw floats — the 5h window turns up as e.g.
// 28.999999999999996 — so round before rendering. Anything above zero but under
// 1% shows as "<1" rather than a misleading "0".
const asPct = (n) => (n > 0 && n < 1 ? '<1' : String(Math.round(n)));

// Time until a rate limit window rolls over, rendered compactly: 6d3h, 2h13m,
// 47m, <1m. Null once the timestamp is in the past — the window has already
// reset and the percentage beside it is about to be replaced anyway.
function untilReset(resetsAt) {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null;

  const secs = resetsAt - Math.floor(Date.now() / 1000);
  if (secs <= 0) return null;
  if (secs < 60) return '<1m';

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours}h${mins % 60}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`;
}

const truncate = (s, n) =>
  s.length > n ? s.slice(0, Math.max(1, n - GLYPH.ellipsis.length)) + GLYPH.ellipsis : s;

// Slashes one way, no trailing separator. Both sides of the home comparison go
// through this so the test and the slice below agree on where home ends.
const normalize = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');

function shortenPath(cwd) {
  const home = os.homedir();
  let p = normalize(cwd);

  if (home) {
    const h = normalize(home);
    // The separator check is the point: a bare startsWith() also matches a
    // sibling that merely begins with the home path — /home/ya against
    // /home/yawning, C:\Users\me against C:\Users\me-other — and renders it as
    // "~wning" / "~-other".
    const atBoundary = p.length === h.length || p[h.length] === '/';
    if (atBoundary && p.slice(0, h.length).toLowerCase() === h.toLowerCase()) {
      p = '~' + p.slice(h.length);
    }
  }

  const segs = p.split('/').filter(Boolean);
  // keep the root marker plus the last two
  if (segs.length > 4) {
    const root = p.startsWith('/') ? '/' : '';
    return `${root}${segs[0]}/${GLYPH.ellipsis}/${segs.slice(-2).join('/')}`;
  }
  return p;
}

const MAX_BRANCH = 24;

// Walk up from cwd looking for .git. Returns the git directory itself, which is
// not always the `.git` entry we found: worktrees and submodules leave a file
// there reading `gitdir: <path>` and keep HEAD at that path instead.
function findGitDir(start) {
  let dir;
  try {
    dir = path.resolve(start);
  } catch {
    return null;
  }

  for (;;) {
    const candidate = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(candidate); } catch {}

    if (st) {
      if (st.isDirectory()) return candidate;
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(candidate, 'utf8'));
        // the path may be relative, and it is relative to the file's directory
        if (m) return path.resolve(dir, m[1].trim());
      } catch {}
      return null;
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
  }
}

// Branch name only, read off the filesystem. Nothing here spawns a process.
//
// The obvious implementation shells out to `git status`, which also yields
// dirtiness and upstream divergence. It was rejected: `git status` refreshes the
// index and writes it back under .git/index.lock, and the status line re-renders
// constantly, so it loses races against the git commands the user is typing.
// `--no-optional-locks` avoids the lock but still forks git on every render.
// Dirtiness and ahead/behind cannot be had without one — dirtiness needs a
// working-tree diff, and the counts need a commit-graph walk through packfiles —
// so they are simply not shown.
function branchSegment(cwd) {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return null;

  let head;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }

  // "ref: refs/heads/main" on a branch, a bare 40-char sha when detached.
  // A branch with no commits yet still has the ref line, which is why a fresh
  // repository shows its branch name here.
  const ref = /^ref:\s*(.+)$/.exec(head);
  const name = ref
    ? ref[1].replace(/^refs\/heads\//, '')
    : /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 7) : null;
  if (!name) return null;

  return C.green(truncate(name, MAX_BRANCH));
}

// Reasoning effort, as set by /effort. Payload shape: {"effort":{"level":"high"}}.
//
// Rendered as a one-or-two-character badge rather than the level name. The
// names are long ("ultracode" alone is as wide as the whole rate-limit
// segment) and this is a value you glance at to confirm, not read. Colour
// carries the same ordering the tag does, so the badge is legible at a glance
// even before the letter registers: quiet for low, green through the ordinary
// range, then yellow and red as the setting gets expensive.
const EFFORT = {
  low: { tag: 'L', paint: (s) => C.dim(s) },
  medium: { tag: 'M', paint: (s) => C.green(s) },
  high: { tag: 'H', paint: (s) => C.green(s) },
  xhigh: { tag: 'X', paint: (s) => C.yellow(s) },
  max: { tag: 'MAX', paint: (s) => C.red(s) },
  // ultracode is xhigh plus dynamic workflow orchestration, session-scoped.
  ultracode: { tag: 'UC', paint: (s) => C.red(s) },
};

const MAX_EFFORT_TAG = 5;

function effortSegment(effort) {
  const value = effort && effort.level;
  if (typeof value !== 'string' || !value.trim()) return null;

  const level = value.trim().toLowerCase();
  const known = EFFORT[level];

  // An unrecognised level still renders. Claude Code has added levels before
  // (xhigh, then ultracode); silently dropping the segment on the next one
  // would look like the feature broke rather than like the table is stale.
  // Sliced rather than truncate()d — an ellipsis inside a badge this small
  // costs more characters than it saves.
  const tag = known ? known.tag : level.toUpperCase().slice(0, MAX_EFFORT_TAG);
  const paint = known ? known.paint : (s) => C.magenta(s);

  return paint(GLYPH.bolt + tag);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch {}

  const cwd = (d.workspace && d.workspace.current_dir) || d.cwd || process.cwd();
  const parts = [C.dir(shortenPath(cwd))];

  const branch = branchSegment(cwd);
  if (branch) parts.push(branch);

  if (d.model && d.model.display_name) parts.push(C.magenta(d.model.display_name));

  // Beside the model, because the two are read together: which model, and how
  // hard it is being asked to think.
  const effort = effortSegment(d.effort);
  if (effort) parts.push(effort);

  const ctx = d.context_window && d.context_window.used_percentage;
  if (typeof ctx === 'number') parts.push(byLoad(ctx, `ctx ${asPct(ctx)}%`));

  // On a subscription the API-equivalent cost is not billed, so show the rate
  // limit windows instead — those are the real constraint.
  const limits = d.rate_limits || {};
  const five = limits.five_hour && limits.five_hour.used_percentage;
  if (typeof five === 'number') {
    const left = untilReset(limits.five_hour.resets_at);
    parts.push(byLoad(five, `5h ${asPct(five)}%` + (left ? ` (${left})` : '')));
  }

  const week = limits.seven_day && limits.seven_day.used_percentage;
  if (typeof week === 'number') parts.push(byLoad(week, `7d ${asPct(week)}%`));

  process.stdout.write(C.dim(GLYPH.lead + ' ') + parts.join(C.dim(GLYPH.sep)));
});

// never let a status line error take down the render
process.on('uncaughtException', () => process.exit(0));
