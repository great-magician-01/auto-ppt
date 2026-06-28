// 提示词：两阶段生成。
// 阶段1：大纲 + 设计系统（返回 JSON：design_tokens / theme_css / slides）
// 阶段2：逐页生成完整 HTML（内联共享 theme.css，固定 1920x1080）

export const SLIDE_W = 1920;
export const SLIDE_H = 1080;

import {
  stylesForPrompt,
  presetToPromptText,
  STYLE_PRESETS,
} from "./styles";

export function outlinePrompt(
  topic: string,
  slideCount: number,
  style?: string | null
): string {
  const styleMode = stylesForPrompt(style);
  let styleSection = "";
  let styleReturnClause = "";
  if (styleMode.mode === "explicit") {
    styleSection = `\n\n【风格要求（必须严格遵守）】\n${presetToPromptText(styleMode.preset)}\n请据此确定 design_tokens 与 theme_css，保证整体观感符合上述风格。`;
  } else {
    const all = STYLE_PRESETS.map(presetToPromptText).join("\n");
    styleSection = `\n\n【风格选择】\n下方是候选风格，请挑选最契合主题的一个，并据此设计 design_tokens 与 theme_css：\n${all}`;
    styleReturnClause = `\n4. style：你在上面挑选的风格 id（字符串）。`;
  }

  return `你是一位专业的 PPT 设计师与信息架构师。请为主题「${topic}」设计一份 ${slideCount} 页的精美 PPT，先确定统一的设计系统，再给出每页大纲。${styleSection}

【输出要求】
1. design_tokens：专业协调的配色与字体方案，字段为 primary / accent / background / surface / text / textMuted / fonts / titleSize / bodySize（颜色用 #hex；titleSize 72–96px、bodySize 32–44px，必须保证投影可读，禁止偏小）。字体用系统通用字体族（如 "Microsoft YaHei"/"PingFang SC"/sans-serif 或 monospace），不要依赖需联网加载的字体。
2. theme_css：基于上述 tokens 的完整 CSS，包含 :root 中的 CSS 变量，以及通用类 .slide、.slide-title、.slide-body、.accent-bar 等。所有页面共享它。theme_css 必须遵守以下弹性铁律以防止内容溢出：
   - .slide 固定为 ${SLIDE_W}px × ${SLIDE_H}px（16:9），overflow:hidden，box-sizing:border-box，且必须 display:flex; flex-direction:column;
   - 必须包含 body,html { margin:0; padding:0; } 重置，消除默认 8px 边距导致的整体下移
   - :root 中的字号变量必须使用 clamp() 实现弹性，如 --titleSize: clamp(56px, 5vw, 96px); --bodySize: clamp(24px, 2vw, 40px); 确保内容多时自动缩小，但正文最小不低于 20px
   - 所有直接子内容容器（如 .content、.grid、.columns、.cards）必须允许弹性收缩：使用 min-height:0; flex-shrink:1; overflow:visible（不要加 overflow:hidden，否则截图时隐藏内容会丢失）
   - 文本容器必须设置合理的 max-height（如 calc(100% - 标题高度)）配合 overflow:visible，确保所有文本在截图时完整可见
3. slides：数组，第一页 kind=cover（封面），最后一页 kind=ending（致谢），中间用 cover/bullets/two-column/quote/section 等版式。每页含 title（标题）、kind（版式）、bullets（要点字符串数组）。中间内容页 bullets 至少 4 条，每条应是一个有信息量的完整要点（可含简短支撑说明、数据或案例），内容充实专业、紧扣主题展开；封面/致谢可短。${styleReturnClause}

内容要专业、充实、紧扣主题，避免空洞。

【严格】只返回一个 JSON 对象，不要 markdown 代码块、不要解释文字。结构如下：
{"design_tokens":{...},"theme_css":"/* css string */","slides":[{"title":"","kind":"cover","bullets":[]}...],"style":"<风格id，仅自动模式需要>"}`;
}

export interface OutlineSlide {
  title: string;
  kind: string;
  bullets: string[];
}

