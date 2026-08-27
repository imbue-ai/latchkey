#!/usr/bin/env bash
# Removes the latchkey dev shim symlink installed by installDevShim.sh.
# Run via `npm run uninstall-dev-shim`.
set -euo pipefail

bin_directory="$HOME/.local/bin"
link_path="$bin_directory/latchkey"

if [ ! -e "$link_path" ] && [ ! -L "$link_path" ]; then
    echo "no latchkey dev shim at $link_path; nothing to do"
    exit 0
fi

# A dangling symlink (the checkout it pointed at is gone) is still ours to
# clean up; anything else has to identify itself as the dev shim.
if [ -L "$link_path" ] && [ ! -e "$link_path" ]; then
    :
elif ! grep -q "LATCHKEY_DEV_SHIM_V1" "$link_path" 2>/dev/null; then
    echo "refusing to remove $link_path: it is not a latchkey dev shim" >&2
    exit 1
fi

rm -f "$link_path"
echo "removed latchkey dev shim: $link_path"

# Report what `latchkey` resolves to now, so it is obvious whether some other
# install takes over or the command is gone entirely.
resolved=$(command -v latchkey 2>/dev/null || true)
if [ -n "$resolved" ]; then
    echo "\`latchkey\` now resolves to $resolved"
else
    echo "\`latchkey\` is no longer on your PATH"
fi
echo "Run \`hash -r\` if your shell still has the old path cached."
