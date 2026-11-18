/** 容错 JSON 解析与上游载荷归一化 —— 上游模型永远可能不守契约。 */

export function extractJsonBlock(text: string): string | null {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence?.[1]) t = fence[1].trim();

  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return t.slice(start, i + 1);
    }
  }
  return t.slice(start);
}

export function parseJsonLoose<T = unknown>(text: string): T | null {
  const block = extractJsonBlock(text);
  if (!block) return null;
  try {
    return JSON.parse(block) as T;
  } catch {
    /* 尝试常见修复：尾逗号、BOM、单引号键 */
  }
  const repaired = block
    .replace(/^\uFEFF/, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)'([^'\n]+)'\s*:/g, '$1"$2":');
  try {
    return JSON.parse(repaired) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ 基础读取 */

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

export function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

export function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^(true|yes|1|是|通过|pass)$/i.test(v.trim())) return true;
    if (/^(false|no|0|否|不通过|reject)$/i.test(v.trim())) return false;
  }
  if (typeof v === 'number') return v !== 0;
  return fallback;
}

export function asStringArray(v: unknown, max = 12): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' ? x.trim() : typeof x === 'object' ? '' : String(x).trim()))
      .filter(Boolean)
      .slice(0, max);
  }
  if (typeof v === 'string' && v.trim()) {
    return v
      .split(/[、,，;；\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, max);
  }
  return [];
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/* ---------------------------------------------------------- 展示辅助 */

export function safeStringify(v: unknown, indent = 2): string {
  try {
    return JSON.stringify(v, null, indent);
  } catch {
    return String(v);
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
