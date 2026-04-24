#!/bin/bash
# asuka-selfie.sh
# Edit Asuka's reference image with Alibaba Cloud Bailian / DashScope
# wan2.6-image and send it through OpenClaw.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

if [ -z "${DASHSCOPE_API_KEY:-}" ]; then
    log_error "DASHSCOPE_API_KEY environment variable not set"
    echo "Please configure your Alibaba Cloud Bailian / DashScope API key first."
    exit 1
fi

find_python_with_dashscope() {
    local explicit="${ASUKA_SELFIE_PYTHON:-}"
    local candidates=()
    local candidate=""

    if [ -n "$explicit" ]; then
        candidates+=("$explicit")
    fi

    if command -v python3 >/dev/null 2>&1; then
        candidates+=("$(command -v python3)")
    fi

    if command -v python >/dev/null 2>&1; then
        candidates+=("$(command -v python)")
    fi

    candidates+=(
        "/Users/zys/anaconda3/bin/python3"
        "/opt/homebrew/bin/python3"
        "/usr/local/bin/python3"
        "/usr/bin/python3"
    )

    for candidate in "${candidates[@]}"; do
        [ -n "$candidate" ] || continue
        [ -x "$candidate" ] || continue
        if "$candidate" -c 'import dashscope' >/dev/null 2>&1; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    return 1
}

PYTHON_BIN="$(find_python_with_dashscope || true)"
if [ -z "$PYTHON_BIN" ]; then
    log_error "No Python interpreter with dashscope SDK found"
    echo "Install with: python3 -m pip install --user -U dashscope"
    echo "Or set ASUKA_SELFIE_PYTHON to a Python that can import dashscope."
    exit 1
fi

if ! command -v openclaw >/dev/null 2>&1; then
    log_warn "openclaw CLI not found - will attempt direct API call"
    USE_CLI=false
else
    USE_CLI=true
fi

PROMPT="${1:-}"
PROMPT_FILE=""
CHANNEL=""
CAPTION=""
SIZE="1K"

if [ "${1:-}" = "--prompt-file" ]; then
    PROMPT=""
    PROMPT_FILE="${2:-}"
    CHANNEL="${3:-}"
    CAPTION="${4:-}"
    SIZE="${5:-1K}"
else
    CHANNEL="${2:-}"
    CAPTION="${3:-}"
    SIZE="${4:-1K}"
fi

DASHSCOPE_API_URL="${DASHSCOPE_API_URL:-https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation}"
DASHSCOPE_MODEL="${DASHSCOPE_MODEL:-wan2.6-image}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFERENCE_IMAGE_PATH="${ASUKA_REFERENCE_IMAGE_PATH:-}"
if [ -z "$REFERENCE_IMAGE_PATH" ]; then
    if [ -f "$SCRIPT_DIR/../assets/asuka.png" ]; then
        REFERENCE_IMAGE_PATH="$SCRIPT_DIR/../assets/asuka.png"
    elif [ -f "$SCRIPT_DIR/../../assets/asuka.png" ]; then
        REFERENCE_IMAGE_PATH="$SCRIPT_DIR/../../assets/asuka.png"
    fi
fi
REFERENCE_IMAGE_URL="${ASUKA_REFERENCE_IMAGE_URL:-https://cdn.jsdelivr.net/gh/SumeLabs/asuka@main/assets/asuka.png}"
EXTRA_REFERENCE_IMAGE_PATHS="${ASUKA_EXTRA_REFERENCE_IMAGE_PATHS:-}"
EXTRA_REFERENCE_IMAGE_URLS="${ASUKA_EXTRA_REFERENCE_IMAGE_URLS:-}"

find_bundled_reference() {
    for candidate in \
        "$SCRIPT_DIR/../assets/1.jpg" \
        "$SCRIPT_DIR/../assets/1.jpeg" \
        "$SCRIPT_DIR/../assets/1.png" \
        "$SCRIPT_DIR/../assets/1.webp" \
        "$SCRIPT_DIR/../../assets/1.jpg" \
        "$SCRIPT_DIR/../../assets/1.jpeg" \
        "$SCRIPT_DIR/../../assets/1.png" \
        "$SCRIPT_DIR/../../assets/1.webp" \
        "$SCRIPT_DIR/../assets/asuka.png" \
        "$SCRIPT_DIR/../../assets/asuka.png"
    do
        if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    return 1
}

find_bundled_extra_references() {
    for index in 2 3 4; do
        for candidate in \
            "$SCRIPT_DIR/../assets/${index}.jpg" \
            "$SCRIPT_DIR/../assets/${index}.jpeg" \
            "$SCRIPT_DIR/../assets/${index}.png" \
            "$SCRIPT_DIR/../assets/${index}.webp" \
            "$SCRIPT_DIR/../../assets/${index}.jpg" \
            "$SCRIPT_DIR/../../assets/${index}.jpeg" \
            "$SCRIPT_DIR/../../assets/${index}.png" \
            "$SCRIPT_DIR/../../assets/${index}.webp"
        do
            if [ -f "$candidate" ]; then
                printf '%s\n' "$candidate"
                break
            fi
        done
    done
}

