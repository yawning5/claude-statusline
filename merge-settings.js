#!/usr/bin/env node
// Merge the statusLine key into a Claude Code settings.json, leaving everything
// else in the file alone.
//
//   node merge-settings.js <settings.json> <absolute path to statusline.js>
//
// Extracted so install.sh and install.ps1 share one implementation: an
// installer that quietly drops the rest of someone's settings is the worst
// failure this repo could have.
'use strict';

const fs = require('fs');

const [settingsPath, scriptPath] = process.argv.slice(2);
if (!settingsPath || !scriptPath) {
  console.error('usage: node merge-settings.js <settings.json> <statusline.js>');
  process.exit(2);
}

let settings = {};
const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8').trim() : '';
if (raw) {
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    console.error(`${settingsPath} is not valid JSON: ${e.message}`);
    console.error('Fix it by hand, or restore the backup, then re-run.');
    process.exit(1);
  }
}
if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
  console.error(`${settingsPath} does not contain a JSON object`);
  process.exit(1);
}

// double quotes so the command also works when cmd.exe runs it
settings.statusLine = { type: 'command', command: `node "${scriptPath}"`, padding: 0 };
const next = JSON.stringify(settings, null, 2) + '\n';

// Nothing to write means nothing to back up. Installing is not a one-off: a setup
// runner re-runs the installer on every update, and by then the statusLine key is
// already exactly this, so the old code's unconditional timestamped copy filled
// ~/.claude/ with identical snapshots nobody asked for. Say so and stop.
const current = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
if (current === next) {
  console.log('unchanged');
  process.exit(0);
}

// The backup lives here rather than in each installer for the same reason the
// merge does: two implementations of "protect the user's settings" is one too many.
const KEEP_BACKUPS = 3;
let backup = '';
if (current !== null) {
  // Milliseconds, not seconds. Two runs inside one second is what a script does, and
  // at second resolution they collide — whichever way a collision is resolved, the
  // name stops tracking the clock: suffixing (…-1, …-2) reuses names that pruning has
  // just freed, so the sort below starts keeping the *oldest* three instead of the
  // newest. A stamp that only ever increases removes the whole question. Fixed width
  // and big-endian, so sorting by name is still sorting by time — including against
  // the 14-digit names an older version left behind.
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17);
  backup = `${settingsPath}.backup.${stamp}`;
  fs.writeFileSync(backup, current);

  // Keep the newest few. The names sort lexicographically because the stamp is
  // fixed-width and big-endian, so sorting by name is sorting by time.
  const dir = require('path').dirname(settingsPath);
  const prefix = `${require('path').basename(settingsPath)}.backup.`;
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) {
    try { fs.unlinkSync(require('path').join(dir, f)); } catch {}
  }
}

fs.writeFileSync(settingsPath, next);
console.log(backup);
