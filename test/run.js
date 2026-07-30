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

// An empty regular file rather than os.devNull. On Windows os.devNull is
// `\\.\nul`, which git-for-windows will not open as a config file -- it dies
// with `unable to access '//./nul': Invalid argument`, so every git scenario
// below fails at `git init`. An empty file isolates these repos from the
// developer's own git config just as well, and does it on every platform.
const EMPTY_GITCONFIG = path.join(TMP, 'empty.gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');

const GIT_ENV = Object.assign({}, process.env, {
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
  GIT_CONFIG_SYSTEM: EMPTY_GITCONFIG,
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

// os.homedir() reads USERPROFILE on Windows and HOME everywhere else, so these
// set both to drive it from the test.
const withHome = (home, cwd) =>
  segments(render({ workspace: { current_dir: cwd } }, { HOME: home, USERPROFILE: home }))[0];

// Native-shaped absolute paths. A POSIX-looking path would make these cases
// vacuous on Windows: they have to be paths the platform really produces.
const SEP = process.platform === 'win32' ? '\\' : '/';
const abs = (...segs) => (process.platform === 'win32' ? 'C:\\' : '/') + segs.join(SEP);
const HOME = abs('home', 'me');

check('a directory under home collapses to ~', () => {
  eq(withHome(HOME, abs('home', 'me', 'proj')), '~/proj', 'path segment');
});

check('a sibling that merely starts with the home path is left alone', () => {
  const cwd = abs('home', 'me-other', 'proj');
  eq(withHome(HOME, cwd), cwd.replace(/\\/g, '/'), 'path segment');
});

check('a trailing separator on home does not eat a character', () => {
  eq(withHome(HOME + SEP, abs('home', 'me', 'proj')), '~/proj', 'path segment');
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

check('a subdirectory finds the branch of the repo above it', () => {
  const dir = newRepo('nested', 'main');
  commit(dir, 'a.txt', 'A');
  const deep = path.join(dir, 'src', 'inner');
  fs.mkdirSync(deep, { recursive: true });
  eq(branchOf(deep), 'main', 'branch segment');
});

// Dirtiness and upstream divergence were dropped along with the git subprocess.
// These pin that down: the states that used to decorate the branch name must now
// leave it bare, so nobody "restores" a marker the script can no longer compute.

check('a modified working tree still renders a bare branch name', () => {
  const dir = newRepo('dirty', 'main');
  commit(dir, 'a.txt', 'A');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
  eq(branchOf(dir), 'main', 'branch segment');
});

check('untracked files still render a bare branch name', () => {
  const dir = newRepo('untracked', 'main');
  commit(dir, 'a.txt', 'A');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
  eq(branchOf(dir), 'main', 'branch segment');
});

check('a branch with no upstream renders its own name', () => {
  const dir = newRepo('noupstream', 'main');
  commit(dir, 'a.txt', 'A');
  git(dir, 'checkout', '-q', '-b', 'feature');
  commit(dir, 'b.txt', 'B');
  eq(branchOf(dir), 'feature', 'branch segment');
});

check('unpushed commits add no counts', () => {
  const { dir } = repoWithRemote('ahead');
  commit(dir, 'b.txt', 'B');
  commit(dir, 'c.txt', 'C');
  eq(branchOf(dir), 'main', 'branch segment');
});

check('a diverged branch adds no counts', () => {
  const { dir, bare } = repoWithRemote('diverged');
  const other = path.join(TMP, 'diverged-other');
  git(TMP, 'clone', '-q', bare, other);
  commit(other, 'b.txt', 'B');
  git(other, 'push', '-q');
  git(dir, 'fetch', '-q');
  commit(dir, 'mine.txt', 'M');
  eq(branchOf(dir), 'main', 'branch segment');
});

check('detached HEAD shows the short commit id', () => {
  const dir = newRepo('detached', 'main');
  commit(dir, 'a.txt', 'A');
  git(dir, 'checkout', '-q', '--detach', 'HEAD');
  const branch = branchOf(dir);
  if (!/^[0-9a-f]{7}$/.test(branch)) {
    throw new Error(`expected a 7-character sha, got ${JSON.stringify(branch)}`);
  }
});

// --- .git that is a file rather than a directory ----------------------------

check('a worktree, where .git is a file, resolves to its own branch', () => {
  const dir = newRepo('wt-main', 'main');
  commit(dir, 'a.txt', 'A');
  const wt = path.join(TMP, 'wt-linked');
  git(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
  if (!fs.statSync(path.join(wt, '.git')).isFile()) throw new Error('expected .git to be a file');
  eq(branchOf(wt), 'side', 'branch segment');
});

check('a relative gitdir is resolved against the file that holds it', () => {
  const dir = path.join(TMP, 'relgit');
  fs.mkdirSync(path.join(dir, 'elsewhere'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ./elsewhere\n');
  fs.writeFileSync(path.join(dir, 'elsewhere', 'HEAD'), 'ref: refs/heads/relative\n');
  eq(branchOf(dir), 'relative', 'branch segment');
});

check('a .git file that is not a gitdir pointer has no branch segment', () => {
  const dir = path.join(TMP, 'junkgit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'not a pointer\n');
  eq(segments(render({ workspace: { current_dir: dir } })).length, 1, 'segment count');
});

check('an unparseable HEAD has no branch segment', () => {
  const dir = path.join(TMP, 'junkhead');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'neither a ref nor a sha\n');
  eq(segments(render({ workspace: { current_dir: dir } })).length, 1, 'segment count');
});

// --- the no-subprocess guarantee --------------------------------------------

check('the branch renders with git nowhere on PATH', () => {
  const dir = newRepo('nogit', 'main');
  commit(dir, 'a.txt', 'A');
  // render() spawns node by absolute path, so emptying PATH only hides git.
  // Any implementation that shells out fails here; reading .git/HEAD does not.
  const out = render({ workspace: { current_dir: dir } }, { PATH: '', PATHEXT: undefined });
  eq(segments(out)[1], 'main', 'branch segment');
});

check('long branch names are truncated', () => {
  const dir = newRepo('longbranch', 'main');
  commit(dir, 'a.txt', 'A');
  git(dir, 'checkout', '-q', '-b', 'feature/really-quite-a-long-branch-name-here');
  const branch = branchOf(dir);
  if (branch.length > 24) throw new Error(`branch segment too long: ${JSON.stringify(branch)}`);
  if (!branch.endsWith('…')) throw new Error(`expected an ellipsis, got ${JSON.stringify(branch)}`);
});

// --- installer merge --------------------------------------------------------

// Both installers delegate to merge-settings.js, so the promise "your other
// settings are left alone" is tested in one place.
const MERGE = path.join(ROOT, 'merge-settings.js');

// Nested as deeply as a real settings.json gets. PowerShell's ConvertTo-Json
// flattens anything past depth 2 into "@{hooks=System.Object[]}", which is why
// the merge is Node rather than a reimplementation per platform.
const EXISTING = {
  theme: 'dark',
  env: { GIT_AUTHOR_NAME: 'someone' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
  },
  statusLine: { type: 'command', command: 'node /old/path.js', padding: 0 },
};

function mergeInto(contents, name) {
  const file = path.join(TMP, `${name}.json`);
  if (contents !== null) fs.writeFileSync(file, contents);
  const res = execFileSync(process.execPath, [MERGE, file, '/repo/statusline.js'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { file, out: res, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

check('the merge writes the statusLine command', () => {
  const { json } = mergeInto('{}', 'merge-empty');
  eq(json.statusLine.command, 'node "/repo/statusline.js"', 'statusLine command');
  eq(json.statusLine.type, 'command', 'statusLine type');
  eq(json.statusLine.padding, 0, 'statusLine padding');
});

check('the merge keeps unrelated settings, nesting and all', () => {
  const { json } = mergeInto(JSON.stringify(EXISTING, null, 2), 'merge-existing');
  eq(json.theme, 'dark', 'theme');
  eq(json.env.GIT_AUTHOR_NAME, 'someone', 'env value');
  eq(json.hooks.PreToolUse[0].hooks[0].command, 'echo hi', 'deeply nested hook command');
  eq(json.hooks.PreToolUse[0].matcher, 'Bash', 'hook matcher');
});

check('the merge replaces an existing statusLine', () => {
  const { json } = mergeInto(JSON.stringify(EXISTING), 'merge-replace');
  eq(json.statusLine.command, 'node "/repo/statusline.js"', 'statusLine command');
});

check('the merge creates a settings file that is not there yet', () => {
  const { json } = mergeInto(null, 'merge-absent');
  eq(json.statusLine.command, 'node "/repo/statusline.js"', 'statusLine command');
});

check('the merge refuses invalid JSON and leaves the file untouched', () => {
  const file = path.join(TMP, 'merge-broken.json');
  const before = '{ "theme": "dark",,,';
  fs.writeFileSync(file, before);
  let status = 0;
  try {
    execFileSync(process.execPath, [MERGE, file, '/repo/statusline.js'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status;
  }
  eq(status, 1, 'exit status');
  eq(fs.readFileSync(file, 'utf8'), before, 'file contents');
});

check('the merge refuses a JSON file that is not an object', () => {
  const file = path.join(TMP, 'merge-array.json');
  fs.writeFileSync(file, '[1, 2, 3]');
  let status = 0;
  try {
    execFileSync(process.execPath, [MERGE, file, '/repo/statusline.js'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status;
  }
  eq(status, 1, 'exit status');
  eq(fs.readFileSync(file, 'utf8'), '[1, 2, 3]', 'file contents');
});

// --- report -----------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });

for (const f of failures) console.error(`FAIL  ${f.name}\n    ${f.message}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
