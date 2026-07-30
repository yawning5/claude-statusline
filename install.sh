#!/usr/bin/env bash
# Point Claude Code's status line at this repo's statusline.js.
#
# Merges the statusLine key into ~/.claude/settings.json rather than
# overwriting the file, and takes a timestamped backup first.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$REPO_DIR/statusline.js"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CONFIG_DIR/settings.json"

command -v node >/dev/null 2>&1 || { echo "node not found in PATH" >&2; exit 1; }
[ -f "$SCRIPT" ] || { echo "missing $SCRIPT" >&2; exit 1; }

mkdir -p "$CONFIG_DIR"
[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"

BACKUP="$SETTINGS.backup.$(date +%Y%m%d%H%M%S)"
cp "$SETTINGS" "$BACKUP"

node -e '
const fs = require("fs");
const [settingsPath, scriptPath] = process.argv.slice(1);

let settings = {};
const raw = fs.readFileSync(settingsPath, "utf8").trim();
if (raw) {
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    console.error(`${settingsPath} is not valid JSON: ${e.message}`);
    console.error("Fix it by hand, or restore the backup, then re-run.");
    process.exit(1);
  }
}
if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
  console.error(`${settingsPath} does not contain a JSON object`);
  process.exit(1);
}

// double quotes so the command also works when cmd.exe runs it
settings.statusLine = { type: "command", command: `node "${scriptPath}"`, padding: 0 };
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
' "$SETTINGS" "$SCRIPT"

echo "statusLine -> $SCRIPT"
echo "backup     -> $BACKUP"
echo
echo "Open a new Claude Code session, or run /statusline, to pick it up."
