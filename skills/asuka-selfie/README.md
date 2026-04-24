# Asuka
<img width="300"  alt="image" src="https://github.com/user-attachments/assets/41512c51-e61d-4550-b461-eed06a1b0ec8" />


## Quick Start

```bash
npx asuka@latest
```

This will:
1. Check OpenClaw is installed
2. Guide you to configure an Alibaba Cloud Bailian / DashScope API key
3. Install the skill to `~/.openclaw/skills/asuka-selfie/`
4. Configure OpenClaw to use the skill
5. Add selfie capabilities to your agent's SOUL.md

## What It Does

Asuka Selfie enables your OpenClaw agent to:
- **Generate selfies** using a stable bundled reference set
- **Send photos** across all messaging platforms (Discord, Telegram, WhatsApp, etc.)
- **Respond visually** to "what are you doing?" and "send a pic" requests

### Selfie Modes

| Mode | Best For | Keywords |
|------|----------|----------|
| **Mirror** | Full-body shots, outfits | wearing, outfit, fashion |
| **Direct** | Close-ups, locations | cafe, beach, portrait, smile |

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and configured
- Alibaba Cloud Bailian / DashScope account and API key

## Manual Installation

If you prefer manual setup:

### 1. Get API Key

Create a Bailian / DashScope API key and export it as `DASHSCOPE_API_KEY`.

### 2. Clone the Skill

```bash
git clone https://github.com/SumeLabs/asuka ~/.openclaw/skills/asuka-selfie
```

### 3. Configure OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "asuka-selfie": {
        "enabled": true,
        "env": {
          "DASHSCOPE_API_KEY": "your_dashscope_key_here",
          "OPENCLAW_PROFILE": "asuka"
        }
      }
    }
  }
}
```

### 4. Update SOUL.md

Add the selfie persona to `~/.openclaw/workspace/SOUL.md`:

```markdown
## Asuka Selfie Capability

You have a physical appearance and can take selfies!
When users ask for pictures, use the asuka-selfie skill.
```

## Usage Examples

Once installed, your agent responds to:

```
"Send me a selfie"
"Send a pic wearing a cowboy hat"
"What are you doing right now?"
"Show me you at a coffee shop"
```

## Reference Images

The skill now uses a fixed bundled reference set by default:

```text
skill/assets/1.(jpg|jpeg|png|webp)  # main reference
skill/assets/2.(jpg|jpeg|png|webp)  # extra reference
skill/assets/3.(jpg|jpeg|png|webp)  # extra reference
skill/assets/4.(jpg|jpeg|png|webp)  # extra reference
```

Runtime lookup prefers `skill/assets/` and falls back to `assets/`.
The main image is always placed first, followed by `2`, `3`, and `4`.
If the numbered files are missing, `asuka.png` and the CDN URL remain as
compatibility fallbacks.

## Technical Details

- **Image Generation**: Alibaba Cloud Bailian / DashScope `wan2.6-image`
- **Messaging**: OpenClaw Gateway API
- **Supported Platforms**: Discord, Telegram, WhatsApp, Slack, Signal, MS Teams

## Project Structure

```
asuka/
├── bin/
│   └── cli.js           # npx installer
├── skill/
│   ├── SKILL.md         # Skill definition
│   ├── scripts/         # Generation scripts
│   └── assets/          # Bundled reference images (1/2/3/4)
├── templates/
│   └── soul-injection.md # Persona template
└── package.json
```

## License

MIT
