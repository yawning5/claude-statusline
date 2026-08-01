#!/usr/bin/env node
// Claude Code status line.
// Reads the session JSON on stdin, prints one line:
//   ▌ ~/dir │ main │ Opus 5 │ high │ ctx 5% │ 5h 29% │ 7d 1%
//
// Spawns nothing. The branch name is read straight out of .git/HEAD, so a
// render can never contend with the git commands you are typing yourself.
//
// Terminal behaviour is tuned by the environment:
//   NO_COLOR / FORCE_COLOR=0 / TERM=dumb   drop colour
//   FORCE_COLOR=1|2|3                      keep colour regardless
//   CLAUDE_STATUSLINE_STYLE=ascii|unicode  force the glyph set
//   CLAUDE_STATUSLINE_TRUECOLOR=0|1        force 24-bit colour off or on
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

// 24-bit colour, needed only by the effort labels — everything else is 16-colour
// and stays that way. COLORTERM is the standard signal but is frequently unset,
// so the known-good terminals are accepted directly, the same way glyphs are
// decided below. Apple_Terminal is the exception that has to be named: it sets
// TERM_PROGRAM and tops out at 256 colours.
function truecolorEnabled() {
  const forced = env.CLAUDE_STATUSLINE_TRUECOLOR;
  if (forced) return forced !== '0';
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM || '')) return true;
  if (env.WT_SESSION) return true;

  const prog = env.TERM_PROGRAM || '';
  return Boolean(prog) && prog !== 'Apple_Terminal';
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
const TRUECOLOR = COLOR && truecolorEnabled();

const GLYPH = unicodeEnabled()
  ? { lead: '▌', sep: ' │ ', ellipsis: '…' }
  : { lead: '|', sep: ' | ', ellipsis: '...' };

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
// The level name is printed in the colour Claude Code paints it in its own
// /effort menu, so the status line and the menu agree at a glance. Those colours
// were read out of the Claude Code binary rather than eyeballed — the menu
// defines low→warning, medium→success, high→permission, xhigh→autoAccept,
// max→rainbow-animated, ultracode→violet-ripple, and each of those tokens
// resolves to the values below.
//
// The last two are animations, and a status line cannot animate: it prints one
// static string per render and has no say in when the next render happens. So
// each is rendered as the spatial version of itself — the colour is spread
// across the characters of the label instead of across time. The ripple becomes
// a gradient, the rainbow becomes a spectrum. Standing still, but the same
// colours in the same order.
const EFFORT = {
  low: { rgb: [255, 193, 7], ansi: 93 },     // warning
  medium: { rgb: [78, 186, 101], ansi: 92 }, // success
  high: { rgb: [87, 105, 247], ansi: 94 },   // permission
  xhigh: { rgb: [208, 180, 255], ansi: 95 }, // autoAccept shimmer
};

// violet-ripple, interpolated over exactly the endpoints Claude Code uses.
const RIPPLE = { from: [62, 22, 118], to: [140, 80, 240], ansi: 35 };

// rainbow-animated, in ROYGBIV order, each with Claude Code's own ANSI fallback.
const RAINBOW = [
  { rgb: [235, 95, 87], ansi: 31 },
  { rgb: [245, 139, 87], ansi: 91 },
  { rgb: [250, 195, 95], ansi: 33 },
  { rgb: [145, 200, 130], ansi: 32 },
  { rgb: [130, 170, 220], ansi: 36 },
  { rgb: [155, 130, 200], ansi: 34 },
  { rgb: [200, 130, 180], ansi: 35 },
];

const MAX_EFFORT_LABEL = 12;
const MAX_TRANSCRIPT_TAIL = 256 * 1024;

