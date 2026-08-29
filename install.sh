#!/usr/bin/env bash
set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "Installing Local Router dependencies..."
npm install --prefer-offline 2>/dev/null || npm install

node scripts/setup-platform.mjs
