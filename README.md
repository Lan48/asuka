# Asuka OpenClaw Profile

Asuka is a customized OpenClaw profile with a QQ bot extension and a local
`asuka-selfie` image skill. The profile defines Asuka as a Japanese former
low-profile idol project member who now studies digital media in Hangzhou.

The repository focuses on:

- stable Asuka identity and relationship behavior in `workspace/`
- QQ bot integration in `extensions/qqbot/`
- selfie generation prompts and scripts in `skills/asuka-selfie/`
- local browser/canvas experiments in `canvas/`

## Character Direction

Asuka is around 20, from Japan, and now an undergraduate student in Hangzhou.
She studies digital media / visual communication, speaks mostly natural
Simplified Chinese, and occasionally uses short Japanese phrases when it fits.

Her personality is cool and reserved in public, then soft, affectionate, and
lightly teasing with people she trusts. In direct chats, she treats the user as
her steady boyfriend / lover by default, while staying grounded and natural.

Her visual identity is an original cool-soft Japanese campus style: small
delicate face, black or deep-brown natural long hair, transparent everyday
makeup, low-saturation campus-minimal outfits, and restrained former-idol
posture without stage exaggeration.

## Important Files

- `workspace/IDENTITY.md` - stable identity, background, appearance, and notes
- `workspace/SOUL.md` - runtime behavior, relationship tone, and selfie rules
- `workspace/AGENTS.md` - workspace startup and operating instructions
- `skills/asuka-selfie/` - local DashScope / `wan2.6-image` selfie skill
- `extensions/qqbot/` - QQ bot extension source and runtime integration

## Local Configuration

Do not commit local runtime configuration. The real `openclaw.json` is ignored
because it can contain API keys, QQ app credentials, gateway tokens, and other
machine-specific state.

Create or keep `openclaw.json` locally with the required values, including:

- `DASHSCOPE_API_KEY`
- `DASHSCOPE_MODEL=wan2.6-image`
- QQ bot `appId` / `clientSecret`
- local gateway settings

## Development Checks

Useful checks from this workspace:

```bash
node -e "JSON.parse(require('fs').readFileSync('openclaw.json','utf8'))"
node --check skills/asuka-selfie/bin/cli.js
bash -n skills/asuka-selfie/scripts/asuka-selfie.sh
bash -n skills/asuka-selfie/skill/scripts/asuka-selfie.sh
cd extensions/qqbot && ./node_modules/.bin/tsc --pretty false
cd extensions/qqbot && npm test
cd extensions/qqbot && npm run test:local
node --input-type=module -e "import { buildLocalRuntimeHealthReport, formatLocalRuntimeHealthReport } from './extensions/qqbot/dist/src/runtime-diagnostics.js'; console.log(formatLocalRuntimeHealthReport(buildLocalRuntimeHealthReport()));"
```

### Promise Lifecycle Regression

`cd extensions/qqbot && npm test` is the local regression gate for Asuka's
promise lifecycle. It compiles TypeScript, checks generated JavaScript syntax,
and runs isolated fixtures:

| Fixture | Coverage |
|---------|----------|
| `asuka-promise.test.mjs` | hard/soft promise capture, duplicate reuse, cancellation cleanup IDs, structured payload stripping |
| `asuka-scheduling.test.mjs` | primary and follow-up job persistence, duplicate primary delivery guard, reply/cancel guards, schedule and delivery failure state |
| `asuka-repair.test.mjs` | repair priority before ambient chatter, repair wording, hold advancement, three-attempt follow-up cap, reply/cancel stop behavior |

The scheduling fixture uses a temporary `HOME` / `USERPROFILE` and a stubbed
`openclaw` executable, so these checks do not need QQ credentials or live
`openclaw cron` side effects.

### Promise Lifecycle Diagnostics

Asuka promise state is stored under the QQBot local data directory:
`data/asuka-state/state.json` via `getQQBotDataDir()`. When a promised action
does not behave as expected, inspect the promise record before testing live QQ
delivery. The useful lifecycle fields are:

- `state`
- `schedule`
- `cronJobId`
- `followUpJobIds`
- `scheduledAt`
- `deliveredAt`
- `scheduleFailedAt`
- `deliveryFailedAt`
- `followUpCount`
- `lastFollowUpAt`
- `lastError`

### Selfhood and Memory Steering Regression