export function slideHtmlPrompt(args: {
  topic: string;
  designTokens: string;
  themeCss: string;
  slide: OutlineSlide;
  index: number; // 从 1 开始
  total: number;
}): string {
  const { topic, designTokens, themeCss, slide, index, total } = args;
  return `你是一位顶级 PPT 设计师，正在为「${topic}」制作一份精美的演示文稿。这是第 ${index}/${total} 页。目标是产出视觉精致、信息充实、可直接用于正式汇报的高质量页面。

【已确定的设计系统，所有页面必须严格遵守以保证风格统一】
${designTokens}

【共享 theme.css —— 必须原样内联到 <style>，严禁改动其中任何内容】
${themeCss}

【本页信息】
- 标题：${slide.title}
- 版式：${slide.kind}
- 要点：${JSON.stringify(slide.bullets)}

【视觉与排版要求（精美 PPT 标准）】
1. 输出完整 HTML 文档：<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>…</style></head><body><div class="slide">…</div></body></html>。<style> 中先原样粘贴上面的 theme.css，再追加本页专属样式。
2. 画布 .slide 固定 ${SLIDE_W}×${SLIDE_H}（16:9），overflow:hidden，box-sizing:border-box，内边距 padding 不少于 64px。
3. 字号必须适合投影可读：页面标题 64–96px，要点/正文 32–44px，辅助说明 24–28px。若 theme.css 里的 title-size/body-size 偏小，在本页样式中覆盖放大字号（仅放大字号，绝不改颜色、字体、背景）。
4. 内容必须充实饱满，禁止大面积空白：把每个要点展开为 1–3 句具体说明、数据、案例或子要点；信息量大时用两栏/三栏/分区网格布局排布，而不是稀疏罗列三五条短句让页面空旷。封面/致谢/section 可适度留白但仍要有视觉主体。
5. 视觉要精致：用版式结构（分区、分栏、网格、序号编号、徽标、accent 装饰条、几何点缀、留白比例）营造层次与质感，避免纯文本堆砌的朴素列表感。版式（cover/bullets/two-column/quote/section 等）通过布局结构来区分。
6. 【风格一致性铁律】所有页面的背景、配色、字体必须与设计系统完全一致。禁止为任何版式整页更换背景（不得出现 .slide.section/.slide.cover 之类覆盖 background 的规则），禁止改写 :root 变量，禁止为单页换色或换字体。不同页面之间只能有布局结构的差异，视觉基调必须统一如同一套模板。
7. 内容绝不溢出 ${SLIDE_W}×${SLIDE_H} 画布：通过合理分栏、分区与字号控制来容纳丰富内容，宁可多分一栏/分区也不要缩小到看不清；严禁溢出边界。
8. 【弹性排版铁律——防止溢出的核心手段】
   - 字号优先使用 clamp()：页面标题 'font-size: clamp(48px, 4.5vw, 96px)'，正文 'font-size: clamp(20px, 1.8vw, 40px)'，辅助说明 'font-size: clamp(18px, 1.5vw, 28px)'；内容极多时可进一步压低 clamp 上限，但正文绝不低于 20px
   - 卡片/分区容器必须 'min-height: 0; flex-shrink: 1; overflow: visible'（不要加 overflow:hidden，否则导出截图时隐藏内容会丢失），允许内容区弹性压缩而非撑破画布
   - Grid 布局的行列尺寸使用 'minmax(0, 1fr)' 而非裸 '1fr'，否则文本会撑出网格轨道
   - 当要点超过 4 条或单条文字较长时，主动增加分栏数（如 3 栏或 4 栏）、减小 gap（最小 16px）与 padding（最小 48px），用空间换密度
   - 控制行高防止垂直溢出：正文 line-height 不超过 1.4，标题 line-height 不超过 1.2
   - 本页追加的样式中必须包含 'body { margin: 0; padding: 0; }'
9. 全部样式内联在 <style> 中，不引用任何外部图片/字体/资源（不得使用 @import 或 Google Fonts 链接，字体用系统字体或 theme.css 已定义的字体族）。
10. 只输出 HTML 本身，不要 markdown 代码块、不要任何解释。`;
}

