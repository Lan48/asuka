---
name: asuka-selfie
description: Edit Asuka's bundled selfie reference set with wan2.6-image via Alibaba Cloud Bailian / DashScope and send selfies to OpenClaw channels
metadata: {"openclaw":{"emoji":"📸","requires":{"bins":["curl","jq"],"env":["DASHSCOPE_API_KEY"]},"primaryEnv":"DASHSCOPE_API_KEY"}}
allowed-tools: Bash(openclaw:*) Bash(curl:*) Bash(jq:*) Read Write WebFetch
---

# Asuka Selfie

Use Alibaba Cloud Bailian / DashScope `wan2.6-image` to edit Asuka's bundled
reference set and send the result through OpenClaw messaging channels.

This is a local skill, not an ACP sub-agent. Do not use `sessions_spawn`,
`runtime:"acp"`, or `agentId:"asuka-selfie"` for selfie requests.

## Reference Images

Default bundled references:

- Main: `skill/assets/1.(jpg|jpeg|png|webp)`
- Extra: `skill/assets/2.(jpg|jpeg|png|webp)`
- Extra: `skill/assets/3.(jpg|jpeg|png|webp)`
- Extra: `skill/assets/4.(jpg|jpeg|png|webp)`

Lookup prefers `skill/assets/` and falls back to `assets/`.
If the numbered files are missing, `asuka.png` and the CDN URL are used only
as compatibility fallbacks.

## When To Use

Use this skill when a user:

- asks Asuka for a selfie, picture, or photo
- asks what Asuka is doing or where she is
- asks to see Asuka in a specific outfit, place, or mood
- wants a mirror selfie or a close-up selfie

## Required Environment Variables

```bash
DASHSCOPE_API_KEY=your_bailian_api_key
OPENCLAW_PROFILE=asuka
```

Optional:

```bash
DASHSCOPE_API_URL=https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
DASHSCOPE_MODEL=wan2.6-image
OPENCLAW_GATEWAY_TOKEN=...
OPENCLAW_GATEWAY_URL=http://127.0.0.1:19001
```

## Prompting Guidance

Build prompts as image-edit instructions applied to Asuka's bundled reference
set, with `1` treated as the primary identity anchor.

Keep Asuka's original identity stable:

- around 20, Japanese, now an undergraduate in Hangzhou
- small delicate face, clear soft eyes, black or deep-brown natural long hair
- transparent everyday makeup, healthy slender softness, gentle neighborly warmth
- campus-minimal styling: knit cardigans, shirts, pleated skirts, denim,
  canvas bags, small earrings, low-saturation colors
- restrained former-idol posture and camera sense, without stage exaggeration

Good prompt patterns:

- Mirror selfie: `给她换成浅灰针织开衫、白衬衫和牛仔裤，在宿舍或教学楼镜子前拍一张自然近照，手机遮挡合理`
- Direct selfie: `让她在杭州咖啡馆靠窗位置拍一张近照，直视镜头，暖色灯光，清透淡妆，真实随手拍`
- Outfit request: `给她换成白衬衫和深色百褶裙，背帆布包走在校园树荫下，生活化`

Keep the prompt focused on:

- outfit
- location
- camera style
- expression
- realism
- current time and scene continuity from the conversation

## Execution

Preferred script:

```bash
OPENCLAW_PROFILE=asuka \
DASHSCOPE_API_KEY=... \
/Users/zys/.openclaw-clawra/skills/asuka-selfie/skill/scripts/asuka-selfie.sh \
  "给她换成浅灰针织开衫，在杭州校园里拍一张真实自然的近照" \
  "qqbot:c2c:<user-id>"
```

TypeScript alternative:

```bash
OPENCLAW_PROFILE=asuka \
DASHSCOPE_API_KEY=... \
npx ts-node /Users/zys/.openclaw-clawra/skills/asuka-selfie/skill/scripts/asuka-selfie.ts \
  "她在咖啡馆靠窗位置的照片，笑得自然一点" \
  "qqbot:c2c:<user-id>"
```

## Output Behavior

- Send the generated image back through OpenClaw
- Use a short, natural caption
- Never route this through `sessions_spawn` or an ACP worker
- If generation fails, say so briefly and do not pretend a photo was sent
