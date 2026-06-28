// 内置风格库。每条只含元数据（name/desc + 设计提示 palette/font/density），
// 不含完整 CSS。提示词只注入这些元数据，由 AI 据此生成 design_tokens/theme_css。

export interface StylePreset {
  id: string;
  name: string;
  desc: string;
  palette: string;
  font: string;
  density: string;
}

export const STYLE_PRESETS: StylePreset[] = [
  { id: "tech", name: "科技风", desc: "深色背景、霓虹蓝紫、几何线条、未来感", palette: "深色+霓虹蓝紫", font: "无衬线+等宽点缀", density: "中等" },
  { id: "report", name: "商务汇报", desc: "稳重蓝灰、克制配色、强调数据与结论", palette: "蓝灰+白底", font: "无衬线", density: "中高" },
  { id: "fresh", name: "极简小清新", desc: "浅色留白、柔和莫兰迪、圆角", palette: "莫兰迪浅色", font: "无衬线圆体", density: "低" },
  { id: "magazine", name: "杂志编辑", desc: "大字标题、栅格排版、强对比、编辑感", palette: "黑白+单一强调色", font: "衬线标题+无衬线正文", density: "中等" },
  { id: "ink", name: "中国风水墨", desc: "宣纸底、墨色、留白、毛笔题字感", palette: "宣纸+墨黑+朱砂", font: "楷体/宋体", density: "低" },
  { id: "neon", name: "暗夜霓虹", desc: "纯黑底、荧光渐变、赛博朋克", palette: "纯黑+荧光粉青", font: "无衬线未来感", density: "中等" },
  { id: "academic", name: "学术严谨", desc: "白底、衬线、严谨图表、低饱和", palette: "白底+低饱和蓝", font: "衬线", density: "中高" },
  { id: "playful", name: "卡通活泼", desc: "明快糖果色、圆角、手绘元素", palette: "糖果多彩", font: "圆体", density: "低" },
  { id: "retro", name: "复古印刷", desc: "做旧米黄、双色印刷、噪点", palette: "米黄+红黑双色", font: "衬线老报纸", density: "中等" },
  { id: "organic", name: "自然有机", desc: "大地色、有机曲线、柔和渐变", palette: "大地色+草木绿", font: "无衬线圆体", density: "低" },
  { id: "industrial", name: "未来工业", desc: "深灰金属、橙黄警示、硬朗几何", palette: "深灰+警示橙", font: "无衬线机械感", density: "中等" },
  { id: "luxury", name: "优雅奢华", desc: "墨黑金、衬线、精致留白", palette: "墨黑+香槟金", font: "衬线", density: "低" },
];

export function getStyle(id?: string | null): StylePreset | null {
  if (!id) return null;
  return STYLE_PRESETS.find((s) => s.id === id) ?? null;
}

/**
 * 决定提示词风格注入模式。
 * - style 为非空且命中：explicit，只注入该预设。
 * - style 为空/null：auto，注入全部预设的元数据让 AI 自选并回填 style id。
 */
export function stylesForPrompt(
  style?: string | null
): { mode: "explicit"; preset: StylePreset } | { mode: "auto" } {
  const preset = getStyle(style);
  return preset ? { mode: "explicit", preset } : { mode: "auto" };
}

/** 把单个预设拼成给 AI 的提示文本块（标题+描述+设计提示）。 */
export function presetToPromptText(p: StylePreset): string {
  return `- ${p.name}（id:${p.id}）：${p.desc}。配色倾向：${p.palette}；字体倾向：${p.font}；版式密度：${p.density}。`;
}
