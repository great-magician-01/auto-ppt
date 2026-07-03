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
import type { ToolDef } from "./chat";

export function splitOutlinePrompt(
  topic: string,
  manuscript: string,
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
    styleReturnClause = `\n- style：你在上面挑选的风格 id（字符串）。`;
  }

  return `你是一位专业的 PPT 设计师与信息架构师。下面是已经撰写好的完整文案，请据此为主题「${topic}」设计一份精美的 PPT：先确定统一的设计系统，再把文案拆分为各页大纲。${styleSection}

【完整文案（作为内容源，拆页时必须覆盖其要点）】
${manuscript}

【页数】由你根据文案内容的丰富程度自行判断决定：内容丰富的主题可多到 20 页以上，简单的主题可少至 6 页左右，以“每页都有实质信息、不空洞、不冗余”为原则。不要固定页数，也不要为了凑数而堆砌页或拆得过碎。

【设计要求】
1. design_tokens：专业协调的配色与字体方案，字段为 primary / accent / background / surface / text / textMuted / fonts / titleSize / bodySize（颜色用 #hex；titleSize 72–96px、bodySize 32–44px，必须保证投影可读，禁止偏小）。字体用系统通用字体族（如 "Microsoft YaHei"/"PingFang SC"/sans-serif 或 monospace），不要依赖需联网加载的字体。
2. theme_css：基于上述 tokens 的完整 CSS，包含 :root 中的 CSS 变量，以及通用类 .slide、.slide-title、.slide-body、.accent-bar 等。所有页面共享它。theme_css 必须遵守以下弹性铁律以防止内容溢出：
   - .slide 固定为 ${SLIDE_W}px × ${SLIDE_H}px（16:9），overflow:hidden，box-sizing:border-box，且必须 display:flex; flex-direction:column;
   - 必须包含 body,html { margin:0; padding:0; } 重置，消除默认 8px 边距导致的整体下移
   - :root 中的字号变量必须使用 clamp() 实现弹性，如 --titleSize: clamp(56px, 5vw, 96px); --bodySize: clamp(24px, 2vw, 40px); 确保内容多时自动缩小，但正文最小不低于 20px
   - 所有直接子内容容器（如 .content、.grid、.columns、.cards）必须允许弹性收缩：使用 min-height:0; flex-shrink:1; overflow:visible（不要加 overflow:hidden，否则截图时隐藏内容会丢失）
   - 文本容器必须设置合理的 max-height（如 calc(100% - 标题高度)）配合 overflow:visible，确保所有文本在截图时完整可见
3. slides：数组，第一页 kind=cover（封面），最后一页 kind=ending（致谢），中间用 cover/bullets/two-column/quote/section 等版式。每页含 title（标题）、kind（版式）、bullets（要点字符串数组）、notes（该页讲稿片段，从对应文案摘取，演讲用，1–3 句或对应要点）。中间内容页 bullets 至少 4 条，每条应是一个有信息量的完整要点（可含简短支撑说明、数据或案例），内容充实专业、紧扣主题展开；封面/致谢可短。

内容要专业、充实、紧扣主题，避免空洞。

【提交方式】
- 通过调用 commit_outline 工具提交 design_tokens / theme_css / slides / style，不要把 JSON 直接输出为回复正文。
- 可以先用一两句话说明设计思路，再调用 commit_outline。${styleReturnClause}
- 非自动模式（已指定风格）时 style 填空字符串。`;
}

