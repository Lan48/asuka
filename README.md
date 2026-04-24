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
```

## Security Notes

Before publishing, check that secrets and local personal state are not staged:

```bash
git status --short
git check-ignore openclaw.json memory/main.sqlite logs/gateway.log
```

The `.gitignore` intentionally excludes local memories, logs, device auth,
cron state, delivery queues, runtime config backups, dependencies, and build
output.
