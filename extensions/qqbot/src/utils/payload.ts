/**
 * QQBot 结构化消息载荷工具
 * 
 * 用于处理 AI 输出的结构化消息载荷，包括：
 * - 定时提醒载荷 (cron_reminder)
 * - 媒体消息载荷 (media)
 */

// ============================================
// 类型定义
// ============================================

/**
 * 定时提醒载荷
 */
export interface CronReminderPayload {
  type: 'cron_reminder';
  /** 内部模式：普通提醒 / 承诺兑现 / 未回复追发 */
  mode?: 'reminder' | 'promise' | 'followup' | 'ambient' | 'repair';
  /** 提醒内容 */
  content: string;
  /** 目标类型：c2c (私聊) 或 group (群聊) */
  targetType: 'c2c' | 'group';
  /** 目标地址：user_openid 或 group_openid */
  targetAddress: string;
  /** 原始消息 ID（可选） */
  originalMessageId?: string;
  /** 一次性触发时间（ISO 时间字符串） */
  at?: string;
  /** 周期 cron 表达式 */
  cron?: string;
  /** 时区 */
  tz?: string;
  /** 提醒名称 */
  name?: string;
  /** 是否执行后删除（一次性提醒默认 true） */
  deleteAfterRun?: boolean;
  /** 承诺 ID（Asuka 连续状态内部使用） */
  promiseId?: string;
  /** peerKey（Asuka 连续状态内部使用） */
  peerKey?: string;
  /** 追发轮次 */
  followUpAttempt?: number;
  /** 只有在这之后用户仍未回复时才发送 */
  guardNoReplySince?: number;
  /** 生活线 ID（Asuka 连续状态内部使用） */
  ambientThreadId?: string;
  /** 生活线阶段 */
  ambientStage?: number;
  /** 场景推进策略 */
  advancePolicy?: 'advance' | 'hold' | 'fade';
  /** 调度时捕获的场景版本 */
  sceneVersion?: number;
  /** 调度时捕获的场景标签 */
  sceneSnapshotLabel?: string;
  /**
   * @deprecated 请使用 advancePolicy
   * 是否跳过生活线推进
   */
  /** 是否跳过生活线推进 */
  ambientSkipAdvance?: boolean;
  /** 若存在则优先按自拍流程兑现，而不是普通文本发送 */
  selfiePrompt?: string;
  /** 自拍兑现时附带的自然配文 */
  selfieCaption?: string;
}

/**
 * 媒体消息载荷
 */
export interface MediaPayload {
  type: 'media';
  /** 媒体类型：image, audio, video, file */
  mediaType: 'image' | 'audio' | 'video' | 'file';
  /** 来源类型：url 或 file */
  source: 'url' | 'file';
  /** 媒体路径或 URL */
  path: string;
  /** 媒体描述（可选） */
  caption?: string;
}

/**
 * Asuka 自拍载荷
 */
export interface SelfiePayload {
  type: 'selfie';
  /** 可选提示字段，兼容旧格式；实际生图 prompt 由网关基于对话上下文本地生成 */
  prompt?: string;
  /** 可选配文，由模型决定是否发送 */
  caption?: string;
}

/**
 * QQBot 载荷联合类型
 */
export type QQBotPayload = CronReminderPayload | MediaPayload | SelfiePayload;

/**
 * 解析结果
 */
export interface ParseResult {
  /** 是否为结构化载荷 */
  isPayload: boolean;
  /** 解析后的载荷对象（如果是结构化载荷） */
  payload?: QQBotPayload;
  /** 载荷前的用户可见文本 */
  leadingText?: string;
  /** 载荷后的用户可见文本 */
  trailingText?: string;
  /** 原始文本（如果不是结构化载荷） */
  text?: string;
  /** 解析错误信息（如果解析失败） */
  error?: string;
}

export interface RecoveredSelfiePayloadResult {
  payload: SelfiePayload;
  leadingText?: string;
  trailingText?: string;
  incompleteFields: string[];
}

// ============================================
// 常量定义
// ============================================

/** AI 输出的结构化载荷前缀 */
const PAYLOAD_PREFIX = 'QQBOT_PAYLOAD:';

/** Cron 消息存储的前缀 */
const CRON_PREFIX = 'QQBOT_CRON:';

