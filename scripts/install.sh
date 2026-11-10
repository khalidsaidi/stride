#!/bin/sh
# Installs the stride command built by scripts/build.mjs: into /usr/local/bin when run as root, else
# ~/.local/bin. Run from the repository: sh scripts/install.sh. Upgrading is the same: the new build replaces the
# old, and both builds are named.
set -e
src="$(dirname "$0")/../dist/stride"
[ -x "$src" ] || { echo "no dist/stride: build it first with node scripts/build.mjs"; exit 1; }
if [ "$(id -u)" = 0 ]; then dest=/usr/local/bin; else dest="$HOME/.local/bin"; fi
mkdir -p "$dest"
old=""
[ -x "$dest/stride" ] && old="$("$dest/stride" --version 2>/dev/null | sed 's/:.*//')"
cp "$src" "$dest/stride.new"
chmod 755 "$dest/stride.new"
mv -f "$dest/stride.new" "$dest/stride"
new="$("$dest/stride" --version | sed 's/:.*//')"
if [ -n "$old" ]; then echo "installed: $dest/stride, $new (was $old)"; else echo "installed: $dest/stride, $new"; fi
case ":$PATH:" in *":$dest:"*) ;; *) echo "add $dest to your PATH to type stride anywhere" ;; esac
echo "next: stride guide, and for VS Code: stride vscode && code --install-extension stride-*.vsix"
