#!/bin/sh
# The extension in a real VS Code, headless: sh editors/vscode/test/run.sh <path to the code binary>
# (the Linux build, https://update.code.visualstudio.com/latest/linux-x64/stable, unpacked). It runs test/host.js
# in the extension host, with `stride lsp` from this repository. Exits 0 when every check passes. STRIDE_COMMAND, a
# stride executable, is used in place of this repository's; STRIDE_EXTENSION, an installed copy of the extension (from
# its .vsix), in place of this folder.
set -e
code="$1"
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
mkdir -p "$work/user/User" "$work/files"
# Its own VS Code settings: stride from this repository, and no workspace-trust prompt, which a test cannot answer.
if [ -n "$STRIDE_COMMAND" ]; then command="[\"$STRIDE_COMMAND\"]"; else command="[\"node\", \"$repo/bin/stride.mjs\"]"; fi
printf '{ "stride.command": %s, "security.workspace.trust.enabled": false }\n' "$command" > "$work/user/User/settings.json"
extension="${STRIDE_EXTENSION:-$here}"
STRIDE_TEST_DIR="$work/files" xvfb-run -a "$code" --no-sandbox --disable-gpu --disable-extensions --skip-welcome --skip-release-notes \
  --user-data-dir="$work/user" --extensions-dir="$work/extensions" \
  --extensionDevelopmentPath="$extension" --extensionTestsPath="$here/test/host.js" "$work/files" >"$work/log" 2>&1 || true
if [ -f "$work/files/passed" ]; then echo "the extension passed in VS Code"; rm -rf "$work"; exit 0; fi
echo "the extension failed in VS Code; its log:"; tail -40 "$work/log"; exit 1