export interface OutlineSlide {
  title: string;
  kind: string;
  bullets: string[];
  notes?: string;
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
1. html 参数为完整 HTML 文档：<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>…</style></head><body><div class="slide">…</div></body></html>。<style> 中先原样粘贴上面的 theme.css，再追加本页专属样式。
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
10. 通过调用 write_slide_html 工具提交完整 HTML（html 参数），不要把 HTML 直接输出为回复正文。先用一句话说明本页设计思路，再调用工具。`;
}

/** 清理单页 HTML（去掉可能的 ``` 包裹；流式中途未闭合的代码块也处理）。 */
export function cleanHtml(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  // 流式过程中代码块尚未闭合：去掉开头的 ```html
  return s.replace(/^```(?:html)?\s*/i, "");
}

/**
 * 自检提示词：仅修正溢出/排版/对齐问题，严禁改动主题样式。
 * 多模态（multimodal=true）对照渲染截图与 HTML；非多模态仅依据 HTML/CSS 推断（未附图）。
 * 改写结果通过 apply_selfcheck 工具提交。
 */
export function selfCheckPrompt(html: string, multimodal = true): string {
  const intro = multimodal
    ? `对照附图（当前页面渲染截图）与下方当前 HTML，检查是否存在内容溢出 ${SLIDE_W}×${SLIDE_H} 画布、元素错位、对齐混乱、字号过小看不清等“硬伤”。若有，仅做最小幅度修正；若无，原样提交该 HTML。`
    : `仔细审阅下方当前页 HTML，依据其 CSS 与结构推断是否存在内容溢出 ${SLIDE_W}×${SLIDE_H} 画布、元素错位、对齐混乱、字号过小看不清等“硬伤”（未附渲染截图，需从样式值判断）。若有，仅做最小幅度修正；若无，原样提交该 HTML。`;
  return `你是 PPT 视觉自检员。${intro}

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

【提交】调用 apply_selfcheck 工具提交完整 HTML 文档（html 参数）。若页面无明显硬伤，必须原样提交上面那段 HTML（一字不改）。`;
}


/** 文案阶段提示词：调研（若提供搜索工具）后调用 write_manuscript 提交完整 markdown 文案。 */
export function manuscriptPrompt(topic: string): string {
  return `你是一位专业的 PPT 文案策划与演讲撰稿人。请为主题「${topic}」撰写一份完整的 PPT 演讲文案。

【工作方式】
- 若提供了联网搜索工具，可先用 tavily_search 查证关键事实、数据、最新进展；对某个想看全文的网页再用 tavily_extract 提取。根据主题需要决定调用次数，不要只搜一次就停，也不要每次都调用。
- 引用工具查到的信息时，在文案中以 [来源: 标题] 标注；不确定或查不到的不要编造。
- 调研充分后，调用 write_manuscript 工具提交完整文案。

【文案要求】
- 按 8–20 页分章节，每章节有：章节标题 + 该页要讲的内容（要点/数据/案例/过渡语）。
- 内容专业、充实、紧扣主题、适合宣讲；语言自然流畅，可作为演讲稿。
- 用 markdown 的二级标题（##）分页，标题下写该页讲什么。

【回复方式】
- 可以先用一两句话说明撰写思路，然后调用 write_manuscript 提交完整文案。
- 文案必须通过 write_manuscript 的 content 参数提交，不要直接输出在回复正文里。`;
}

/** Tavily 工具定义（随 manuscript 调用注入）。 */
export const tavilyTools: ToolDef[] = [
  {
    name: "tavily_search",
    description:
      "用关键词联网搜索，返回一个 LLM 生成的摘要答案 + 多条结果（每条含 title/url/content）。需要查证事实、数据、最新信息时调用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    },
  },
  {
    name: "tavily_extract",
    description:
      "提取指定网页的完整内容（markdown 格式）。当某个搜索结果想看全文时调用。一次最多 3 个 URL。",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "要提取全文的 URL 列表，最多 3 个",
        },
      },
      required: ["urls"],
    },
  },
];

/** 调试模式选中元素修改：用户选中了一个元素，仅改该部分，调用 write_slide_html 提交整页 HTML。 */
export function chatWithElementPrompt(args: {
  html: string;
  elementHtml: string;
  selector: string;
  instruction: string;
}): string {
  return `这是当前页 HTML：
${args.html}

用户用调试模式选中了页面中一个元素，仅改动该元素对应的部分，其余结构保持不变。先用一两句说明改动，再调用 write_slide_html 提交修改后的完整 HTML 文档（<!DOCTYPE html>…</html>）。

选中元素 HTML：
${args.elementHtml}

定位（CSS 选择器路径）：${args.selector}

用户修改指令：${args.instruction}`;
}

// ---- 工具定义（strict 模式：additionalProperties:false + 全字段 required）----

export const manuscriptTool: ToolDef = {
  name: "write_manuscript",
  description:
    "提交撰写完成的完整 PPT 演讲文案（markdown）。文案撰写完毕后必须调用此工具提交，不要把文案直接输出为回复正文。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      content: { type: "string", description: "完整的 markdown 演讲文案，按 ## 二级标题分页" },
    },
    required: ["content"],
  },
};

export const outlineTool: ToolDef = {
  name: "commit_outline",
  description:
    "提交 PPT 设计系统与全部页面大纲。设计好配色/字体/版式并拆分完页面后必须调用此工具提交，不要把 JSON 直接输出为回复正文。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      design_tokens: {
        type: "object",
        additionalProperties: false,
        properties: {
          primary: { type: "string" },
          accent: { type: "string" },
          background: { type: "string" },
          surface: { type: "string" },
          text: { type: "string" },
          textMuted: { type: "string" },
          fonts: { type: "string" },
          titleSize: { type: "string" },
          bodySize: { type: "string" },
        },
        required: ["primary", "accent", "background", "surface", "text", "textMuted", "fonts", "titleSize", "bodySize"],
      },
      theme_css: { type: "string", description: "完整 CSS 字符串，含 :root 变量与 .slide 等通用类" },
      slides: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            kind: { type: "string" },
            bullets: { type: "array", items: { type: "string" } },
            notes: { type: "string", description: "该页讲稿片段，1-3 句" },
          },
          required: ["title", "kind", "bullets", "notes"],
        },
      },
      style: { type: "string", description: "选用的风格 id；非自动模式填空字符串" },
    },
    required: ["design_tokens", "theme_css", "slides", "style"],
  },
};

export const slideHtmlTool: ToolDef = {
  name: "write_slide_html",
  description:
    "提交单页幻灯片的完整 HTML 文档。先用一句话说明设计思路，再调用此工具提交完整 HTML。不要把 HTML 直接输出为回复正文。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      html: { type: "string", description: "完整的 HTML 文档 <!DOCTYPE html>…</html>" },
    },
    required: ["html"],
  },
};

export const selfCheckTool: ToolDef = {
  name: "apply_selfcheck",
  description:
    "提交自检改写后的完整 HTML 文档。若页面无明显硬伤，也必须原样调用此工具提交。不要把 HTML 直接输出为回复正文。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      html: { type: "string", description: "自检后的完整 HTML 文档" },
    },
    required: ["html"],
  },
};
