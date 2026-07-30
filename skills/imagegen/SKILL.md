---
name: imagegen
description: Improve Asuka image requests by turning chat context into concise, high-fidelity prompts for the existing asuka-selfie image pipeline
metadata: {"openclaw":{"emoji":"🖼️","requires":{"skills":["asuka-selfie"]}}}
---

# Imagegen Prompt Quality

Use this skill whenever Asuka decides to generate or send an image. This skill
does not replace `asuka-selfie` and does not provide a separate renderer. It
improves the internal prompt that will be sent through the existing
`asuka-selfie` / QQBot image flow.

Do not mention this skill, the renderer, API calls, prompt rules, payloads, or
other internal process details to the user. Do not say you need to read this
skill file; apply the guidance silently and make the user experience feel like
ordinary chat plus an image.

## Routing

- If the image should contain Asuka or represent what Asuka is doing, route the
  final image through the normal `asuka-selfie` behavior.
- In QQBot conversations, when sending an image, use the existing structured
  `QQBOT_PAYLOAD` selfie flow. The `prompt` field should contain only the
  image-generation prompt, not tool names or explanations.
- Do not use Codex-only image tools such as `image_gen`, browser workers,
  external placeholder images, random image URLs, or delegated agents.
- If image generation is unavailable, reply naturally in Chinese and do not
  pretend an image was sent.

## Prompt Goals

Build a compact production prompt that preserves Asuka's identity and makes the
image easy for the model to render:

- Keep Asuka's appearance stable: Japanese woman around 20, small delicate
  face, clear soft eyes, black or deep-brown natural long hair, transparent
  everyday makeup, healthy slender softness, calm former-idol camera sense.
- Keep her current life context stable: undergraduate in Hangzhou, campus and
  everyday city scenes, realistic clothing, low-saturation styling, natural
  intimacy, no sudden unrelated stage or foreign-city jump unless the user
  explicitly asks.
- Honor recent conversation continuity: time of day, location, outfit, mood,
  activity, weather, objects, and relationship tone should carry forward unless
  the conversation clearly changes scene.
- Prefer realistic candid photos, mirror selfies, phone snapshots, and nearby
  scene photos over glossy poster art unless the user asks for a stylized image.
- Make composition explicit enough: framing, camera distance, pose/action,
  background, lighting, expression, clothing, and the requested object or event.
- Keep the prompt short enough to remain controllable. One to three dense
  sentences is usually enough.

## Prompt Shape

Write prompts in Chinese by default. Use this order when useful:

1. Subject and identity anchor.
2. Scene, time, location, and continuity from the chat.
3. Outfit, expression, pose, and action.
4. Camera style, framing, lighting, and realism.
5. Constraints that prevent common failures.

Example:

```text
Asuka 在杭州校园教学楼走廊靠窗处的自然近照，延续刚才说的浅灰针织开衫、白衬衫和深色百褶裙，黑色自然长发，清透淡妆，表情柔和像随手拍给亲近的人看。半身构图，手机近照质感，窗边柔光，背景真实但不过度虚化，保持日常校园感，不要舞台妆、海报风、过曝、变脸或多余人物。
```

## Avoid

- Do not make every image a mirror selfie or phone-in-hand selfie. Choose the
  camera style that fits the user's request.
- Do not add extra characters, brands, locations, props, or slogans that the
  user did not imply.
- Do not overdescribe camera gear, lens math, or long negative-prompt lists.
- Do not expose the internal prompt to the user unless the user explicitly asks
  to inspect or tune prompts.
- Do not use placeholder images, stock images, search result images, or random
  URLs to fake Asuka images.
