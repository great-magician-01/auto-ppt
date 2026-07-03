/**
 * 工具调用相关纯函数：无 Vue/DB 依赖，可独立校验。
 */

/**
 * 从流式（可能不完整的）工具参数 JSON 中，容错提取首个字符串字段的值。
 * 用于单字段工具（write_slide_html/apply_selfcheck 的 html、write_manuscript 的 content）
 * 的逐 token 实时预览：参数形如 {"html":"<!DOCTYPE..."}，html 是首个也是唯一字符串字段。
 *
 * 策略：定位 `"key":` 后的字符串字面量起始引号，取到字符串末尾（未闭合则取到串尾），
 * 反转义 JSON 字符串转义。不要求 JSON 完整可解析。
 */
export function extractStringArg(partial: string): string {
  if (!partial) return "";
  // 找到 key 结束引号 + 冒号（形如 "html":）；跳过此前的内容
  const sep = partial.indexOf('":');
  if (sep < 0) return "";
  let i = sep + 2; // 跳过 ":
  while (i < partial.length && /\s/.test(partial[i])) i++;
  if (partial[i] !== '"') return ""; // 首个值不是字符串
  i++; // 跳过起始引号
  let out = "";
  while (i < partial.length) {
    const c = partial[i];
    if (c === "\\") {
      const next = partial[i + 1];
      if (next === undefined) break;
      switch (next) {
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "u": {
          const hex = partial.slice(i + 2, i + 6);
          if (hex.length === 4) {
            const code = parseInt(hex, 16);
            if (!Number.isNaN(code)) out += String.fromCharCode(code);
            i += 6;
            continue;
          }
          break;
        }
        default: out += next;
      }
      i += 2;
      continue;
    }
    if (c === '"') break; // 字符串闭合
    out += c;
    i++;
  }
  return out;
}

/** 工具调用卡片的一行摘要标签。args 为已解析的工具参数对象；ctx.index 为页索引（0 基）。 */
export function toolLabel(
  name: string,
  args: unknown,
  ctx?: { index?: number }
): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "write_manuscript": {
      const len = typeof a.content === "string" ? a.content.length : 0;
      return `📝 文案 · ${len} 字`;
    }
    case "commit_outline": {
      const n = Array.isArray(a.slides) ? a.slides.length : 0;
      return `🗂 大纲 · ${n} 页`;
    }
    case "write_slide_html": {
      const idx = ctx?.index;
      return `🎨 单页 HTML${idx != null ? ` · 第 ${idx + 1} 页` : ""}`;
    }
    case "apply_selfcheck":
      return "🔍 自检改写";
    default:
      return name;
  }
}