// Reads the last `bytes` of a file. Returns null rather than throwing, and does
// not care that the first line is probably cut in half — the caller parses line
// by line and a broken line simply fails to parse.
function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.allocUnsafe(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// When this session's process started, from Claude Code's own session registry.
//
// This exists for one case: a resumed session keeps its transcript file but runs
// as a new process, and ultracode does not survive a restart. Without this the
// markers left by the previous run would be read as current state.
function sessionStartedAt(sessionId) {
  const home = os.homedir();
  if (!home || !sessionId) return null;

  const dir = path.join(home, '.claude', 'sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }

  for (const name of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (s.sessionId === sessionId && typeof s.startedAt === 'number') return s.startedAt;
    } catch {}
  }
  return null;
}

// Is ultracode on? Claude Code will not say so in the payload — effort.level
// reports the xhigh it genuinely applies — so the answer comes from the session
// transcript, whose path the payload does hand over.
//
// Entering ultracode appends a record shaped like:
//   {"attachment":{"type":"ultra_effort_enter","reminderType":"full"},"type":"attachment",…}
// and leaving appends an ultra_effort_exit. Claude Code decides the live state by
// scanning its message list backwards for whichever of the two is newest. This
// runs the same scan over the same records, so the two agree by construction
// rather than by coincidence.
//
// Every failure here returns false, which means the label falls back to the
// plain level — under-claiming rather than asserting something untrue.
function ultracodeActive(d) {
  if (typeof d.transcript_path !== 'string' || !d.transcript_path) return false;

  const tail = readTail(d.transcript_path, MAX_TRANSCRIPT_TAIL);
  if (tail === null) return false;

  const startedAt = sessionStartedAt(d.session_id);
  const lines = tail.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    // Cheap filter first; the parse below is what actually decides. A transcript
    // that merely quotes one of these records — a conversation about them, say —
    // stores it as an escaped string inside a message and cannot survive the
    // structural checks underneath.
    if (lines[i].indexOf('ultra_effort_') === -1) continue;

    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (!rec || rec.type !== 'attachment' || !rec.attachment) continue;
    // Subagent traffic is interleaved into this same file and is not session state.
    if (rec.isSidechain) continue;

    const kind = rec.attachment.type;
    if (kind !== 'ultra_effort_enter' && kind !== 'ultra_effort_exit') continue;

    // Older than this run means it belongs to a run whose flag died with it.
    if (startedAt !== null) {
      const at = Date.parse(rec.timestamp);
      if (Number.isFinite(at) && at < startedAt) return false;
    }

    return kind === 'ultra_effort_enter';
  }

  return false;
}

const fg = (rgb) => `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// Paints each character with the colour at its own position along 0..1. A
// single-character label sits at 0 rather than dividing by zero.
function spread(label, codeAt) {
  const n = label.length;
  return Array.from(label, (ch, i) => sgr(codeAt(n > 1 ? i / (n - 1) : 0))(ch)).join('');
}

const rippleAt = (t) => fg([
  lerp(RIPPLE.from[0], RIPPLE.to[0], t),
  lerp(RIPPLE.from[1], RIPPLE.to[1], t),
  lerp(RIPPLE.from[2], RIPPLE.to[2], t),
]);

// Stops are spread across the whole spectrum rather than taken in sequence, so
// a three-character "max" still reads as a rainbow instead of as three reds.
const rainbowAt = (t) => {
  const stop = RAINBOW[Math.round(t * (RAINBOW.length - 1))];
  return TRUECOLOR ? fg(stop.rgb) : String(stop.ansi);
};

function effortSegment(d) {
  const value = d.effort && d.effort.level;
  if (typeof value !== 'string' || !value.trim()) return null;

  let level = value.trim().toLowerCase();

  // Ultracode pins effort to xhigh, so xhigh is the only level that can be
  // hiding it. Testing that first keeps every other level free of file reads.
  if (level === 'xhigh' && ultracodeActive(d)) level = 'ultracode';

  // Without 24-bit colour a gradient has nowhere to go, so the ripple collapses
  // to plain magenta. The rainbow survives: its stops have ANSI equivalents.
  if (level === 'ultracode') {
    return TRUECOLOR ? spread(level, rippleAt) : sgr(RIPPLE.ansi)(level);
  }
  if (level === 'max') return spread(level, rainbowAt);

  const known = EFFORT[level];
  // An unrecognised level still renders. Claude Code has added levels before
  // (xhigh, then ultracode); silently dropping the segment on the next one
  // would look like the feature broke rather than like the table is stale.
  if (!known) return C.magenta(truncate(level, MAX_EFFORT_LABEL));

  return sgr(TRUECOLOR ? fg(known.rgb) : String(known.ansi))(level);
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
  const effort = effortSegment(d);
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
