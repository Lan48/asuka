#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[qqbot:test] typecheck"
npx tsc --noEmit

echo "[qqbot:test] compile"
npx tsc

echo "[qqbot:test] syntax check"
node --check dist/src/asuka-memory.js
node --check dist/src/gateway.js
node --check dist/src/outbound.js
node --check dist/src/utils/media-caption.js
node --check dist/src/utils/narration-segments.js
node --check dist/src/runtime-diagnostics.js

echo "[qqbot:test] behavior fixtures"
node tests/asuka-media-caption.test.mjs
node tests/asuka-narration.test.mjs
node tests/asuka-memory.test.mjs
node tests/asuka-promise.test.mjs
node tests/asuka-scheduling.test.mjs
node tests/asuka-repair.test.mjs
node tests/asuka-runtime.test.mjs
node tests/message-buffer.test.mjs
node tests/ref-index-store.test.mjs
