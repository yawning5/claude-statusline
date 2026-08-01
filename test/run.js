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
    {
      NO_COLOR: '1',
      CLAUDE_STATUSLINE_STYLE: 'unicode',
      // Pinned, not detected: WT_SESSION and TERM_PROGRAM are truecolor signals
      // and are set on some developers' machines and not on CI. Tests that care
      // about 24-bit colour turn it on explicitly.
      CLAUDE_STATUSLINE_TRUECOLOR: '0',
    },
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

// --- effort badge -----------------------------------------------------------

// The effort segment sits between the model and ctx, so with no model in the
// payload it lands at index 1, right after the path.
const effortOf = (level, extraEnv) =>
  segments(render(
    { workspace: { current_dir: '/srv/project/api' }, effort: level === undefined ? undefined : { level } },
    extraEnv
  ))[1];

check('every level renders as its own name', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']) {
    eq(effortOf(level), level, level);
  }
});

check('the effort label sits directly after the model', () => {
  const s = segments(render(Object.assign({ effort: { level: 'high' } }, fixture('typical'))));
  eq(s[1], 'Opus 5 (1M context)', 'model segment');
  eq(s[2], 'high', 'effort segment');
  eq(s[3], 'ctx 5%', 'context segment still follows');
});

check('a missing effort drops the segment entirely', () => {
  const s = segments(render(fixture('typical')));
  eq(s[1], 'Opus 5 (1M context)', 'model segment');
  eq(s[2], 'ctx 5%', 'ctx follows the model with nothing between');
});

check('level casing and stray whitespace are tolerated', () => {
  eq(effortOf('  XHigh '), 'xhigh', 'effort segment');
});

check('an unknown level still renders rather than vanishing', () => {
  // Not a real level — a stand-in for whatever Claude Code adds next, which
  // must surface rather than silently disappear.
  eq(effortOf('not-a-real-level'), 'not-a-real-…', 'effort segment');
});

check('a non-string or empty level is ignored', () => {
  for (const level of [null, 3, '', '   ']) {
    const s = segments(render({ workspace: { current_dir: '/srv/project/api' }, effort: { level } }));
    eq(s.length, 1, `segment count for level ${JSON.stringify(level)}`);
  }
  eq(segments(render({ workspace: { current_dir: '/srv/project/api' }, effort: {} })).length, 1, 'empty effort object');
});

// Claude Code's own /effort palette, read out of its binary. These are the
// numbers the menu paints with, so a drift here is a real mismatch.
const paintEffort = (level, extraEnv) => render(
  { workspace: { current_dir: '/srv/project/api' }, effort: { level } },
  Object.assign({ NO_COLOR: undefined }, extraEnv || {})
);

check('truecolor levels use Claude Code\'s own rgb values', () => {
  const tc = { CLAUDE_STATUSLINE_TRUECOLOR: '1' };
  const cases = [
    ['low', '38;2;255;193;7'],
    ['medium', '38;2;78;186;101'],
    ['high', '38;2;87;105;247'],
    ['xhigh', '38;2;208;180;255'],
  ];
  for (const [level, code] of cases) {
    const want = `\x1b[${code}m${level}\x1b[0m`;
    if (!paintEffort(level, tc).includes(want)) {
      throw new Error(`${level} should be ${code}`);
    }
  }
});

check('16-colour levels fall back to Claude Code\'s own ansi values', () => {
  const cases = [['low', 93], ['medium', 92], ['high', 94], ['xhigh', 95]];
  for (const [level, code] of cases) {
    if (!paintEffort(level).includes(`\x1b[${code}m${level}\x1b[0m`)) {
      throw new Error(`${level} should be ansi ${code}`);
    }
  }
});