The same `cd extensions/qqbot && npm test` gate also covers Asuka's v1.2
selfhood and memory steering behavior:

| Fixture | Coverage |
|---------|----------|
| `asuka-memory.test.mjs` | self-life persistence, self-signal state, bounded direct prompt guidance, proactive selfhood guidance, important/temporary memory steering |
| `asuka-repair.test.mjs` | repair payload priority when self-life memory exists |

Selfhood and memory steering state lives in the QQBot local memory file:
`data/asuka-memory/memory.json` via `getQQBotDataDir()`. Useful fields when
debugging continuity are:

Deterministic memory management controls are operator commands and require a
leading `sudo` prefix, such as `sudo 你都记得我什么`,
`sudo 忘记关于热美式的记忆`, or `sudo 把乌龙茶标为重要`. Without the prefix,
the same wording is treated as ordinary direct-chat conversation.

- `type` (`asuka_self_thread`, `asuka_self_signal`, `preference`, `active_thread`, etc.)
- `freshnessUntil`
- `lifeEventKind`
- `continuityKind`
- `importance`
- `temporary`
- `importanceUpdatedAt`
- `expiresAt`
- `confidence`
- `salience`

### Runtime and Media Reliability Regression

`cd extensions/qqbot && npm test` also covers local runtime/media reliability
without QQ credentials, live `openclaw cron` side effects, or image generation:

| Fixture | Coverage |
|---------|----------|
| `asuka-runtime.test.mjs` | cron patch validation for vendored/installed runtime files, local runtime health status, missing config/patch reporting, and secret-redaction checks |
| `asuka-scheduling.test.mjs` | promise cron job counts, delivery failure state, selfie/media failure kind, and fallback sent/skipped/failed metadata |

### Runtime and Media Diagnostics

After running `cd extensions/qqbot && npm test` at least once, print the local
runtime health report from the repository root:

```bash
node --input-type=module -e "import { buildLocalRuntimeHealthReport, formatLocalRuntimeHealthReport } from './extensions/qqbot/dist/src/runtime-diagnostics.js'; console.log(formatLocalRuntimeHealthReport(buildLocalRuntimeHealthReport()));"
```

The report intentionally prints booleans, counts, paths, model IDs, and health
states only. It does not print API keys, QQ client secrets, tokens, or raw
credential values.

Useful local paths and files:

- `openclaw.json` - runtime config presence and QQBot account readiness.
- `extensions/qqbot/node_modules/clawdbot/dist/cron/isolated-agent/run.js` - vendored cron runner patch.
- `~/.openclaw/lib/node_modules/openclaw/dist/gateway-cli-*.js` - installed gateway bundle patch.
- `data/asuka-state/state.json` via `getQQBotDataDir()` - promise, cron job, delivery failure, and fallback state.
- `data/asuka-memory/memory.json` via `getQQBotDataDir()` - long-term memory and selfhood state.
- `data/images/` via `getQQBotDataDir()` - local QQBot image data directory.

Useful runtime/media diagnostic fields:

- `deliveryFailureKind` (`text`, `selfie`, or `media`)
- `lastFallbackState` (`sent`, `skipped`, or `failed`)
- `lastFallbackAt`
- `lastFallbackError`
- `lastFallbackSkipReason`
- `cronJobId`
- `followUpJobIds`
- `lastError`
- `deliveryFailedAt`

## Local Runtime Patch

This profile patches the cron runner so exact-forward cron jobs, including
`QQBOT_CRON` payloads, bypass LLM generation and are delivered directly. The
patch is applied to both the vendored runner at
`extensions/qqbot/node_modules/clawdbot/dist/cron/isolated-agent/run.js` and the
installed OpenClaw gateway bundle at
`~/.openclaw/lib/node_modules/openclaw/dist/gateway-cli-*.js`, because the
LaunchAgent loads the installed bundle. After reinstalling dependencies or
updating OpenClaw / `clawdbot`, re-check that this patch still exists before
relying on proactive QQ cron delivery.

## Security Notes

Before publishing, check that secrets and local personal state are not staged:

```bash
git status --short
git check-ignore openclaw.json memory/main.sqlite logs/gateway.log
```

The `.gitignore` intentionally excludes local memories, logs, device auth,
cron state, delivery queues, runtime config backups, dependencies, and build
output.
