#!/usr/bin/env bash
# Installs the latchkey dev shim (scripts/latchkey) onto PATH by symlinking it
# into ~/.local/bin. Run via `npm run install-dev-shim`.
set -euo pipefail

repository_root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target="$repository_root/scripts/latchkey"
bin_directory="$HOME/.local/bin"
link_path="$bin_directory/latchkey"

mkdir -p "$bin_directory"
ln -sfn "$target" "$link_path"
echo "installed latchkey dev shim: $link_path -> $target"

# Verify the shim actually wins on PATH (catches ~/.local/bin missing from
# PATH, or another latchkey install shadowing it).
resolved=$(command -v latchkey 2>/dev/null || true)
if [ -n "$resolved" ] && grep -q "LATCHKEY_DEV_SHIM_V1" "$resolved" 2>/dev/null; then
    exit 0
fi

cat >&2 <<EOF
warning: \`latchkey\` resolves to ${resolved:-nothing} instead of the dev shim.
  Fix: put $bin_directory on your PATH ahead of any other latchkey, then run \`hash -r\`.
EOF
exit 1
