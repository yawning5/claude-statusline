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
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
