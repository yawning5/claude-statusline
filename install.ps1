#!/usr/bin/env pwsh
# Point Claude Code's status line at this repo's statusline.js. The Windows
# counterpart to install.sh, for a machine with no Git Bash on it.
#
# Merges the statusLine key into ~/.claude/settings.json rather than overwriting
# the file, and takes a timestamped backup first.
#
# The merge runs through merge-settings.js -- the same code install.sh uses.
# Rewriting it in PowerShell would mean ConvertTo-Json, whose default depth of 2
# turns a real settings file's nested hooks into the string
# "@{hooks=System.Object[]}". Node is already required to run the status line.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoDir = $PSScriptRoot
$statusline = Join-Path $repoDir 'statusline.js'
$merge = Join-Path $repoDir 'merge-settings.js'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node not found in PATH' }
foreach ($f in @($statusline, $merge)) {
    if (-not (Test-Path -LiteralPath $f)) { throw "missing $f" }
}

$configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$settings = Join-Path $configDir 'settings.json'

New-Item -ItemType Directory -Force -Path $configDir | Out-Null
if (-not (Test-Path -LiteralPath $settings)) {
    Set-Content -LiteralPath $settings -Value '{}' -Encoding utf8
}

# Forward slashes in an otherwise Windows-shaped path (C:/Users/...). Claude Code
# may run the command through cmd.exe, which cannot resolve the /c/Users/... form
# a POSIX shell would hand it, and backslashes would need escaping in JSON.
$scriptPath = (Resolve-Path -LiteralPath $statusline).Path.Replace('\', '/')

# The backup belongs to merge-settings.js -- it is the only code that knows whether
# anything actually changed, and a backup of an unchanged file is just litter.
# It prints the backup path, or `unchanged` when it wrote nothing.
$backup = (node $merge $settings $scriptPath | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0) {
    throw "merge-settings.js failed; settings.json is untouched"
}

Write-Host "statusLine -> $scriptPath"
if ($backup -eq 'unchanged') {
    Write-Host "backup     -> not needed (settings already point here)"
} else {
    Write-Host "backup     -> $backup"
}
Write-Host ''
Write-Host 'Open a new Claude Code session, or run /statusline, to pick it up.'