join_paths_csv() {
    "$PYTHON_BIN" - "$@" <<'PY'
import sys
print(",".join(arg for arg in sys.argv[1:] if arg))
PY
}

if [ -z "$REFERENCE_IMAGE_PATH" ]; then
    REFERENCE_IMAGE_PATH="$(find_bundled_reference || true)"
fi

DEFAULT_EXTRA_REFERENCE_IMAGE_PATHS="$(join_paths_csv $(find_bundled_extra_references))"
if [ -n "$DEFAULT_EXTRA_REFERENCE_IMAGE_PATHS" ]; then
    if [ -n "$EXTRA_REFERENCE_IMAGE_PATHS" ]; then
        EXTRA_REFERENCE_IMAGE_PATHS="$DEFAULT_EXTRA_REFERENCE_IMAGE_PATHS,$EXTRA_REFERENCE_IMAGE_PATHS"
    else
        EXTRA_REFERENCE_IMAGE_PATHS="$DEFAULT_EXTRA_REFERENCE_IMAGE_PATHS"
    fi
fi

if [ -n "$PROMPT_FILE" ] && [ ! -f "$PROMPT_FILE" ]; then
    log_error "Prompt file not found: $PROMPT_FILE"
    exit 1
fi

TEMP_PROMPT_DIR=""
cleanup_temp_prompt_dir() {
    if [ -n "$TEMP_PROMPT_DIR" ] && [ -d "$TEMP_PROMPT_DIR" ]; then
        rm -rf "$TEMP_PROMPT_DIR" >/dev/null 2>&1 || true
    fi
}
trap cleanup_temp_prompt_dir EXIT

if [ -z "$PROMPT_FILE" ] && [ -n "$PROMPT" ]; then
    TEMP_PROMPT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/asuka-selfie.XXXXXX")"
    PROMPT_FILE="$TEMP_PROMPT_DIR/prompt.txt"
    printf '%s' "$PROMPT" > "$PROMPT_FILE"
fi

if [ -z "$PROMPT_FILE" ] || [ -z "$CHANNEL" ]; then
    echo "Usage: $0 <prompt> <channel> [caption] [size]"
    echo "   or: $0 --prompt-file <file> <channel> [caption] [size]"
    echo ""
    echo "Arguments:"
    echo "  prompt   - Edit prompt for Asuka's reference image"
    echo "  file     - UTF-8 text file containing the edit prompt"
    echo "  channel  - Target channel"
    echo "  caption  - Optional message caption"
    echo "  size     - Output size (default: 1K; also supports 2K or WxH)"
    echo ""
    echo "Default bundled references:"
    echo "  Main  - assets/1.(jpg|jpeg|png|webp)"
    echo "  Extra - assets/2.(jpg|jpeg|png|webp), 3.(...), 4.(...)"
    echo ""
    echo "Example:"
    echo "  $0 \"给她加一顶牛仔帽，镜子自拍，真实自然\" \"qqbot:c2c:12345\""
    exit 1
fi

PROMPT_META="$(
    PROMPT_FILE="$PROMPT_FILE" "$PYTHON_BIN" - <<'PY'
import os
from pathlib import Path

prompt_path = Path(os.environ["PROMPT_FILE"])
data = prompt_path.read_bytes()
text = data.decode("utf-8", errors="replace")
preview = " ".join(text.split())
if len(preview) > 160:
    preview = f"{preview[:160]}..."

print(len(data))
print(preview)
PY
)"
PROMPT_SIZE_BYTES="${PROMPT_META%%$'\n'*}"
PROMPT_PREVIEW="${PROMPT_META#*$'\n'}"

log_info "Editing Asuka reference image with wan2.6-image..."
log_info "Using Python: $PYTHON_BIN"
log_info "Prompt size: ${PROMPT_SIZE_BYTES} bytes"
log_info "Prompt preview: $PROMPT_PREVIEW"
log_info "Size: $SIZE"

if [ -n "$REFERENCE_IMAGE_PATH" ] && [ -f "$REFERENCE_IMAGE_PATH" ]; then
    PRIMARY_REFERENCE_IMAGE="$REFERENCE_IMAGE_PATH"
else
    PRIMARY_REFERENCE_IMAGE="$REFERENCE_IMAGE_URL"
fi

IMAGE_URL="$(
    PRIMARY_REFERENCE_IMAGE="$PRIMARY_REFERENCE_IMAGE" \
    EXTRA_REFERENCE_IMAGE_PATHS="$EXTRA_REFERENCE_IMAGE_PATHS" \
    EXTRA_REFERENCE_IMAGE_URLS="$EXTRA_REFERENCE_IMAGE_URLS" \
    DASHSCOPE_API_KEY="$DASHSCOPE_API_KEY" \
    DASHSCOPE_MODEL="$DASHSCOPE_MODEL" \
    PROMPT_FILE="$PROMPT_FILE" \
    SIZE="$SIZE" \
    "$PYTHON_BIN" - <<'PY'
