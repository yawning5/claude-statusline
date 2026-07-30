#!/usr/bin/env node
// Claude Code status line.
// Reads the session JSON on stdin, prints one line:
//   ▌ ~/dir │ main↑1↓2* │ Opus 5 │ ctx 5% │ 5h 29% │ 7d 1%
//
// Terminal behaviour is tuned by the environment:
//   NO_COLOR / FORCE_COLOR=0 / TERM=dumb   drop colour
//   FORCE_COLOR=1|2|3                      keep colour regardless
//   CLAUDE_STATUSLINE_STYLE=ascii|unicode  force the glyph set
'use strict';

const { execFileSync } = require('child_process');
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

const GLYPH = unicodeEnabled()
  ? { lead: '▌', sep: ' │ ', ellipsis: '…', ahead: '↑', behind: '↓' }
  : { lead: '|', sep: ' | ', ellipsis: '...', ahead: '^', behind: 'v' };

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

function shortenPath(cwd) {
  const home = os.homedir();
  let p = cwd.replace(/\\/g, '/');
  if (home && path.resolve(cwd).toLowerCase().startsWith(home.toLowerCase())) {
    p = '~' + cwd.slice(home.length).replace(/\\/g, '/');
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

// Parse the `## ` header of `git status --porcelain --branch`. Four shapes:
//   "main...origin/main [ahead 1, behind 2]"   tracking an upstream
//   "feature"                                  no upstream configured
//   "No commits yet on master"                 fresh repo
//   "HEAD (no branch)"                         detached
function parseBranchHeader(info) {
  const fresh = /^No commits yet on (.+)$/.exec(info);
  if (fresh) return { branch: fresh[1], ahead: 0, behind: 0 };
  if (info.startsWith('HEAD (no branch)')) return { branch: 'HEAD', ahead: 0, behind: 0 };

  const track = /\s\[(.+)\]$/.exec(info);
  const ahead = track && /ahead (\d+)/.exec(track[1]);
  const behind = track && /behind (\d+)/.exec(track[1]);
  return {
    // branch names cannot contain "..", so splitting on the upstream separator is safe
    branch: info.replace(/\s\[.+\]$/, '').split('...')[0],
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
  };
}

// One `git status --porcelain --branch` yields branch, upstream divergence and
// dirtiness together. The status line re-renders constantly, so a second git
// process per render is worth avoiding.
function gitSegment(cwd) {
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain', '--branch'], {
      cwd,
      timeout: 1000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    // not a repo, git missing, or a repo big enough to blow the timeout
    return null;
  }

  const lines = out.split('\n');
  if (!lines[0] || !lines[0].startsWith('## ')) return null;

  const { branch, ahead, behind } = parseBranchHeader(lines[0].slice(3).trim());
  if (!branch) return null;

  const dirty = lines.slice(1).some((l) => l.trim() !== '');

  let label = truncate(branch, MAX_BRANCH);
  if (ahead) label += GLYPH.ahead + ahead;
  if (behind) label += GLYPH.behind + behind;
  if (dirty) label += '*';

  return dirty ? C.yellow(label) : C.green(label);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch {}

  const cwd = (d.workspace && d.workspace.current_dir) || d.cwd || process.cwd();
  const parts = [C.dir(shortenPath(cwd))];

  const git = gitSegment(cwd);
  if (git) parts.push(git);

  if (d.model && d.model.display_name) parts.push(C.magenta(d.model.display_name));

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
