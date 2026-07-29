#!/usr/bin/env node
// Test runner for statusline.js. Plain Node, no dependencies:
//   node test/run.js
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'statusline.js');
const FIXTURES = path.join(__dirname, 'fixtures');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, message: e.message });
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what || 'value'}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

// --- driving the script -----------------------------------------------------

// Default to a deterministic rendering: no colour, forced unicode glyphs.
function render(payload, extraEnv) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const env = Object.assign(
    {},
    process.env,
    { NO_COLOR: '1', CLAUDE_STATUSLINE_STYLE: 'unicode' },
    extraEnv || {}
  );
  // an explicit undefined in extraEnv means "unset this variable"
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

  return execFileSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// "▌ a │ b │ c" -> ["a", "b", "c"]
function segments(out) {
  const plain = stripAnsi(out);
  const unicode = plain.startsWith('▌ ');
  const body = plain.slice(2);
  return body.split(unicode ? ' │ ' : ' | ');
}

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

// --- git scenario helpers ---------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-test-'));

const GIT_ENV = Object.assign({}, process.env, {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function newRepo(name, branch) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  // symbolic-ref rather than `init -b`, which needs git >= 2.28
  git(dir, 'symbolic-ref', 'HEAD', `refs/heads/${branch || 'main'}`);
  return dir;
}

function commit(dir, file, body) {
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', file);
}

// A repo wired to a bare remote so ahead/behind can be produced.
function repoWithRemote(name) {
  const bare = path.join(TMP, `${name}-remote.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  const dir = newRepo(name, 'main');
  commit(dir, 'a.txt', 'A');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { dir, bare };
}

// The branch segment is the second one when the cwd is a repo.
const branchOf = (dir, payload) =>
  segments(render(Object.assign({ workspace: { current_dir: dir } }, payload || {})))[1];

// --- percentage rendering ---------------------------------------------------

check('float noise rounds to a whole percent', () => {
  const s = segments(render(fixture('typical')));
  eq(s[2], 'ctx 5%', 'context segment');
  eq(s[3], '5h 29%', 'five hour segment');
  eq(s[4], '7d 1%', 'seven day segment');
});

check('model name is shown', () => {
  eq(segments(render(fixture('typical')))[1], 'Opus 5 (1M context)', 'model segment');
});

check('non-zero below one percent shows <1 rather than 0', () => {
  const s = segments(render(fixture('sub-one-percent')));
  eq(s[2], 'ctx <1%', 'context segment');
  eq(s[3], '5h <1%', 'five hour segment');
  eq(s[4], '7d 0%', 'a true zero stays 0');
});

check('missing rate_limits drops those segments', () => {
  const s = segments(render(fixture('no-rate-limits')));
  eq(s.length, 3, 'segment count');
  eq(s[2], 'ctx 12%', 'context segment');
});

check('high values round without decimals', () => {
  const s = segments(render(fixture('loaded')));
  eq(s[2], 'ctx 63%', 'context segment');
  eq(s[3], '5h 100%', 'five hour segment');
  eq(s[4], '7d 80%', 'seven day segment');
});

// --- reset countdown --------------------------------------------------------

// resets_at is absolute, so tests build it relative to now. The extra 30s keeps
// every case clear of a rounding boundary.
function withReset(offsetSeconds, usedPercentage) {
  return {
    workspace: { current_dir: '/srv/project/api' },
    rate_limits: {
      five_hour: {
        used_percentage: usedPercentage === undefined ? 29 : usedPercentage,
        resets_at: Math.floor(Date.now() / 1000) + offsetSeconds,
      },
    },
  };
}

const fiveHourOf = (payload) => segments(render(payload))[1];

check('hours and minutes remaining', () => {
  eq(fiveHourOf(withReset(2 * 3600 + 13 * 60 + 30)), '5h 29% (2h13m)', 'five hour segment');
});

check('a whole number of hours drops the minutes', () => {
  eq(fiveHourOf(withReset(3 * 3600 + 30)), '5h 29% (3h)', 'five hour segment');
});

check('under an hour shows minutes only', () => {
  eq(fiveHourOf(withReset(47 * 60 + 30)), '5h 29% (47m)', 'five hour segment');
});

check('under a minute shows <1m', () => {
  eq(fiveHourOf(withReset(30)), '5h 29% (<1m)', 'five hour segment');
});

check('multi-day gaps show days and hours', () => {
  eq(fiveHourOf(withReset(6 * 86400 + 3 * 3600 + 30)), '5h 29% (6d3h)', 'five hour segment');
});

check('a past reset time is omitted', () => {
  eq(fiveHourOf(withReset(-60)), '5h 29%', 'five hour segment');
});

check('a missing resets_at is omitted', () => {
  const s = segments(render({
    workspace: { current_dir: '/srv/project/api' },
    rate_limits: { five_hour: { used_percentage: 29 } },
  }));
  eq(s[1], '5h 29%', 'five hour segment');
});

check('a non-numeric resets_at is ignored', () => {
  const s = segments(render({
    workspace: { current_dir: '/srv/project/api' },
    rate_limits: { five_hour: { used_percentage: 29, resets_at: 'soon' } },
  }));
  eq(s[1], '5h 29%', 'five hour segment');
});

check('the countdown takes the colour of the window it belongs to', () => {
  const out = render(withReset(2 * 3600 + 30, 95), { NO_COLOR: undefined });
  if (!/\x1b\[91m5h 95% \(2h\)\x1b\[0m/.test(out)) {
    throw new Error(`expected the whole segment in red, got ${JSON.stringify(stripAnsi(out))} / ${JSON.stringify(out)}`);
  }
});

// --- paths ------------------------------------------------------------------

check('short paths are shown whole', () => {
  eq(segments(render(fixture('typical')))[0], '/srv/project/api', 'path segment');
});

check('deep paths keep the root marker and last two segments', () => {
  eq(segments(render(fixture('deep-path')))[0], '/srv/…/d/e', 'path segment');
});

check('paths under home collapse to ~', () => {
  const out = render({ workspace: { current_dir: os.homedir() } });
  eq(segments(out)[0], '~', 'path segment');
});

// --- malformed input --------------------------------------------------------

check('empty stdin does not crash', () => {
  const out = render('');
  if (!out.startsWith('▌ ')) throw new Error(`expected a rendered line, got ${JSON.stringify(out)}`);
});

check('invalid JSON does not crash', () => {
  const out = render('{not json');
  if (!out.startsWith('▌ ')) throw new Error(`expected a rendered line, got ${JSON.stringify(out)}`);
});

check('unknown fields are ignored', () => {
  const s = segments(render({ workspace: { current_dir: '/srv/project/api' }, surprise: { a: 1 } }));
  eq(s[0], '/srv/project/api', 'path segment');
});

// --- terminal capability ----------------------------------------------------

check('colour is on by default even though stdout is a pipe', () => {
  // Regression guard: gating on process.stdout.isTTY would kill colour in every
  // terminal, because Claude Code always captures this output through a pipe.
  const out = render(fixture('typical'), { NO_COLOR: undefined });
  if (!/\x1b\[/.test(out)) throw new Error('expected ANSI escapes in default output');
});

check('NO_COLOR strips every escape', () => {
  const out = render(fixture('typical'), { NO_COLOR: '1' });
  if (/\x1b\[/.test(out)) throw new Error('expected no ANSI escapes');
});

check('TERM=dumb strips every escape', () => {
  const out = render(fixture('typical'), { NO_COLOR: undefined, TERM: 'dumb' });
  if (/\x1b\[/.test(out)) throw new Error('expected no ANSI escapes');
});

check('FORCE_COLOR=0 strips every escape', () => {
  const out = render(fixture('typical'), { NO_COLOR: undefined, FORCE_COLOR: '0' });
  if (/\x1b\[/.test(out)) throw new Error('expected no ANSI escapes');
});

check('FORCE_COLOR=1 beats NO_COLOR', () => {
  const out = render(fixture('typical'), { NO_COLOR: '1', FORCE_COLOR: '1' });
  if (!/\x1b\[/.test(out)) throw new Error('expected ANSI escapes');
});

check('only 16-colour ANSI codes are emitted', () => {
  const out = render(fixture('loaded'), { NO_COLOR: undefined });
  const codes = out.match(/\x1b\[[0-9;]*m/g) || [];
  for (const code of codes) {
    if (/\x1b\[[34]8;/.test(code)) throw new Error(`256/truecolor escape found: ${JSON.stringify(code)}`);
  }
  if (!codes.length) throw new Error('expected some escapes');
});

check('ascii style avoids non-ASCII bytes entirely', () => {
  const out = render(fixture('deep-path'), { CLAUDE_STATUSLINE_STYLE: 'ascii' });
  if (/[^\x00-\x7f]/.test(out)) throw new Error(`non-ASCII byte in ${JSON.stringify(out)}`);
  eq(segments(out)[0], '/srv/.../d/e', 'path segment uses an ASCII ellipsis');
});

check('non-UTF8 locale falls back to ascii', () => {
  const out = render(fixture('typical'), {
    CLAUDE_STATUSLINE_STYLE: undefined,
    LC_ALL: 'C',
    LC_CTYPE: 'C',
    LANG: 'C',
    WT_SESSION: undefined,
    TERM_PROGRAM: undefined,
  });
  if (/[^\x00-\x7f]/.test(out)) throw new Error(`non-ASCII byte in ${JSON.stringify(out)}`);
});

check('UTF-8 locale selects unicode glyphs', () => {
  const out = render(fixture('typical'), {
    CLAUDE_STATUSLINE_STYLE: undefined,
    LC_ALL: 'en_US.UTF-8',
    LANG: 'en_US.UTF-8',
  });
  if (!out.startsWith('▌ ')) throw new Error(`expected the unicode lead glyph, got ${JSON.stringify(out)}`);
});

// --- git segment ------------------------------------------------------------

check('a directory that is not a repo has no branch segment', () => {
  const dir = path.join(TMP, 'plain');
  fs.mkdirSync(dir, { recursive: true });
  const s = segments(render({ workspace: { current_dir: dir }, context_window: { used_percentage: 1 } }));
  eq(s.length, 2, 'segment count (path + ctx only)');
});

check('a missing directory has no branch segment', () => {
  const s = segments(render({ workspace: { current_dir: path.join(TMP, 'nope') } }));
  eq(s.length, 1, 'segment count');
});

check('a repo with no commits shows its branch name', () => {
  eq(branchOf(newRepo('fresh', 'main')), 'main', 'branch segment');
});

check('a clean repo shows a bare branch name', () => {
  const dir = newRepo('clean', 'main');
  commit(dir, 'a.txt', 'A');
  eq(branchOf(dir), 'main', 'branch segment');
});

check('modified files add an asterisk', () => {
  const dir = newRepo('dirty', 'main');
  commit(dir, 'a.txt', 'A');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
  eq(branchOf(dir), 'main*', 'branch segment');
});

check('untracked files add an asterisk', () => {
  const dir = newRepo('untracked', 'main');
  commit(dir, 'a.txt', 'A');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
  eq(branchOf(dir), 'main*', 'branch segment');
});

check('a branch with no upstream shows no counts', () => {
  const dir = newRepo('noupstream', 'main');
  commit(dir, 'a.txt', 'A');
  git(dir, 'checkout', '-q', '-b', 'feature');
  commit(dir, 'b.txt', 'B');
  eq(branchOf(dir), 'feature', 'branch segment');
});

check('unpushed commits show as ahead', () => {
  const { dir } = repoWithRemote('ahead');
  commit(dir, 'b.txt', 'B');
  commit(dir, 'c.txt', 'C');
  eq(branchOf(dir), 'main↑2', 'branch segment');
});

check('unpulled commits show as behind', () => {
  const { dir, bare } = repoWithRemote('behind');
  const other = path.join(TMP, 'behind-other');
  git(TMP, 'clone', '-q', bare, other);
  commit(other, 'b.txt', 'B');
  commit(other, 'c.txt', 'C');
  git(other, 'push', '-q');
  git(dir, 'fetch', '-q');
  eq(branchOf(dir), 'main↓2', 'branch segment');
});

check('a diverged branch shows both counts', () => {
  const { dir, bare } = repoWithRemote('diverged');
  const other = path.join(TMP, 'diverged-other');
  git(TMP, 'clone', '-q', bare, other);
  commit(other, 'b.txt', 'B');
  commit(other, 'c.txt', 'C');
  git(other, 'push', '-q');
  git(dir, 'fetch', '-q');
  commit(dir, 'mine.txt', 'M');
  eq(branchOf(dir), 'main↑1↓2', 'branch segment');
});

check('counts and the dirty marker combine', () => {
  const { dir } = repoWithRemote('combo');
  commit(dir, 'b.txt', 'B');
  fs.writeFileSync(path.join(dir, 'scratch.txt'), 'x');
  eq(branchOf(dir), 'main↑1*', 'branch segment');
});

check('ascii style swaps the arrows', () => {
  const { dir } = repoWithRemote('ascii-arrows');
  commit(dir, 'b.txt', 'B');
  const out = render({ workspace: { current_dir: dir } }, { CLAUDE_STATUSLINE_STYLE: 'ascii' });
  eq(segments(out)[1], 'main^1', 'branch segment');
});

check('detached HEAD is labelled', () => {
  const dir = newRepo('detached', 'main');
  commit(dir, 'a.txt', 'A');
  git(dir, 'checkout', '-q', '--detach', 'HEAD');
  eq(branchOf(dir), 'HEAD', 'branch segment');
});

check('long branch names are truncated', () => {
  const dir = newRepo('longbranch', 'main');
  commit(dir, 'a.txt', 'A');
  git(dir, 'checkout', '-q', '-b', 'feature/really-quite-a-long-branch-name-here');
  const branch = branchOf(dir);
  if (branch.length > 24) throw new Error(`branch segment too long: ${JSON.stringify(branch)}`);
  if (!branch.endsWith('…')) throw new Error(`expected an ellipsis, got ${JSON.stringify(branch)}`);
});

// --- report -----------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });

for (const f of failures) console.error(`FAIL  ${f.name}\n    ${f.message}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