/** 让 cron agent 原样回显文本，避免把任务总结发给用户 */
export function wrapExactMessageForAgentTurn(rawMessage: string): string {
  return [
    "这是一次纯转发任务。",
    "你只能回复下面这段内容本身，从第一个字符到最后一个字符完全一致。",
    "不要解释，不要总结，不要改写，不要加引号，不要加代码块，不要调用任何工具，不要再输出任何第二段内容。",
    "输出完这段内容后立刻停止。",
    rawMessage,
  ].join("\n");
}

// ============================================
// 解析函数
// ============================================

function extractJsonObject(raw: string): { json: string; rest: string } | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return {
          json: raw.slice(start, i + 1),
          rest: raw.slice(i + 1),
        };
      }
    }
  }

  return null;
}

function decodeJsonLikeString(raw: string): string {
  return raw
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .trim();
}

function extractJsonStringField(
  raw: string,
  key: string,
): { value: string; terminated: boolean } | null {
  const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`, "i");
  const match = keyPattern.exec(raw);
  if (!match) return null;

  let value = "";
  let escaped = false;
  const start = match.index + match[0].length;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escaped) {
      value += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      value += ch;
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      return { value: decodeJsonLikeString(value), terminated: true };
    }
    value += ch;
  }

  return { value: decodeJsonLikeString(value), terminated: false };
}

export function recoverIncompleteSelfiePayload(text: string): RecoveredSelfiePayloadResult | null {
  const prefixIndex = text.indexOf(PAYLOAD_PREFIX);
  if (prefixIndex < 0) return null;

  const leadingText = text.slice(0, prefixIndex).trim();
  const payloadSection = text.slice(prefixIndex + PAYLOAD_PREFIX.length).trim();
  if (!/"type"\s*:\s*"selfie"/i.test(payloadSection)) {
    return null;
  }

  const promptField = extractJsonStringField(payloadSection, "prompt");
  const captionField = extractJsonStringField(payloadSection, "caption");
  const incompleteFields: string[] = [];
  if (promptField && !promptField.terminated) incompleteFields.push("prompt");
  if (captionField && !captionField.terminated) incompleteFields.push("caption");

  const payload: SelfiePayload = {
    type: "selfie",
  };
  if (promptField?.value) {
    payload.prompt = promptField.value;
  }
  if (captionField?.value) {
    payload.caption = captionField.value;
  }

  if (!payload.prompt && !payload.caption) {
    incompleteFields.push("payload");
  }

  return {
    payload,
    leadingText,
    trailingText: "",
    incompleteFields,
  };
}

/**
 * 解析 AI 输出的结构化载荷
 * 
 * 检测消息中是否包含 QQBOT_PAYLOAD: 前缀，如果是则提取并解析 JSON
 * 
 * @param text AI 输出的原始文本
 * @returns 解析结果
 * 
 * @example
 * const result = parseQQBotPayload('QQBOT_PAYLOAD:\n{"type": "media", "mediaType": "image", ...}');
 * if (result.isPayload && result.payload) {
 *   // 处理结构化载荷
 * }
 */
export function parseQQBotPayload(text: string): ParseResult {
  const prefixIndex = text.indexOf(PAYLOAD_PREFIX);

  if (prefixIndex < 0) {
    return {
      isPayload: false,
      text: text
    };
  }

  const leadingText = text.slice(0, prefixIndex).trim();
  const payloadSection = text.slice(prefixIndex + PAYLOAD_PREFIX.length).trim();
  const extracted = extractJsonObject(payloadSection);

  if (!extracted) {
    return {
      isPayload: true,
      leadingText,
      error: '载荷 JSON 对象不完整'
    };
  }

  const jsonContent = extracted.json.trim();
  const trailingText = extracted.rest.trim();
  
  if (!jsonContent) {
    return {
      isPayload: true,
      leadingText,
      trailingText,
      error: '载荷内容为空'
    };
  }
  
  try {
    const payload = JSON.parse(jsonContent) as QQBotPayload;
    
    // 验证必要字段
    if (!payload.type) {
      return {
        isPayload: true,
        leadingText,
        trailingText,
        error: '载荷缺少 type 字段'
      };
    }
    
    // 根据 type 进行额外验证
    if (payload.type === 'cron_reminder') {
      if (!payload.content || !payload.targetType || !payload.targetAddress) {
        return {
          isPayload: true,
          leadingText,
          trailingText,
          error: 'cron_reminder 载荷缺少必要字段 (content, targetType, targetAddress)'
        };
      }
    } else if (payload.type === 'media') {
      if (!payload.mediaType || !payload.source || !payload.path) {
        return {
          isPayload: true,
          leadingText,
          trailingText,
          error: 'media 载荷缺少必要字段 (mediaType, source, path)'
        };
      }
    } else if (payload.type === 'selfie') {
      if (
        (payload.prompt !== undefined && typeof payload.prompt !== 'string')
        || (payload.caption !== undefined && typeof payload.caption !== 'string')
      ) {
        return {
          isPayload: true,
          leadingText,
          trailingText,
          error: 'selfie 载荷字段类型不合法 (prompt/caption)'
        };
      }
    }
    
    return {
      isPayload: true,
      payload,
      leadingText,
      trailingText
    };
  } catch (e) {
    return {
      isPayload: true,
      leadingText,
      trailingText,
      error: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}

// ============================================
// Cron 编码/解码函数
// ============================================

/**
 * 将定时提醒载荷编码为 Cron 消息格式
 * 
 * 将 JSON 编码为 Base64，并添加 QQBOT_CRON: 前缀
 * 
 * @param payload 定时提醒载荷
 * @returns 编码后的消息字符串，格式为 QQBOT_CRON:{base64}
 * 
 * @example
 * const message = encodePayloadForCron({
 *   type: 'cron_reminder',
 *   content: '喝水时间到！',
 *   targetType: 'c2c',
 *   targetAddress: 'user_openid_xxx'
 * });
 * // 返回: QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs...
 */
export function encodePayloadForCron(payload: CronReminderPayload): string {
  const jsonString = JSON.stringify(payload);
  const base64 = Buffer.from(jsonString, 'utf-8').toString('base64');
  return `${CRON_PREFIX}${base64}`;
}

/**
 * 解码 Cron 消息中的载荷
 * 
 * 检测 QQBOT_CRON: 前缀，解码 Base64 并解析 JSON
 * 
 * @param message Cron 触发时收到的消息
 * @returns 解码结果，包含是否为 Cron 载荷、解析后的载荷对象或错误信息
 * 
 * @example
 * const result = decodeCronPayload('QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs...');
 * if (result.isCronPayload && result.payload) {
 *   // 处理定时提醒
 * }
 */
export function decodeCronPayload(message: string): {
  isCronPayload: boolean;
  payload?: CronReminderPayload;
  error?: string;
} {
  const prefixIndex = message.indexOf(CRON_PREFIX);
  if (prefixIndex < 0) {
    return {
      isCronPayload: false
    };
  }

  const remainder = message.slice(prefixIndex + CRON_PREFIX.length).trim();
  const base64Match = remainder.match(/^([A-Za-z0-9+/=]+)/);
  const base64Content = base64Match?.[1] ?? "";
  
  if (!base64Content) {
    return {
      isCronPayload: true,
      error: 'Cron 载荷内容为空'
    };
  }
  
  try {
    // Base64 解码
    const jsonString = Buffer.from(base64Content, 'base64').toString('utf-8');
    const payload = JSON.parse(jsonString) as CronReminderPayload;
    
    // 验证类型
    if (payload.type !== 'cron_reminder') {
      return {
        isCronPayload: true,
        error: `期望 type 为 cron_reminder，实际为 ${payload.type}`
      };
    }
    
    // 验证必要字段
    if (!payload.content || !payload.targetType || !payload.targetAddress) {
      return {
        isCronPayload: true,
        error: 'Cron 载荷缺少必要字段'
      };
    }
    
    return {
      isCronPayload: true,
      payload
    };
  } catch (e) {
    return {
      isCronPayload: true,
      error: `Cron 载荷解码失败: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}

// ============================================
// 辅助函数
// ============================================

/**
 * 判断载荷是否为定时提醒类型
 */
export function isCronReminderPayload(payload: QQBotPayload): payload is CronReminderPayload {
  return payload.type === 'cron_reminder';
}

/**
 * 判断载荷是否为媒体消息类型
 */
export function isMediaPayload(payload: QQBotPayload): payload is MediaPayload {
  return payload.type === 'media';
}

/**
 * 判断载荷是否为自拍类型
 */
export function isSelfiePayload(payload: QQBotPayload): payload is SelfiePayload {
  return payload.type === 'selfie';
}
