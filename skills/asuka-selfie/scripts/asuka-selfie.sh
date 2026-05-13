#!/bin/bash
# asuka-selfie.sh
# Edit Asuka's reference image with a Studio OpenAI-compatible media API
# and send it through OpenClaw.

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

if [ -z "${STUDIO_API_KEY:-}" ] && [ -n "${DASHSCOPE_API_KEY:-}" ]; then
    STUDIO_API_KEY="$DASHSCOPE_API_KEY"
fi

if [ -z "${STUDIO_API_KEY:-}" ]; then
    log_error "STUDIO_API_KEY environment variable not set"
    echo "Please configure your Studio media API key first."
    exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
    log_error "curl not found"
    exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
    log_error "jq not found"
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

STUDIO_API_BASE_URL="${STUDIO_API_BASE_URL:-https://api.awnjkankwik.asia/studio/v1}"
STUDIO_API_BASE_URL="${STUDIO_API_BASE_URL%/}"
STUDIO_IMAGE_MODEL="${STUDIO_IMAGE_EDIT_MODEL:-${STUDIO_IMAGE_MODEL:-${STUDIO_MODEL:-${DASHSCOPE_MODEL:-third_party_media:gemini-3-pro-image-preview}}}}"
STUDIO_IMAGE_QUALITY="${STUDIO_IMAGE_QUALITY:-standard}"
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
    local result=""
    local item=""
    for item in "$@"; do
        [ -n "$item" ] || continue
        if [ -n "$result" ]; then
            result="$result,$item"
        else
            result="$item"
        fi
    done
    printf '%s\n' "$result"
}

normalize_studio_size() {
    case "${1:-1024x1024}" in
        1K|1k) printf '%s\n' "1024x1024" ;;
        2K|2k) printf '%s\n' "2048x2048" ;;
        *) printf '%s\n' "${1:-1024x1024}" ;;
    esac
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
    echo "  size     - Output size (default: 1024x1024; legacy 1K maps to 1024x1024)"
    echo ""
    echo "Default bundled references:"
    echo "  Main  - assets/1.(jpg|jpeg|png|webp)"
    echo "  Extra - assets/2.(jpg|jpeg|png|webp), 3.(...), 4.(...)"
    echo ""
    echo "Example:"
    echo "  $0 \"给她加一顶牛仔帽，镜子自拍，真实自然\" \"qqbot:c2c:12345\""
    exit 1
fi

PROMPT_SIZE_BYTES="$(wc -c < "$PROMPT_FILE" | tr -d '[:space:]')"
PROMPT_PREVIEW="$(tr '\r\n\t' '   ' < "$PROMPT_FILE" | tr -s ' ' | cut -c 1-160)"
if [ "$PROMPT_SIZE_BYTES" -gt 160 ]; then
    PROMPT_PREVIEW="${PROMPT_PREVIEW}..."
fi
NORMALIZED_SIZE="$(normalize_studio_size "$SIZE")"

log_info "Editing Asuka reference image with Studio media API..."
log_info "Prompt size: ${PROMPT_SIZE_BYTES} bytes"
log_info "Prompt preview: $PROMPT_PREVIEW"
log_info "Model: $STUDIO_IMAGE_MODEL"
log_info "Size: $NORMALIZED_SIZE"

if [ -n "$REFERENCE_IMAGE_PATH" ] && [ -f "$REFERENCE_IMAGE_PATH" ]; then
    PRIMARY_REFERENCE_IMAGE="$REFERENCE_IMAGE_PATH"
else
    PRIMARY_REFERENCE_IMAGE="$REFERENCE_IMAGE_URL"
fi

if [ -n "$EXTRA_REFERENCE_IMAGE_PATHS" ] || [ -n "$EXTRA_REFERENCE_IMAGE_URLS" ]; then
    log_warn "Studio image edit API accepts a single multipart image; using the primary reference only"
fi

TEMP_REQUEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/asuka-selfie-api.XXXXXX")"
cleanup_temp_request_dir() {
    if [ -n "${TEMP_REQUEST_DIR:-}" ] && [ -d "$TEMP_REQUEST_DIR" ]; then
        rm -rf "$TEMP_REQUEST_DIR" >/dev/null 2>&1 || true
    fi
}
trap 'cleanup_temp_prompt_dir; cleanup_temp_request_dir' EXIT

UPLOAD_IMAGE="$PRIMARY_REFERENCE_IMAGE"
if [[ "$UPLOAD_IMAGE" == http://* || "$UPLOAD_IMAGE" == https://* ]]; then
    DOWNLOADED_REFERENCE="$TEMP_REQUEST_DIR/reference-image"
    curl -fsSL "$UPLOAD_IMAGE" -o "$DOWNLOADED_REFERENCE"
    UPLOAD_IMAGE="$DOWNLOADED_REFERENCE"
fi

if [ ! -f "$UPLOAD_IMAGE" ]; then
    log_error "Reference image file not found: $UPLOAD_IMAGE"
    exit 1
fi

RESPONSE_FILE="$TEMP_REQUEST_DIR/response.json"
HTTP_STATUS="$(
    curl -sS -w '%{http_code}' -o "$RESPONSE_FILE" \
        -X POST "$STUDIO_API_BASE_URL/images/edits" \
        -H "Authorization: Bearer $STUDIO_API_KEY" \
        -H "Accept: application/json" \
        -F "model=$STUDIO_IMAGE_MODEL" \
        -F "prompt=<$PROMPT_FILE" \
        -F "size=$NORMALIZED_SIZE" \
        -F "n=1" \
        -F "quality=$STUDIO_IMAGE_QUALITY" \
        -F "response_format=url" \
        -F "image=@$UPLOAD_IMAGE"
)"

if [ "${HTTP_STATUS:-0}" -ge 400 ]; then
    ERROR_MESSAGE="$(jq -r '.error.message // .error // .' "$RESPONSE_FILE" 2>/dev/null || cat "$RESPONSE_FILE")"
    log_error "Studio image edit failed: HTTP $HTTP_STATUS $ERROR_MESSAGE"
    exit 1
fi

IMAGE_URL="$(jq -er 'first((.data[]?.url // empty), (.result_urls[]? // empty))' "$RESPONSE_FILE" 2>/dev/null || true)"

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
