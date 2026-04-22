#!/usr/bin/env bash
#
# Build standalone latchkey binaries via `bun build --compile` for several
# Linux and macOS targets and upload them as assets to a GitHub release.
#
# GitHub API calls go through `latchkey curl` itself, so the invoker must
# have GitHub credentials configured (e.g. via `latchkey auth set github` or
# `latchkey auth browser github`).
#
# Usage:
#   scripts/releaseBinaries.sh [TAG]
#
# If TAG is omitted, the version field from package.json is used. The release
# for the tag must already exist on GitHub; this script will not create one.

set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

log() { printf '>>> %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v npm >/dev/null 2>&1 || fail "npm not found on PATH"
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH"
command -v latchkey >/dev/null 2>&1 || fail "latchkey not found on PATH"

github_repository="imbue-ai/latchkey"

version_from_package_json() {
    node -e "process.stdout.write(require('./package.json').version)"
}

tag="${1:-$(version_from_package_json)}"
[[ -n "$tag" ]] || fail "could not determine release tag"

log "repository: $github_repository"
log "release tag: $tag"

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
    npm run --silent bun-compile -- \
        --target "$bun_target" \
        --outfile "$output_file"
    built_files+=("$output_file")
done

log "built ${#built_files[@]} binaries in $output_directory"

# --- GitHub release upload --------------------------------------------------

# `latchkey curl` returns the HTTP body on stdout. We need HTTP status codes
# for proper error detection, so we use curl's `-w` and `-o` to split the
# response: the body goes to a temp file, the status code to stdout.

github_api() {
    # Usage: github_api METHOD PATH [curl args...]
    local method="$1" path="$2"
    shift 2
    local body_file status
    body_file="$(mktemp)"
    status="$(
        latchkey curl -sS \
            -o "$body_file" \
            -w '%{http_code}' \
            -X "$method" \
            -H 'Accept: application/vnd.github+json' \
            -H 'X-GitHub-Api-Version: 2022-11-28' \
            "$@" \
            "https://api.github.com$path"
    )"
    cat "$body_file"
    rm -f "$body_file"
    printf '\n%s' "$status"
}

# Returns body on stdout (one or more lines), then a final line with the
# numeric status code. We split using tail -n 1 / head -n -1.
call_split_output() {
    local raw="$1"
    response_status="${raw##*$'\n'}"
    response_body="${raw%$'\n'*}"
}

log "looking up release for tag $tag"
raw="$(github_api GET "/repos/$github_repository/releases/tags/$tag")"
call_split_output "$raw"

if [[ "$response_status" == "404" ]]; then
    fail "no GitHub release found for tag '$tag'. Create it on GitHub first, then re-run."
elif [[ "$response_status" != "200" ]]; then
    printf '%s\n' "$response_body" >&2
    fail "failed to look up release (HTTP $response_status)"
fi

release_id="$(
    printf '%s' "$response_body" \
        | node -e "let s=''; process.stdin.on('data',c=>s+=c).on('end',()=>{process.stdout.write(String(JSON.parse(s).id))})"
)"
[[ -n "$release_id" && "$release_id" != "undefined" ]] || fail "could not parse release id"
log "release id: $release_id"

# Fetch current assets so we can delete any that collide by name.
raw="$(github_api GET "/repos/$github_repository/releases/$release_id/assets?per_page=100")"
call_split_output "$raw"
[[ "$response_status" == "200" ]] || { printf '%s\n' "$response_body" >&2; fail "failed to list assets (HTTP $response_status)"; }
existing_assets_json="$response_body"

delete_existing_asset() {
    local asset_name="$1" asset_id
    asset_id="$(
        printf '%s' "$existing_assets_json" | node -e "
            let s=''; process.stdin.on('data',c=>s+=c).on('end',()=>{
                const assets = JSON.parse(s);
                const match = assets.find(a => a.name === process.argv[1]);
                process.stdout.write(match ? String(match.id) : '');
            })
        " "$asset_name"
    )"
    if [[ -n "$asset_id" ]]; then
        log "deleting existing asset $asset_name (id=$asset_id)"
        raw="$(github_api DELETE "/repos/$github_repository/releases/assets/$asset_id")"
        call_split_output "$raw"
        [[ "$response_status" == "204" ]] || { printf '%s\n' "$response_body" >&2; fail "failed to delete asset (HTTP $response_status)"; }
    fi
}

upload_asset() {
    local file_path="$1"
    local asset_name
    asset_name="$(basename "$file_path")"
    delete_existing_asset "$asset_name"
    log "uploading $asset_name"
    local body_file status
    body_file="$(mktemp)"
    status="$(
        latchkey curl -sS \
            -o "$body_file" \
            -w '%{http_code}' \
            -X POST \
            -H 'Accept: application/vnd.github+json' \
            -H 'X-GitHub-Api-Version: 2022-11-28' \
            -H 'Content-Type: application/octet-stream' \
            --data-binary "@$file_path" \
            "https://uploads.github.com/repos/$github_repository/releases/$release_id/assets?name=$asset_name"
    )"
    if [[ "$status" != "201" ]]; then
        cat "$body_file" >&2
        rm -f "$body_file"
        fail "failed to upload $asset_name (HTTP $status)"
    fi
    rm -f "$body_file"
}

for file_path in "${built_files[@]}"; do
    upload_asset "$file_path"
done

log "uploaded ${#built_files[@]} binaries to release $tag"
