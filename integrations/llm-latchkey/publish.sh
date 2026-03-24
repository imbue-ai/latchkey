#!/usr/bin/env bash
set -euo pipefail

echo "==> Cleaning dist/..."
rm -rf dist/*

echo "==> Building Python package..."
uv build

echo "==> Publishing to PyPI..."
uv publish dist/*

echo "==> Done!"
