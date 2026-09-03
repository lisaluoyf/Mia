const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:authorization|api[ _-]?key|token|password|secret|密码|密钥)\s*[=:：]\s*[^\s,;]+/gi,
  /https:\/\/api\.telegram\.org\/file\/bot[^\s"']+/gi,
];
const DATA_URL = /data:([^;,]+);base64,[A-Za-z0-9+/=]+/g;
const MAX_STRING_LENGTH = 8_000;

export function sanitizeDebugString(value: string): string {
  let sanitized = value.replace(DATA_URL, (_match, mimeType: string) => `[${mimeType} base64 omitted]`);
  for (const pattern of SECRET_PATTERNS) sanitized = sanitized.replace(pattern, "[redacted]");
  return sanitized.length > MAX_STRING_LENGTH
    ? `${sanitized.slice(0, MAX_STRING_LENGTH)}\n[truncated]`
    : sanitized;
}

export function sanitizeDebugValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[depth limit]";
  if (typeof value === "string") return sanitizeDebugString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value ?? null;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return `[binary ${value.byteLength} bytes omitted]`;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeDebugValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      if (/^(?:authorization|apiKey|api_key|botToken|bot_token|secret|password)$/i.test(key)) {
        result[key] = "[redacted]";
      } else {
        result[key] = sanitizeDebugValue(item, depth + 1);
      }
    }
    return result;
  }
  return `[${typeof value} omitted]`;
}
