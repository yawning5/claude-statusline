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

# Under Git Bash / MSYS the repo path is /c/..., but it ends up in a JSON config
# that cmd.exe may run, where that form means nothing. Convert it explicitly:
# MSYS does convert arguments to native programs on the way through, and the old
# version happened to rely on that, but then the path printed below was not the
# path actually written.
if command -v cygpath >/dev/null 2>&1; then
  SCRIPT="$(cygpath -m "$SCRIPT")"
fi

mkdir -p "$CONFIG_DIR"
[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"

# The backup belongs to merge-settings.js — it is the only code that knows whether
# anything actually changed, and a backup of an unchanged file is just litter.
# It prints the backup path, or `unchanged` when it wrote nothing.
BACKUP="$(node "$REPO_DIR/merge-settings.js" "$SETTINGS" "$SCRIPT")"

echo "statusLine -> $SCRIPT"
if [ "$BACKUP" = unchanged ]; then
  echo "backup     -> not needed (settings already point here)"
else
  echo "backup     -> $BACKUP"
fi
echo
echo "Open a new Claude Code session, or run /statusline, to pick it up."
