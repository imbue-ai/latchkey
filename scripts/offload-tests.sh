#!/usr/bin/env bash
#
# Run the project's test suite via Offload (parallel on Modal).
# Requires: Offload (cargo install offload@0.4.0), Modal CLI + credentials
#
set -euo pipefail

if ! command -v offload &> /dev/null; then
    echo "Error: 'offload' not installed. Install with: cargo install offload@0.4.0"
    exit 1
fi

cd "$(git rev-parse --show-toplevel)"
exec offload run --copy-dir ".:/app" "$@"
