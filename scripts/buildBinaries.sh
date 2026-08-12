#!/usr/bin/env bash
#
# Build standalone latchkey binaries via `bun build --compile` for several
# Linux and macOS targets. Binaries are written to `release-binaries/` and
# their paths are printed to stdout (one per line).
#
# Usage:
#   scripts/buildBinaries.sh [TAG]
#
# If TAG is omitted, the version field from package.json is used. This script
# only builds; it does not touch GitHub. See releaseBinaries.sh for the
# local flow that also uploads the results to a GitHub release.

set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

log() { printf '>>> %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v npm >/dev/null 2>&1 || fail "npm not found on PATH"
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH"

version_from_package_json() {
    node -e "process.stdout.write(require('./package.json').version)"
}

tag="${1:-$(version_from_package_json)}"
[[ -n "$tag" ]] || fail "could not determine release tag"

# Keep the compiled binaries in a dedicated directory so we don't clobber the
# `latchkey` file at the repository root (which is gitignored and used for
# local development). Deliberately NOT under `dist/` so these large binaries
# never get swept up by `npm publish` (see the `files` field in package.json).
output_directory="$repository_root/release-binaries"
mkdir -p "$output_directory"

# (bun --target, friendly suffix) pairs.
# `bun build --compile` understands these cross-compilation targets natively,
# see https://bun.sh/docs/bundler/executables#cross-compile-to-other-platforms
# Reuse the `bun-compile` npm script so that the list of externals (and its
# prebuild step that regenerates src/version.ts) stays defined in exactly one
# place. We append our own `--target` and `--outfile` after `--`; when these
# flags appear twice on the bun command line, the last occurrence wins.
targets=(
    "bun-linux-x64         linux-x64"
    "bun-linux-arm64       linux-arm64"
    "bun-darwin-x64        darwin-x64"
    "bun-darwin-arm64      darwin-arm64"
)

declare -a built_files=()

for entry in "${targets[@]}"; do
    read -r bun_target suffix <<<"$entry"
    output_file="$output_directory/latchkey-$tag-$suffix"
    log "compiling $bun_target -> $output_file"
    # Redirect build output to stderr so stdout carries only the file paths.
    npm run --silent bun-compile -- \
        --target "$bun_target" \
        --outfile "$output_file" >&2
    built_files+=("$output_file")
done

log "built ${#built_files[@]} binaries in $output_directory"

# Emit the built file paths on stdout for consumption by callers.
printf '%s\n' "${built_files[@]}"