/**
 * 从字符串中提取第一个完整的顶层 JSON 对象（大括号配平，跳过字符串内的括号）。
 * 可忽略 JSON 前后的解释文字、代码块标记等。
 */
export function extractFirstJsonObject(s: string): string {
  const start = s.indexOf("{");
  if (start < 0) throw new Error('未找到 JSON 起始 "{"');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  throw new Error('JSON 大括号未闭合');
}

/** 解析模型返回的 JSON（容错：去代码块包裹 + 大括号配平提取，忽略 JSON 后的解释文字）。 */
export function parseOutline(raw: string): {
  design_tokens: Record<string, string>;
  theme_css: string;
  slides: OutlineSlide[];
} {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  s = extractFirstJsonObject(s);
  const obj = JSON.parse(s);
  if (!obj || !Array.isArray(obj.slides)) {
    throw new Error("大纲缺少 slides 字段或格式不符");
  }
  return obj;
}

/** 清理单页 HTML（去掉可能的 ``` 包裹；流式中途未闭合的代码块也处理）。 */
export function cleanHtml(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  // 流式过程中代码块尚未闭合：去掉开头的 ```html
  return s.replace(/^```(?:html)?\s*/i, "");
}

/** 多模态自检：对照截图与当前 HTML，仅修正溢出/排版/对齐问题，严禁改动主题样式。 */
export function selfCheckPrompt(html: string): string {
  return `你是 PPT 视觉自检员。对照附图（当前页面渲染截图）与下方当前 HTML，检查是否存在内容溢出 ${SLIDE_W}×${SLIDE_H} 画布、元素错位、对齐混乱、字号过小看不清等“硬伤”。若有，仅做最小幅度修正；若无，原样返回该 HTML。

当前 HTML：
${html}

【铁律：主题样式必须原样保留】
1. <style> 中 :root 变量、body/html 背景、.slide 的 background、所有配色与字体必须逐字保留，禁止任何改动（黑色背景就是黑色背景，禁止改成白色或其他颜色）。
2. 只允许调整布局类属性：margin/padding/width/height/grid/flex/行高/定位，以消除溢出与错位。
3. 画布 .slide 固定 ${SLIDE_W}×${SLIDE_H}，overflow:hidden，box-sizing:border-box，内边距不少于 48px。
4. 修复溢出的首选手段（按优先级）：
   a) 把固定字号改为 clamp() 或缩小 clamp 上限（正文不低于 20px）
   b) 给文本容器加 'min-height: 0; flex-shrink: 1; overflow: visible'（不要加 overflow:hidden，否则导出截图时隐藏内容会丢失）
   c) Grid 行列改用 'minmax(0, 1fr)'
   d) 减小 gap/padding（padding 最低 48px，gap 最低 12px）
   e) 控制行高：正文 line-height 不超过 1.4，标题 line-height 不超过 1.2
   f) 极端情况下可对过长文本使用 '-webkit-line-clamp' 或多行截断，但优先保留完整信息
5. 不得新增或删除任何 class、不得改写标签结构，只修样式值。

【输出】只输出完整 HTML 文档（<!DOCTYPE html>…</html>），不要 markdown 代码块、不要解释。若页面无明显硬伤，必须原样返回上面那段 HTML（一字不改）。`;
}


/** 调试模式选中元素修改：用户选中了一个元素，仅改该部分，返回整页 HTML。 */
export function chatWithElementPrompt(args: {
  html: string;
  elementHtml: string;
  selector: string;
  instruction: string;
}): string {
  return `这是当前页 HTML：
${args.html}

用户用调试模式选中了页面中一个元素，仅改动该元素对应的部分，其余结构保持不变。返回修改后的完整 HTML 文档（<!DOCTYPE html>…</html>），不要 markdown 代码块、不要解释。

选中元素 HTML：
${args.elementHtml}

定位（CSS 选择器路径）：${args.selector}

用户修改指令：${args.instruction}`;
}