check('ultracode is a violet gradient across its characters', () => {
  const out = paintEffort('ultracode', { CLAUDE_STATUSLINE_TRUECOLOR: '1' });
  // The endpoints are Claude Code's: rgb(62,22,118) through rgb(140,80,240).
  if (!out.includes('\x1b[38;2;62;22;118mu\x1b[0m')) throw new Error('should start at rgb(62,22,118)');
  if (!out.includes('\x1b[38;2;140;80;240me\x1b[0m')) throw new Error('should end at rgb(140,80,240)');
  eq(stripAnsi(out).split(' │ ')[1], 'ultracode', 'label under the colour');
  // one colour per character, so nine characters means nine distinct codes
  eq(new Set(out.match(/\x1b\[38;2;[0-9;]+m/g)).size, 9, 'distinct colours');
});

check('ultracode collapses to magenta without truecolor', () => {
  // A gradient has nowhere to go in 16 colours, so it stops pretending.
  if (!paintEffort('ultracode').includes('\x1b[35multracode\x1b[0m')) {
    throw new Error('should be plain magenta');
  }
});

check('max spreads the rainbow across its characters', () => {
  const out = paintEffort('max', { CLAUDE_STATUSLINE_TRUECOLOR: '1' });
  // Stops are spread over the whole spectrum, not taken in sequence, so a
  // three-character label reads as a rainbow rather than as three reds.
  if (!out.includes('\x1b[38;2;235;95;87mm\x1b[0m')) throw new Error('m should be rainbow red');
  if (!out.includes('\x1b[38;2;145;200;130ma\x1b[0m')) throw new Error('a should be rainbow green');
  if (!out.includes('\x1b[38;2;200;130;180mx\x1b[0m')) throw new Error('x should be rainbow violet');
});

check('the rainbow survives in 16 colours', () => {
  const out = paintEffort('max');
  eq(out.includes('\x1b[31mm\x1b[0m'), true, 'm red');
  eq(out.includes('\x1b[32ma\x1b[0m'), true, 'a green');
  eq(out.includes('\x1b[35mx\x1b[0m'), true, 'x magenta');
});

check('an unknown level is magenta', () => {
  if (!paintEffort('not-a-real-level').includes('\x1b[95mnot-a-real-…\x1b[0m')) {
    throw new Error('unknown should be magenta');
  }
});

check('NO_COLOR strips the gradient too', () => {
  const out = render({ workspace: { current_dir: '/srv/project/api' }, effort: { level: 'ultracode' } });
  if (/\x1b\[/.test(out)) throw new Error(`expected no escapes, got ${JSON.stringify(out)}`);
  eq(segments(out)[1], 'ultracode', 'effort segment');
});

check('level labels are ASCII in every style', () => {
  for (const level of ['low', 'max', 'ultracode']) {
    const out = render(
      { workspace: { current_dir: '/srv/project/api' }, effort: { level } },
      { CLAUDE_STATUSLINE_STYLE: 'ascii' }
    );
    if (/[^\x00-\x7f]/.test(out)) throw new Error(`non-ASCII byte in ${JSON.stringify(out)}`);
  }
});

// --- truecolor detection ----------------------------------------------------

const isTrue = (extraEnv) => /\x1b\[38;2;/.test(render(
  { workspace: { current_dir: '/srv/project/api' }, effort: { level: 'high' } },
  Object.assign({ NO_COLOR: undefined, CLAUDE_STATUSLINE_TRUECOLOR: undefined,
                  COLORTERM: undefined, WT_SESSION: undefined, TERM_PROGRAM: undefined }, extraEnv || {})
));

check('COLORTERM=truecolor enables 24-bit colour', () => {
  eq(isTrue({ COLORTERM: 'truecolor' }), true, 'truecolor');
  eq(isTrue({ COLORTERM: '24bit' }), true, '24bit');
});

check('a bare terminal stays on 16 colours', () => {
  eq(isTrue({}), false, 'nothing set');
  eq(isTrue({ COLORTERM: '' }), false, 'empty COLORTERM');
});

check('Windows Terminal and known TERM_PROGRAMs are trusted', () => {
  eq(isTrue({ WT_SESSION: 'abc' }), true, 'WT_SESSION');
  eq(isTrue({ TERM_PROGRAM: 'iTerm.app' }), true, 'iTerm');
  eq(isTrue({ TERM_PROGRAM: 'vscode' }), true, 'vscode');
});

check('Apple_Terminal is excluded, because it tops out at 256 colours', () => {
  eq(isTrue({ TERM_PROGRAM: 'Apple_Terminal' }), false, 'Apple_Terminal');
});

check('CLAUDE_STATUSLINE_TRUECOLOR overrides the detection either way', () => {
  eq(isTrue({ CLAUDE_STATUSLINE_TRUECOLOR: '1' }), true, 'forced on');
  eq(isTrue({ CLAUDE_STATUSLINE_TRUECOLOR: '0', COLORTERM: 'truecolor' }), false, 'forced off');
});

check('NO_COLOR beats truecolor detection', () => {
  const out = render(
    { workspace: { current_dir: '/srv/project/api' }, effort: { level: 'high' } },
    { COLORTERM: 'truecolor', CLAUDE_STATUSLINE_TRUECOLOR: undefined }
  );
  if (/\x1b\[/.test(out)) throw new Error('expected no escapes');
});

// --- ultracode detection ----------------------------------------------------

// Ultracode never arrives in the payload — Claude Code reports the xhigh it
// actually applies — so it is recovered from the session transcript. These build
// one, in the shape Claude Code really writes.
const SESSION = '11111111-2222-3333-4444-555555555555';
const RUN_START = Date.parse('2026-08-01T01:00:00.000Z');

const marker = (type, extra) => JSON.stringify(Object.assign({
  parentUuid: 'a',
  isSidechain: false,
  attachment: type === 'enter' ? { type: 'ultra_effort_enter', reminderType: 'full' } : { type: 'ultra_effort_exit' },
  type: 'attachment',
  uuid: 'b',
  timestamp: '2026-08-01T02:00:00.000Z',
}, extra || {}));

const CHATTER = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'hello' } });

function effortWith(name, lines, opts) {
  const o = opts || {};
  const file = path.join(TMP, `transcript-${name}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  // A home holding Claude Code's session registry, which the resume guard reads.
  const home = path.join(TMP, `home-${name}`);
  if (o.registry !== false) {
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '4242.json'), JSON.stringify({
      pid: 4242, sessionId: SESSION, startedAt: o.startedAt === undefined ? RUN_START : o.startedAt,
    }));
  } else {
    fs.mkdirSync(home, { recursive: true });
  }

  return segments(render(
    {
      workspace: { current_dir: '/srv/project/api' },
      effort: { level: o.level || 'xhigh' },
      session_id: SESSION,
      transcript_path: 'path' in o ? o.path : file,
    },
    Object.assign({ HOME: home, USERPROFILE: home }, o.env || {})
  ))[1];
}

check('a newest enter marker renders ultracode instead of xhigh', () => {
  eq(effortWith('enter', [CHATTER, marker('enter'), CHATTER]), 'ultracode', 'effort segment');
});

check('a newest exit marker leaves the plain level', () => {
  eq(effortWith('exit', [marker('enter'), CHATTER, marker('exit')]), 'xhigh', 'effort segment');
});

check('re-entering after an exit wins again', () => {
  eq(effortWith('reenter', [marker('enter'), marker('exit'), CHATTER, marker('enter')]), 'ultracode', 'effort segment');
});

check('a transcript with no markers leaves the plain level', () => {
  eq(effortWith('none', [CHATTER, CHATTER]), 'xhigh', 'effort segment');
});

check('only xhigh is checked, because only xhigh can be hiding ultracode', () => {
  // Every other level must not even reach for the file.
  for (const level of ['low', 'medium', 'high', 'max']) {
    eq(effortWith(`skip-${level}`, [marker('enter')], { level }), level, level);
  }
});

check('a sidechain marker is not this session\'s state', () => {
  // Subagent traffic is interleaved into the same transcript.
  eq(effortWith('sidechain', [marker('enter', { isSidechain: true })]), 'xhigh', 'effort segment');
});

check('a transcript that merely quotes a marker does not trigger it', () => {
  // A conversation *about* these records stores them escaped inside a message,
  // which is why the decision is a structural parse and not a substring match.
  const quoted = JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: { role: 'assistant', content: 'it writes {"attachment":{"type":"ultra_effort_enter"},"type":"attachment"} to the log' },
  });
  eq(effortWith('quoted', [quoted]), 'xhigh', 'effort segment');
});

check('a marker older than this run is ignored', () => {
  // The resume case: same transcript, new process, ultracode did not survive.
  eq(effortWith('stale', [marker('enter', { timestamp: '2026-08-01T00:30:00.000Z' })]), 'xhigh', 'effort segment');
});

check('a marker newer than this run is honoured', () => {
  eq(effortWith('fresh', [marker('enter', { timestamp: '2026-08-01T01:30:00.000Z' })]), 'ultracode', 'effort segment');
});

check('no session registry still honours the marker', () => {
  eq(effortWith('noreg', [marker('enter')], { registry: false }), 'ultracode', 'effort segment');
});

check('a missing or unreadable transcript leaves the plain level', () => {
  eq(effortWith('nopath', [marker('enter')], { path: undefined }), 'xhigh', 'no transcript_path');
  eq(effortWith('gone', [marker('enter')], { path: path.join(TMP, 'not-here.jsonl') }), 'xhigh', 'missing file');
  eq(effortWith('empty-path', [marker('enter')], { path: '' }), 'xhigh', 'empty transcript_path');
});

check('junk lines around the marker do not stop it', () => {
  eq(effortWith('junk', ['{ broken', 'not json at all', marker('enter'), '{"a":']), 'ultracode', 'effort segment');
});

check('the marker is found past a 256KB tail boundary only when inside it', () => {
  // The read is capped, and the cap is a deliberate limit rather than a bug: a
  // marker beyond it must under-claim, not be hunted for.
  const filler = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'x'.repeat(2000) } });
  const near = new Array(20).fill(filler);
  eq(effortWith('within', [marker('enter'), ...near]), 'ultracode', 'inside the cap');
  const far = new Array(200).fill(filler); // ~400KB of filler after the marker
  eq(effortWith('beyond', [marker('enter'), ...far]), 'xhigh', 'beyond the cap');
});

check('the detected ultracode label gets the violet gradient', () => {
  const file = path.join(TMP, 'transcript-colour.jsonl');
  fs.writeFileSync(file, marker('enter') + '\n');
  const out = render(
    {
      workspace: { current_dir: '/srv/project/api' },
      effort: { level: 'xhigh' },
      session_id: SESSION,
      transcript_path: file,
    },
    { NO_COLOR: undefined, CLAUDE_STATUSLINE_TRUECOLOR: '1', HOME: TMP, USERPROFILE: TMP }
  );
  if (!out.includes('\x1b[38;2;62;22;118mu\x1b[0m')) throw new Error('should start at rgb(62,22,118)');
  if (!out.includes('\x1b[38;2;140;80;240me\x1b[0m')) throw new Error('should end at rgb(140,80,240)');
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

check('only 16-colour ANSI codes are emitted without truecolor', () => {
  // The effort label is the one segment that can reach for 24-bit colour, so it
  // is included here deliberately: with truecolor off nothing may escape 16.
  const out = render(
    Object.assign({ effort: { level: 'ultracode' } }, fixture('loaded')),
    { NO_COLOR: undefined }
  );
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
