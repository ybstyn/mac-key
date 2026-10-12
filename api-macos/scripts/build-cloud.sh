#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
test "$(uname -s)" = Darwin
test "$(uname -m)" = arm64
command -v cargo >/dev/null
command -v go >/dev/null
command -v corepack >/dev/null
corepack enable
cd cherry-studio
pnpm install --frozen-lockfile
pnpm exec electron-rebuild --force --only better-sqlite3 --arch arm64
pnpm exec tsc --noEmit --composite false --incremental false -p tsconfig.node.json
pnpm exec tsc --noEmit --composite false --incremental false -p tsconfig.web.json
pnpm exec electron-vite build --config electron.managed.vite.config.ts
cd ../native-source
mkdir -p dist
printf '<!doctype html><html><body></body></html>\n' > dist/index.html
npm ci --ignore-scripts
npx --no-install tauri build --target aarch64-apple-darwin --bundles app --config ../api-macos/scripts/native-macos-config.json
cd ../api-macos
node --test test/*.test.cjs
node scripts/package-macos.cjs
node scripts/smoke-macos.cjs
node scripts/smoke-chat-macos.cjs