import os
import sys
from pathlib import Path
from dashscope.aigc.image_generation import ImageGeneration


def split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def as_image_ref(value: str) -> str:
    if not value:
        return value
    if value.startswith(("http://", "https://", "data:", "file://")):
        return value
    path = Path(value).expanduser()
    if path.exists():
        return path.resolve().as_uri()
    return value


refs = [as_image_ref(os.environ["PRIMARY_REFERENCE_IMAGE"])]

for raw_path in split_csv(os.environ.get("EXTRA_REFERENCE_IMAGE_PATHS", "")):
    path = Path(raw_path).expanduser()
    if not path.exists():
        print(f"[WARN] Extra reference image path not found, skipping: {raw_path}", file=sys.stderr)
        continue
    refs.append(path.resolve().as_uri())

refs.extend(as_image_ref(url) for url in split_csv(os.environ.get("EXTRA_REFERENCE_IMAGE_URLS", "")))

deduped: list[str] = []
seen: set[str] = set()
for ref in refs:
    if ref and ref not in seen:
        seen.add(ref)
        deduped.append(ref)

limited = deduped[:4]
if len(deduped) > len(limited):
    print(
        f"[WARN] Wan image edit supports up to 4 reference images, truncating {len(deduped)} inputs to 4",
        file=sys.stderr,
    )

messages = [
    {
        "role": "user",
        "content": [{"text": Path(os.environ["PROMPT_FILE"]).read_text(encoding="utf-8")}] + [{"image": ref} for ref in limited],
    }
]

response = ImageGeneration.call(
    model=os.environ["DASHSCOPE_MODEL"],
    api_key=os.environ["DASHSCOPE_API_KEY"],
    messages=messages,
    prompt_extend=True,
    watermark=False,
    n=1,
    enable_interleave=False,
    size=os.environ["SIZE"],
)

if response.get("code") and response.get("message"):
    print(f"{response['code']}: {response['message']}", file=sys.stderr)
    sys.exit(1)

try:
    content = response["output"]["choices"][0]["message"]["content"]
except (KeyError, IndexError, TypeError) as exc:
    print(f"Failed to read image generation response: {exc}", file=sys.stderr)
    print(response, file=sys.stderr)
    sys.exit(1)

for item in content:
    image_url = item.get("image")
    if image_url:
        print(image_url)
        sys.exit(0)

print("Failed to extract image URL from response", file=sys.stderr)
print(response, file=sys.stderr)
sys.exit(1)
PY
)"

if [ -z "$IMAGE_URL" ]; then
    log_error "Image edit failed"
    exit 1
fi

log_info "Image generated successfully"
log_info "URL: $IMAGE_URL"

log_info "Sending to channel: $CHANNEL"

if [ "$USE_CLI" = true ]; then
    OPENCLAW_ARGS=()
    if [ -n "${OPENCLAW_PROFILE:-}" ]; then
        OPENCLAW_ARGS+=(--profile "$OPENCLAW_PROFILE")
    fi

    if [[ "$CHANNEL" == qqbot:* ]]; then
        SEND_ARGS=(message send --channel "qqbot" --target "$CHANNEL")
        if [ -n "$CAPTION" ]; then
            SEND_ARGS+=(--message "$CAPTION")
        fi
        SEND_ARGS+=(--media "$IMAGE_URL")
        openclaw "${OPENCLAW_ARGS[@]}" "${SEND_ARGS[@]}"
    else
        SEND_ARGS=(message send --channel "$CHANNEL")
        if [ -n "$CAPTION" ]; then
            SEND_ARGS+=(--message "$CAPTION")
        fi
        SEND_ARGS+=(--media "$IMAGE_URL")
        openclaw "${OPENCLAW_ARGS[@]}" "${SEND_ARGS[@]}"
    fi
else
    GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://localhost:18789}"
    GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

    curl -sS -X POST "$GATEWAY_URL/message" \
        -H "Content-Type: application/json" \
        ${GATEWAY_TOKEN:+-H "Authorization: Bearer $GATEWAY_TOKEN"} \
        -d "{
            \"action\": \"send\",
            \"channel\": \"$CHANNEL\",
            \"message\": \"$CAPTION\",
            \"media\": \"$IMAGE_URL\"
        }" >/dev/null
fi

log_info "Done! Image sent to $CHANNEL"

echo ""
echo "--- Result ---"
jq -n \
    --arg url "$IMAGE_URL" \
    --arg channel "$CHANNEL" \
    --arg prompt "$PROMPT" \
    '{
        success: true,
        image_url: $url,
        channel: $channel,
        prompt: $prompt
    }'
