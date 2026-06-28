# AutoPPT 优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对 AutoPPT 做 8 项优化 + 大纲页对话能力：把生成编排与流式缓冲提升为全局 store、加风格库、大纲独立工作台、设置/项目/预览细节修复，使生成过程可见且切走再回来仍实时。

**Architecture:** 新增全局生成 store（`reactive` 单例，不引依赖）作为生成过程唯一真相源；大纲生成挪到独立路由 `/outline/:id` 工作台；风格库为内置常量表只传元数据给 AI；Editor 退化为视图；共享 `ChatPanel`。Rust 端不动 invoke_handler，仅加一个 DB migration（version 2）。

**Tech Stack:** Tauri 2、Vue 3 `<script setup>`、TypeScript（Vite）、vue-router、`@tauri-apps/plugin-sql`（SQLite）、Rust（reqwest + rustls）。

## Global Constraints

- UI 文案与所有 LLM 提示词保持**中文**。
- 画布尺寸不变：`SLIDE_W=1920 / SLIDE_H=1080`（`src/lib/prompt.ts`）。
- **JSON 模式仅大纲生成用**；HTML 与对话修改均不开 JSON 模式。
- **不引新前端依赖**（不加 Pinia 等）。
- Rust 端不新增 invoke 命令；仅新增 `migrations/002_add_style.sql`。
- **无测试框架**：CLAUDE.md 明确“no test script, no test dependencies”。本计划以 `npm run build`（`vue-tsc --noEmit` 类型检查 + `vite build`）作为编译门控，以 `npm run dev` / `npm run tauri dev` 手动验证作为行为门控。
- 提交粒度：每个 Task 结束提交一次（commit）。本仓库当前非 git 仓库——若执行时仍非 git 仓库，跳过 commit 步骤，记录“待 git init 后补提交”。

## 文件结构

**新增文件：**
- `src/lib/genStore.ts` — 全局生成 store（reactive 单例）+ 编排动作。职责：持有生成过程状态，驱动 outline/slide/chat 流，写库。
- `src/lib/styles.ts` — 内置风格库常量表（id/name/desc/palette/font/density）+ 选择器辅助。
- `src/pages/Outline.vue` — 大纲工作台页面（流式生成 + 对话修改）。
- `src/components/ChatPanel.vue` — 共享对话栏组件（消息列表 + 实时思考流 + 输入框）。
- `src-tauri/migrations/002_add_style.sql` — projects 加 `style` 列。

**修改文件：**
- `src/router.ts` — 加 `/outline/:id` 路由。
- `src/lib/prompt.ts` — `outlinePrompt` 加 `style` 参数与注入逻辑。
- `src/lib/db.ts` — `Project` 加 `style`；`getFirstSlide`；`createProject/updateProject` 支持 `style`。
- `src/lib/settings.ts` — `getModelsCache/saveModelsCache`。
- `src/lib/chat.ts` — 回调由调用方（store）传入，无大改（仅注释/类型收敛）。
- `src/pages/Editor.vue` — 视图化，用 `ChatPanel`，"生成大纲"改跳路由，读 store。
- `src/pages/ProjectList.vue` — 卡片首页缩略图；新建面板风格选择器 + 隐藏旧列表。
- `src/pages/Settings.vue` — API Key 显示/隐藏；模型回填。
- `src/components/SlidePreview.vue` — 双向 contain scale 修滚动条。
- `src/components/Icon.vue` — `eye`/`eye-off` 图标。
- `src-tauri/src/lib.rs` — 注册 migration version 2。

---

## Task 1: DB migration — projects 加 style 列

**Files:**
- Create: `src-tauri/migrations/002_add_style.sql`
- Modify: `src-tauri/src/lib.rs`（`run()` 的 migrations vec，约 176-181 行）
- Modify: `src/lib/db.ts`（`Project` 接口、`createProject`、`updateProject`）

**Interfaces:**
- Produces: `Project.style?: string | null`；`createProject(title, topic, style?)`；`updateProject` 的 `Partial<Pick<Project,'title'|'design_tokens'|'theme_css'|'style'>>`；migration version 2 由 Rust 在启动时应用。

- [ ] **Step 1: 创建 migration 文件**

`src-tauri/migrations/002_add_style.sql`：

```sql
-- 给项目加风格列：存风格 id 或 NULL(自动)
ALTER TABLE projects ADD COLUMN style TEXT;
```

- [ ] **Step 2: 注册 migration 到 Rust**

`src-tauri/src/lib.rs`，在 `run()` 内的 migrations vec 加 version 2（紧跟 version 1）：

```rust
    let migrations = vec![
        tauri_plugin_sql::Migration {
            version: 1,
            description: "init tables",
            sql: include_str!("../migrations/001_init.sql"),
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 2,
            description: "add style column to projects",
            sql: include_str!("../migrations/002_add_style.sql"),
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
    ];
```

- [ ] **Step 3: db.ts — Project 接口加 style**

`src/lib/db.ts`，`Project` 接口（约 12-20 行）加字段：

```ts
export interface Project {
  id?: number;
  title: string;
  topic: string;
  style?: string | null;
  design_tokens?: string | null;
  theme_css?: string | null;
  created_at?: string;
  updated_at?: string;
}
```

- [ ] **Step 4: db.ts — createProject 支持 style**

`src/lib/db.ts` `createProject`（约 55-62 行）：

```ts
export async function createProject(
  title: string,
  topic: string,
  style?: string | null
): Promise<number> {
  const d = await db();
  const r = await d.execute(
    "INSERT INTO projects(title, topic, style) VALUES(?, ?, ?)",
    [title, topic, style ?? null]
  );
  return Number(r.lastInsertId);
}
```

- [ ] **Step 5: db.ts — updateProject 支持 style**

`src/lib/db.ts` `updateProject`（约 64-78 行），把类型签名扩展：

```ts
export async function updateProject(
  id: number,
  fields: Partial<Pick<Project, "title" | "design_tokens" | "theme_css" | "style">>
) {
  const d = await db();
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  await d.execute(`UPDATE projects SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, vals);
}
```

- [ ] **Step 6: db.ts — getFirstSlide**

`src/lib/db.ts`，slides 区段末尾（约 108 行后）加：

```ts
export async function getFirstSlide(projectId: number): Promise<Slide | null> {
  const d = await db();
  const rows = await d.select<Slide[]>(
    "SELECT * FROM slides WHERE project_id = ? ORDER BY sort ASC LIMIT 1",
    [projectId]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 7: 类型检查**

Run: `npm run build`
Expected: PASS（vue-tsc 无新错误；现有逻辑未调用 createProject 第三参，不受影响）。

- [ ] **Step 8: 手动验证 migration 应用**

Run: `npm run tauri dev`（首次会编译 Rust）
验证：应用正常启动，控制台无 SQL 错误；用 DB 工具或运行时查询确认 `projects` 表存在 `style` 列（可后续在 Task 验证调用时附带确认）。

- [ ] **Step 9: Commit**

```bash
git add src-tauri/migrations/002_add_style.sql src-tauri/src/lib.rs src/lib/db.ts
git commit -m "feat(db): add style column to projects (migration v2)"
```

---

## Task 2: 风格库常量表

**Files:**
- Create: `src/lib/styles.ts`

**Interfaces:**
- Produces: `StylePreset` 接口；`STYLE_PRESETS: StylePreset[]`（约 12 条）；`getStyle(id): StylePreset | null`；`stylesForPrompt(style?): {mode:'explicit', preset:StylePreset} | {mode:'auto'}`。后续 Task 6（prompt 注入）与 Task 8（ProjectList 选择器）消费。

- [ ] **Step 1: 创建风格库文件**

`src/lib/styles.ts`：

```ts
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
  { id: "tech",         name: "科技风",     desc: "深色背景、霓虹蓝紫、几何线条、未来感",       palette: "深色+霓虹蓝紫",       font: "无衬线+等宽点缀",     density: "中等" },
  { id: "report",       name: "商务汇报",   desc: "稳重蓝灰、克制配色、强调数据与结论",         palette: "蓝灰+白底",           font: "无衬线",             density: "中高" },
  { id: "fresh",        name: "极简小清新", desc: "浅色留白、柔和莫兰迪、圆角",                 palette: "莫兰迪浅色",          font: "无衬线圆体",         density: "低" },
  { id: "magazine",     name: "杂志编辑",   desc: "大字标题、栅格排版、强对比、编辑感",         palette: "黑白+单一强调色",      font: "衬线标题+无衬线正文", density: "中等" },
  { id: "ink",          name: "中国风水墨", desc: "宣纸底、墨色、留白、毛笔题字感",             palette: "宣纸+墨黑+朱砂",       font: "楷体/宋体",          density: "低" },
  { id: "neon",         name: "暗夜霓虹",   desc: "纯黑底、荧光渐变、赛博朋克",                palette: "纯黑+荧光粉青",        font: "无衬线未来感",        density: "中等" },
  { id: "academic",     name: "学术严谨",   desc: "白底、衬线、严谨图表、低饱和",              palette: "白底+低饱和蓝",        font: "衬线",               density: "中高" },
  { id: "playful",      name: "卡通活泼",   desc: "明快糖果色、圆角、手绘元素",                palette: "糖果多彩",            font: "圆体",               density: "低" },
  { id: "retro",        name: "复古印刷",   desc: "做旧米黄、双色印刷、噪点",                   palette: "米黄+红黑双色",        font: "衬线老报纸",         density: "中等" },
  { id: "organic",      name: "自然有机",   desc: "大地色、有机曲线、柔和渐变",                 palette: "大地色+草木绿",        font: "无衬线圆体",         density: "低" },
  { id: "industrial",   name: "未来工业",   desc: "深灰金属、橙黄警示、硬朗几何",               palette: "深灰+警示橙",          font: "无衬线机械感",        density: "中等" },
  { id: "luxury",       name: "优雅奢华",   desc: "墨黑金、衬线、精致留白",                     palette: "墨黑+香槟金",          font: "衬线",               density: "低" },
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
```

- [ ] **Step 2: 类型检查**

Run: `npm run build`
Expected: PASS（纯新增文件，无副作用）。

- [ ] **Step 3: Commit**

```bash
git add src/lib/styles.ts
git commit -m "feat: add built-in style preset library"
```

---

## Task 3: 提示词加风格注入

**Files:**
- Modify: `src/lib/prompt.ts`（`outlinePrompt`，约 8-20 行）

**Interfaces:**
- Consumes: `stylesForPrompt`、`presetToPromptText`（Task 2）。
- Produces: `outlinePrompt(topic, slideCount, style?)` 返回带风格注入的字符串；自动模式下提示 AI 在返回 JSON 里加 `style` 字段。Task 4（store）消费。

- [ ] **Step 1: 修改 outlinePrompt 加 style 参数与注入**

`src/lib/prompt.ts`，替换 `outlinePrompt`：

```ts
import { stylesForPrompt, presetToPromptText, type StylePreset } from "./styles";

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
    const all = STYLE_PRESETS_LIST(styleMode);
    styleSection = `\n\n【风格选择】\n下方是候选风格，请挑选最契合主题的一个，并据此设计 design_tokens 与 theme_css：\n${all}`;
    styleReturnClause =
      '\n4. style：你在上面挑选的风格 id（字符串）。';
  }

  return `你是一位专业的 PPT 设计师与信息架构师。请为主题「${topic}」设计一份 ${slideCount} 页的 PPT，先确定统一的设计系统，再给出每页大纲。
${styleSection}

【输出要求】
1. design_tokens：专业协调的配色与字体方案，字段为 primary / accent / background / surface / text / textMuted / fonts / titleSize / bodySize（颜色用 #hex，字号用 px）。
2. theme_css：基于上述 tokens 的完整 CSS，包含 :root 中的 CSS 变量，以及通用类 .slide、.slide-title、.slide-body、.accent-bar 等。.slide 固定为 ${SLIDE_W}px × ${SLIDE_H}px（16:9），overflow:hidden。所有页面共享它。
3. slides：数组，第一页 kind=cover（封面），最后一页 kind=ending（致谢），中间用 cover/bullets/two-column/quote/section 等版式。每页含 title（标题）、kind（版式）、bullets（要点字符串数组，封面/致谢可短）。${styleReturnClause}

内容要专业、充实、紧扣主题。

【严格】只返回一个 JSON 对象，不要 markdown 代码块、不要解释文字。结构如下：
{"design_tokens":{...},"theme_css":"/* css string */","slides":[{"title":"","kind":"cover","bullets":[]}...],"style":"<风格id，仅自动模式需要>"}`;
}
```

- [ ] **Step 2: 加辅助函数列出全部预设文本**

在 `src/lib/prompt.ts` 顶部 import 区下方、`outlinePrompt` 之前加：

```ts
import { STYLE_PRESETS } from "./styles";

function STYLE_PRESETS_LIST(_mode: { mode: "auto" }): string {
  return STYLE_PRESETS.map(presetToPromptText).join("\n");
}
```

（参数名 `_mode` 仅作占位以保持调用形式；实际未使用其内容，故前缀下划线避免 unused 警告。）

- [ ] **Step 3: 修正 import（合并去重）**

把 Step 1 与 Step 2 的 import 合并为一条（避免重复 import 同模块）：

```ts
import {
  stylesForPrompt,
  presetToPromptText,
  STYLE_PRESETS,
} from "./styles";
```

并删除 Step 2 中重复的 `import { STYLE_PRESETS } from "./styles";`。

- [ ] **Step 4: 类型检查**

Run: `npm run build`
Expected: PASS。注意：`StylePreset` 若未用到可不 import；若 vue-tsc 报 unused，删除未用的 import 名。

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompt.ts
git commit -m "feat(prompt): inject style metadata into outline prompt"
```

---

## Task 4: 全局生成 store

**Files:**
- Create: `src/lib/genStore.ts`

**Interfaces:**
- Consumes: `chat`、`chatOnce`（`src/lib/chat.ts`）；`outlinePrompt`、`slideHtmlPrompt`、`parseOutline`、`cleanHtml`、`type OutlineSlide`（`src/lib/prompt.ts`）；`getProject`、`updateProject`、`listSlides`、`upsertSlide`、`addMessage`、`type Project`、`type Slide`、`type Message`、`type ChatRole`（`src/lib/db.ts`）；`chat` 的 `ChatMsg`（`src/lib/chat.ts`）。
- Produces: `genState`（reactive 单例对象，字段见 Step）；动作 `startOutline`、`sendOutlineChat`、`startSlide`、`startAll`、`sendChat`、`reset`。Task 5（Outline.vue）、Task 6（Editor.vue）消费。

- [ ] **Step 1: 创建 store 文件（状态 + 复用逻辑）**

`src/lib/genStore.ts`：

```ts
import { reactive } from "vue";
import { chat, chatOnce, type ChatMsg } from "./chat";
import {
  outlinePrompt,
  slideHtmlPrompt,
  parseOutline,
  cleanHtml,
  type OutlineSlide,
} from "./prompt";
import {
  getProject,
  updateProject,
  listSlides,
  upsertSlide,
  addMessage,
  type Project,
  type Slide,
  type ChatRole,
} from "./db";

export type GenPhase =
  | "idle"
  | "outline"
  | "outline-chat"
  | "slide"
  | "chat";

export const genState = reactive({
  running: false,
  phase: GenPhaseIdle() as GenPhase,
  projectId: null as number | null,
  slideIdx: 0,
  reasoning: "",
  content: "",
  status: "",
  error: null as string | null,
});

function GenPhaseIdle(): GenPhase {
  return "idle";
}

function resetBuffers() {
  genState.reasoning = "";
  genState.content = "";
  genState.error = null;
}
```

- [ ] **Step 2: 加 startOutline 动作（JSON 模式 + 重试 + 写库）**

在 `src/lib/genStore.ts` 续：

```ts
export async function startOutline(
  projectId: number,
  topic: string,
  style?: string | null
): Promise<void> {
  genState.projectId = projectId;
  genState.running = true;
  genState.phase = "outline";
  resetBuffers();
  let parsed: ReturnType<typeof parseOutline> | null = null;
  let lastErr: any = null;
  try {
    const msgs: ChatMsg[] = [
      { role: "system", content: "你是专业 PPT 设计师，严格按要求返回 JSON。" },
      { role: "user", content: outlinePrompt(topic, 8, style) },
    ];
    for (let attempt = 1; attempt <= 2; attempt++) {
      genState.status = `生成大纲与设计系统（第 ${attempt} 次）…`;
      const raw = await chatOnce(
        msgs,
        (d) => {
          genState.reasoning += d;
          genState.status = `思考中… 已收到 ${genState.reasoning.length} 字思考`;
        },
        true // jsonMode
      );
      genState.content = raw;
      try {
        parsed = parseOutline(raw);
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < 2) genState.status = `解析失败，重试中…（${msg}）`;
      }
    }
    if (!parsed) throw new Error("大纲解析失败：" + (lastErr?.message ?? "未知错误"));

    const tokensJson = JSON.stringify(parsed.design_tokens, null, 2);
    // 自动模式下，若模型回填了 style，写回 project.style
    const resolvedStyle = (parsed as any).style ?? style ?? null;
    await updateProject(projectId, {
      design_tokens: tokensJson,
      theme_css: parsed.theme_css,
      style: resolvedStyle,
    });

    // 覆盖写 slides：先删旧再插新
    for (const s of await listSlides(projectId)) {
      if (s.id) await deleteSlideById(s.id);
    }
    const newSlides: Slide[] = [];
    for (let i = 0; i < parsed.slides.length; i++) {
      const s: OutlineSlide = parsed.slides[i];
      const id = await upsertSlide({
        project_id: projectId,
        sort: i,
        title: s.title,
        outline: JSON.stringify(s),
        html_content: null,
      });
      newSlides.push({
        id,
        project_id: projectId,
        sort: i,
        title: s.title,
        outline: JSON.stringify(s),
        html_content: null,
      });
    }
    await addMessage(projectId, "assistant", `已生成大纲（${parsed.slides.length} 页）与设计系统。`);
    genState.status = "大纲已生成，可进入编辑器逐页生成 HTML";
  } catch (e: any) {
    genState.error = e.message;
    genState.status = "错误：" + e.message;
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}
```

- [ ] **Step 3: 加 deleteSlideById 复用（store 内部删页）**

在 `src/lib/db.ts` 已有 `deleteSlide(id)`，store 直接 import 它而非新写。修正 Step 2：把 `deleteSlideById(s.id)` 改为 `deleteSlide(s.id)`，并在 import 加 `deleteSlide`。

`src/lib/genStore.ts` import 块补充：

```ts
import {
  getProject,
  updateProject,
  listSlides,
  upsertSlide,
  addMessage,
  deleteSlide,
  type Project,
  type Slide,
  type ChatRole,
} from "./db";
```

并把 Step 2 中 `for (const s of await listSlides(projectId)) { if (s.id) await deleteSlideById(s.id); }` 改为：

```ts
    for (const s of await listSlides(projectId)) {
      if (s.id) await deleteSlide(s.id);
    }
```

- [ ] **Step 4: 加 sendOutlineChat 动作（对话修改大纲）**

`src/lib/genStore.ts` 续：

```ts
export async function sendOutlineChat(
  projectId: number,
  topic: string,
  style: string | null,
  currentSlides: OutlineSlide[],
  instruction: string
): Promise<void> {
  genState.projectId = projectId;
  genState.running = true;
  genState.phase = "outline-chat";
  resetBuffers();
  try {
    const msgs: ChatMsg[] = [
      {
        role: "system",
        content:
          "你是专业 PPT 设计师。根据用户指令修改给定的大纲 JSON，只返回修改后的完整 JSON 对象（结构同生成阶段：design_tokens/theme_css/slides[/style]），不要 markdown 代码块、不要任何解释文字。",
      },
      {
        role: "user",
        content:
          `主题：${topic}\n\n当前大纲 JSON：\n${JSON.stringify(
            { slides: currentSlides },
            null,
            2
          )}\n\n用户修改指令：${instruction}`,
      },
    ];
    await chat(
      msgs,
      (d) => {
        genState.content += d;
        genState.status = `修改大纲中… 已收到 ${genState.content.length} 字`;
      },
      (d) => {
        genState.reasoning += d;
        genState.status = `思考中… 已收到 ${genState.reasoning.length} 字思考`;
      }
      // 非 jsonMode：HTML/对话不开 JSON 模式
    );
    const parsed = parseOutline(genState.content);
    const tokensJson = JSON.stringify(parsed.design_tokens, null, 2);
    const resolvedStyle = (parsed as any).style ?? style ?? null;
    await updateProject(projectId, {
      design_tokens: tokensJson,
      theme_css: parsed.theme_css,
      style: resolvedStyle,
    });
    for (const s of await listSlides(projectId)) {
      if (s.id) await deleteSlide(s.id);
    }
    for (let i = 0; i < parsed.slides.length; i++) {
      const s: OutlineSlide = parsed.slides[i];
      await upsertSlide({
        project_id: projectId,
        sort: i,
        title: s.title,
        outline: JSON.stringify(s),
        html_content: null,
      });
    }
    await addMessage(projectId, "assistant", `已按指令更新大纲（${parsed.slides.length} 页）。`);
    genState.status = "大纲已更新";
  } catch (e: any) {
    genState.error = e.message;
    genState.status = "错误：" + e.message;
    // 解析失败时保留原大纲不覆盖写库（update 仅在 parse 成功后执行，已满足）
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}
```

- [ ] **Step 5: 加 startSlide 动作（单页 HTML）**

`src/lib/genStore.ts` 续：

```ts
export async function startSlide(
  projectId: number,
  slides: Slide[],
  idx: number
): Promise<void> {
  const proj = await getProject(projectId);
  const slide = slides[idx];
  if (!proj || !slide?.outline) return;
  const outlineSlide: OutlineSlide = JSON.parse(slide.outline);
  genState.projectId = projectId;
  genState.slideIdx = idx;
  genState.running = true;
  genState.phase = "slide";
  resetBuffers();
  try {
    const msgs: ChatMsg[] = [
      { role: "system", content: "你是专业前端工程师，只输出 HTML，不要任何解释。" },
      {
        role: "user",
        content: slideHtmlPrompt({
          topic: proj.topic,
          designTokens: proj.design_tokens ?? "",
          themeCss: proj.theme_css ?? "",
          slide: outlineSlide,
          index: idx + 1,
          total: slides.length,
        }),
      },
    ];
    await chat(
      msgs,
      (d) => {
        genState.content += d;
        genState.status = `第 ${idx + 1} 页生成中… 已收到 ${genState.content.length} 字`;
      },
      (d) => {
        genState.reasoning += d;
        genState.status = `第 ${idx + 1} 页思考中… 已收到 ${genState.reasoning.length} 字思考`;
      }
    );
    slide.html_content = cleanHtml(genState.content);
    await upsertSlide(slide);
    const kind = outlineSlide.kind;
    const bulletsLen = outlineSlide.bullets?.length ?? 0;
    await addMessage(
      projectId,
      "assistant",
      `第 ${idx + 1} 页已生成 · 版式 ${kind} · ${bulletsLen} 个要点 · ${outlineSlide.title}`
    );
    genState.status = `第 ${idx + 1} 页已生成`;
  } catch (e: any) {
    genState.error = e.message;
    genState.status = "错误：" + e.message;
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}
```

- [ ] **Step 6: 加 startAll 动作（循环 + 自动翻页）**

`src/lib/genStore.ts` 续：

```ts
export async function startAll(
  projectId: number,
  slides: Slide[]
): Promise<void> {
  for (let i = 0; i < slides.length; i++) {
    if (slides[i].html_content) continue;
    await startSlide(projectId, slides, i);
    if (genState.error) break;
    genState.slideIdx = Math.min(i + 1, slides.length - 1);
  }
  if (!genState.error) genState.status = "全部页面已生成";
}
```

- [ ] **Step 7: 加 sendChat 动作（对话修改单页）**

`src/lib/genStore.ts` 续：

```ts
export async function sendChat(
  projectId: number,
  slides: Slide[],
  idx: number,
  instruction: string
): Promise<void> {
  const cur = slides[idx];
  if (!cur?.html_content) return;
  await addMessage(projectId, "user", instruction);
  genState.projectId = projectId;
  genState.slideIdx = idx;
  genState.running = true;
  genState.phase = "chat";
  resetBuffers();
  try {
    const msgs: ChatMsg[] = [
      {
        role: "system",
        content:
          "你是专业前端。根据用户指令修改给定的幻灯片 HTML，只输出修改后的完整 HTML 文档，不要任何解释文字。",
      },
      {
        role: "user",
        content: `这是当前页 HTML：\n${cur.html_content}\n\n用户修改指令：${instruction}`,
      },
    ];
    await chat(
      msgs,
      (d) => {
        genState.content += d;
        // 实时流入预览（写回当前 slide 的 html_content）
        cur.html_content = cleanHtml(genState.content);
        genState.status = `修改中… 已收到 ${genState.content.length} 字`;
      },
      (d) => {
        genState.reasoning += d;
        genState.status = `思考中… 已收到 ${genState.reasoning.length} 字思考`;
      }
    );
    cur.html_content = cleanHtml(genState.content);
    await upsertSlide(cur);
    await addMessage(projectId, "assistant", "已按指令更新当前页");
    genState.status = "已更新";
  } catch (e: any) {
    genState.error = e.message;
    genState.status = "错误：" + e.message;
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}
```

- [ ] **Step 8: 加 reset 动作**

`src/lib/genStore.ts` 末尾：

```ts
export function reset() {
  genState.running = false;
  genState.phase = "idle";
  genState.projectId = null;
  genState.slideIdx = 0;
  resetBuffers();
  genState.status = "";
}
```

- [ ] **Step 9: 清理未用 import**

检查 import：`getProject`、`updateProject`、`listSlides`、`upsertSlide`、`addMessage`、`deleteSlide` 全部已用；`Project`、`Slide`、`ChatRole` 用于类型，`ChatRole` 实际未被显式引用——若 vue-tsc 报 unused，从 import 删除 `type ChatRole`。`Project` 用于 `getProject` 返回类型推断，保留。

- [ ] **Step 10: 类型检查**

Run: `npm run build`
Expected: PASS。若 `GenPhaseIdle()` 这种函数式默认值导致类型推断问题，改为：`phase: "idle" as GenPhase,`（字面量断言），删除 `GenPhaseIdle` 函数。

修正（采用字面量断言，避免多余函数）——把 Step 1 的 `genState` 改为：

```ts
export const genState = reactive({
  running: false,
  phase: "idle" as GenPhase,
  projectId: null as number | null,
  slideIdx: 0,
  reasoning: "",
  content: "",
  status: "",
  error: null as string | null,
});
```

并删除 `GenPhaseIdle` 函数定义。

- [ ] **Step 11: Commit**

```bash
git add src/lib/genStore.ts src/lib/db.ts
git commit -m "feat: global generation store with outline/slide/chat orchestration"
```

---

## Task 5: 共享 ChatPanel 组件

**Files:**
- Create: `src/components/ChatPanel.vue`

**Interfaces:**
- Consumes: `type Message`（`src/lib/db.ts`）。
- Produces: `<ChatPanel :messages :running :reasoning :disabled :placeholder @send>`。Task 6（Outline.vue）、Task 7（Editor.vue）消费。

- [ ] **Step 1: 创建 ChatPanel.vue**

`src/components/ChatPanel.vue`：

```vue
<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import type { Message } from "../lib/db";

const props = defineProps<{
  messages: Message[];
  running: boolean;
  reasoning?: string;
  disabled?: boolean;
  placeholder?: string;
}>();
const emit = defineEmits<{ send: [text: string] }>();

const input = ref("");
const listEl = ref<HTMLElement | null>(null);

async function scrollBottom() {
  await nextTick();
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
}
watch(() => [props.messages.length, props.reasoning], scrollBottom);

function onSend() {
  const text = input.value.trim();
  if (!text || props.running || props.disabled) return;
  emit("send", text);
  input.value = "";
}
</script>

<template>
  <aside class="chat-panel">
    <div class="chat-list" ref="listEl">
      <div v-for="m in messages" :key="m.id ?? m.content" class="msg" :class="m.role">
        <span class="role">{{ m.role }}</span>
        <div>{{ m.content }}</div>
      </div>
      <div v-if="running && reasoning" class="msg thinking">
        <span class="role">思考中</span>
        <pre class="reasoning">{{ reasoning }}</pre>
      </div>
      <div v-if="!messages.length && !running" class="muted">
        {{ placeholder ?? "输入修改指令…" }}
      </div>
    </div>
    <div class="chat-input">
      <textarea
        v-model="input"
        rows="3"
        :placeholder="placeholder ?? '修改指令…（Ctrl/⌘+Enter 发送）'"
        :disabled="running || disabled"
        @keydown.enter.ctrl="onSend"
        @keydown.enter.meta="onSend"
      ></textarea>
      <button class="primary" :disabled="running || disabled || !input.trim()" @click="onSend">
        发送
      </button>
    </div>
  </aside>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-left: 1px solid var(--border);
}
.chat-list {
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.msg {
  font-size: 13px;
}
.msg .role {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  display: block;
  margin-bottom: 2px;
}
.msg.assistant .role {
  color: var(--primary);
}
.msg.thinking .role {
  color: var(--primary);
}
.reasoning {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  font-family: inherit;
  font-size: 12px;
  color: var(--muted);
  max-height: 240px;
  overflow: auto;
}
.chat-input {
  border-top: 1px solid var(--border);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
```

- [ ] **Step 2: 类型检查**

Run: `npm run build`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatPanel.vue
git commit -m "feat: shared ChatPanel component"
```

---

## Task 6: 大纲工作台页 Outline.vue + 路由

**Files:**
- Create: `src/pages/Outline.vue`
- Modify: `src/router.ts`（加路由）

**Interfaces:**
- Consumes: `genState`、`startOutline`、`sendOutlineChat`、`reset`（Task 4）；`ChatPanel`（Task 5）；`getProject`、`listSlides`、`listMessages`、`type OutlineSlide`（parseOutline 用于把已存大纲转结构化展示）；`parseOutline`（`prompt.ts`）。
- Produces: `/outline/:id` 路由页面。Task 8（ProjectList）跳转目标。

- [ ] **Step 1: router.ts 加路由**

`src/router.ts`，routes 数组在 settings 后加：

```ts
  {
    path: "/outline/:id",
    name: "outline",
    component: () => import("./pages/Outline.vue"),
    props: true,
  },
```

- [ ] **Step 2: 创建 Outline.vue**

`src/pages/Outline.vue`：

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import ChatPanel from "../components/ChatPanel.vue";
import { genState, startOutline, sendOutlineChat } from "../lib/genStore";
import {
  getProject,
  listSlides,
  listMessages,
  type Project,
  type Slide,
  type Message,
} from "../lib/db";
import { parseOutline, type OutlineSlide } from "../lib/prompt";

const props = defineProps<{ id: string }>();
const router = useRouter();
const projectId = Number(props.id);

const project = ref<Project | null>(null);
const slides = ref<Slide[]>([]);
const messages = ref<Message[]>([]);

const isRunning = computed(
  () => genState.running && genState.projectId === projectId
);
// 当前大纲结构化展示（来自库 或 实时 content 已可解析时）
const outlineView = computed<OutlineSlide[]>(() => {
  if (isRunning.value && genState.content) {
    try {
      return parseOutline(genState.content).slides;
    } catch {
      return [];
    }
  }
  return slides.value.map((s) =>
    s.outline ? (JSON.parse(s.outline) as OutlineSlide) : null
  ).filter(Boolean) as OutlineSlide[];
});

onMounted(load);

async function load() {
  project.value = await getProject(projectId);
  slides.value = await listSlides(projectId);
  messages.value = await listMessages(projectId);
  // 若没有大纲且未在生成中，自动开始
  if (!slides.value.length && !(genState.running && genState.projectId === projectId)) {
    if (project.value) {
      startOutline(projectId, project.value.topic, project.value.style ?? null);
    }
  }
}

async function onSend(text: string) {
  if (!project.value) return;
  const currentSlides: OutlineSlide[] = slides.value
    .map((s) => (s.outline ? (JSON.parse(s.outline) as OutlineSlide) : null))
    .filter(Boolean) as OutlineSlide[];
  await sendOutlineChat(
    projectId,
    project.value.topic,
    project.value.style ?? null,
    currentSlides,
    text
  );
  // 完成后重载
  slides.value = await listSlides(projectId);
  messages.value = await listMessages(projectId);
}

function goEditor() {
  router.push(`/editor/${projectId}`);
}
</script>

<template>
  <div class="outline-page" v-if="project">
    <div class="o-header">
      <div>
        <h3>大纲工作台 · {{ project.title }}</h3>
        <span class="muted">主题：{{ project.topic }}</span>
      </div>
      <div class="row">
        <span class="muted">{{ genState.status }}</span>
        <button class="primary" :disabled="!slides.length" @click="goEditor">
          进入编辑器 →
        </button>
      </div>
    </div>
    <div class="o-body">
      <section class="o-main">
        <div v-if="isRunning && !outlineView.length" class="stream">
          <div v-if="genState.reasoning" class="block">
            <span class="label">思考</span>
            <pre>{{ genState.reasoning }}</pre>
          </div>
          <div class="block">
            <span class="label">正文（JSON 流式）</span>
            <pre>{{ genState.content }}</pre>
          </div>
        </div>
        <div v-else class="outline-cards">
          <div v-for="(s, i) in outlineView" :key="i" class="ocard">
            <div class="row">
              <span class="num">{{ i + 1 }}</span>
              <span class="kind">{{ s.kind }}</span>
            </div>
            <div class="otitle">{{ s.title }}</div>
            <ul v-if="s.bullets?.length">
              <li v-for="(b, j) in s.bullets" :key="j">{{ b }}</li>
            </ul>
          </div>
          <div v-if="!outlineView.length" class="muted">等待生成…</div>
        </div>
      </section>
      <ChatPanel
        :messages="messages"
        :running="isRunning"
        :reasoning="isRunning ? genState.reasoning : ''"
        :disabled="!slides.length && !isRunning"
        placeholder="修改大纲，如：把第3页拆成两页 / 加一页讲应用场景…"
        @send="onSend"
      />
    </div>
  </div>
</template>

<style scoped>
.outline-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.o-header {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.o-body {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 360px;
  overflow: hidden;
}
.o-main {
  padding: 20px;
  overflow: auto;
}
.stream .block {
  margin-bottom: 16px;
}
.stream .label {
  font-size: 12px;
  color: var(--muted);
  display: block;
  margin-bottom: 4px;
}
.stream pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  background: #f7f8fa;
  padding: 10px;
  border-radius: 6px;
  margin: 0;
  max-height: 360px;
  overflow: auto;
}
.outline-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ocard {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: var(--panel);
}
.ocard .num {
  font-weight: 700;
  color: var(--muted);
}
.ocard .kind {
  font-size: 11px;
  background: #eef;
  color: var(--primary);
  padding: 1px 6px;
  border-radius: 4px;
}
.ocard .otitle {
  font-weight: 600;
  margin: 6px 0;
}
.ocard ul {
  margin: 0;
  padding-left: 20px;
}
.ocard li {
  font-size: 13px;
}
</style>
```

- [ ] **Step 3: 类型检查**

Run: `npm run build`
Expected: PASS。注意 `parseOutline` 在 computed 中对未完成流式 content 调用会抛错，已用 try/catch 包裹。

- [ ] **Step 4: 手动验证**

Run: `npm run dev`（或 `npm run tauri dev`）
验证：从项目页新建项目 → 应跳到 `/outline/:id` → 自动开始生成 → 主区流式显示思考+JSON 正文 → 完成后显示结构化大纲卡片 → 底部"进入编辑器"按钮可点。对话栏输入修改指令 → 思考流实时显示 → 大纲更新。

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/pages/Outline.vue
git commit -m "feat: outline workspace page with streaming + chat edits"
```

---

## Task 7: Editor 视图化（用 store + ChatPanel）

**Files:**
- Modify: `src/pages/Editor.vue`（整体重写 script + template 局部）

**Interfaces:**
- Consumes: `genState`、`startSlide`、`startAll`、`sendChat`（Task 4）；`ChatPanel`（Task 5）；`SlidePreview`；db helpers。
- Produces: Editor 读取 store 实时缓冲；"生成大纲"按钮跳 `/outline/:id`；生成全部时跟随 `genState.slideIdx`。

- [ ] **Step 1: 重写 Editor script**

替换 `src/pages/Editor.vue` 的 `<script setup>` 块（1-237 行）：

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import SlidePreview from "../components/SlidePreview.vue";
import ChatPanel from "../components/ChatPanel.vue";
import {
  getProject,
  listSlides,
  listMessages,
  type Project,
  type Slide,
  type Message,
} from "../lib/db";
import { genState, startSlide, startAll, sendChat } from "../lib/genStore";
import { exportPptx } from "../lib/ppt";

const props = defineProps<{ id: string }>();
const router = useRouter();
const projectId = Number(props.id);

const project = ref<Project | null>(null);
const slides = ref<Slide[]>([]);
const messages = ref<Message[]>([]);
const currentIdx = ref(0);
const busy = computed(() => genState.running);
const status = computed(() => genState.status);

const current = computed(() => slides.value[currentIdx.value] ?? null);

// 生成中切走再回来：跟随 store 的 slideIdx
onMounted(load);

async function load() {
  project.value = await getProject(projectId);
  slides.value = await listSlides(projectId);
  messages.value = await listMessages(projectId);
  currentIdx.value = 0;
}

// 若 store 正在为当前项目跑 slide/chat，跟随其 slideIdx
function syncIdxFromStore() {
  if (
    genState.running &&
    genState.projectId === projectId &&
    (genState.phase === "slide" || genState.phase === "chat")
  ) {
    currentIdx.value = Math.min(genState.slideIdx, slides.value.length - 1);
  }
}

// 当前页 HTML：生成中读 store 实时缓冲，否则读库
const currentHtml = computed(() => {
  const cur = current.value;
  if (!cur) return "";
  if (
    genState.running &&
    genState.projectId === projectId &&
    genState.slideIdx === currentIdx.value &&
    genState.phase === "chat"
  ) {
    return cur.html_content ?? "";
  }
  return cur.html_content ?? "";
});

function goOutline() {
  router.push(`/outline/${projectId}`);
}

async function genOne(idx: number) {
  await startSlide(projectId, slides.value, idx);
  messages.value = await listMessages(projectId);
}

async function genAll() {
  await startAll(projectId, slides.value);
  messages.value = await listMessages(projectId);
  slides.value = await listSlides(projectId);
}

async function onChat(text: string) {
  // 立即回显用户消息（不等流结束），与原 Editor 行为一致
  messages.value.push({
    project_id: projectId,
    role: "user",
    content: text,
  });
  await sendChat(projectId, slides.value, currentIdx.value, text);
  messages.value = await listMessages(projectId);
  slides.value = await listSlides(projectId);
}

async function doExport() {
  status.value; // 触发依赖（status 是 computed，引用即订阅）
  await exportPptx(slides.value, projectId);
}
</script>
```

- [ ] **Step 2: 重写 Editor template**

替换 `src/pages/Editor.vue` 的 `<template>`（239-318 行）：

```vue
<template>
  <div class="editor" v-if="project">
    <div class="e-header">
      <div class="col">
        <div class="row">
          <h3>{{ project.title }}</h3>
          <span class="muted">{{ status }}</span>
        </div>
        <span class="muted">主题：{{ project.topic }}</span>
      </div>
      <div class="row">
        <button v-if="!slides.length" class="primary" :disabled="busy" @click="goOutline">
          生成大纲
        </button>
        <template v-else>
          <button :disabled="busy" @click="genAll">生成全部 HTML</button>
          <button class="primary" :disabled="busy" @click="doExport">导出 PPT</button>
        </template>
      </div>
    </div>

    <div class="e-body">
      <aside class="e-list">
        <div
          v-for="(s, i) in slides"
          :key="s.id"
          class="item"
          :class="{ active: i === currentIdx }"
          @click="currentIdx = i"
        >
          <span class="num">{{ i + 1 }}</span>
          <div class="col">
            <span class="t">{{ s.title || "(未命名)" }}</span>
            <span class="muted">{{ s.html_content ? "已生成" : "待生成" }}</span>
          </div>
          <button
            v-if="!s.html_content"
            class="mini"
            :disabled="busy"
            @click.stop="genOne(i)"
          >
            生成
          </button>
        </div>
      </aside>

      <section class="e-preview">
        <SlidePreview v-if="current" :html="currentHtml" />
        <div v-else class="empty muted">生成大纲后这里显示预览</div>
      </section>

      <ChatPanel
        :messages="messages"
        :running="busy && genState.projectId === projectId"
        :reasoning="busy && genState.projectId === projectId ? genState.reasoning : ''"
        :disabled="!current?.html_content"
        placeholder="对当前页的修改指令…（Ctrl/⌘+Enter 发送）"
        @send="onChat"
      />
    </div>
  </div>
</template>
```

- [ ] **Step 3: 保留并微调 Editor style**

`src/pages/Editor.vue` 的 `<style scoped>` 中删除原 `.e-chat`、`.chat-list`、`.msg`、`.msg .role`、`.msg.assistant .role`、`.chat-input` 这些已移到 ChatPanel 的样式块（约 383-415 行），保留 `.editor`/`.e-header`/`.e-body`/`.e-list`/`.item`/`.num`/`.mini`/`.e-preview`/`.empty`。`.e-body` 的 `grid-template-columns` 改为 `220px 1fr 360px`（匹配 ChatPanel 默认宽度）。

- [ ] **Step 4: 处理 doExport 的 status 引用**

Step 1 中 `doExport` 写了 `status.value;` 是为保持 status 在导出时可见，但导出本身不应依赖 status。改为在 doExport 内直接设置一个本地状态：由于 status 是 computed 只读、依赖 genState.status，导出期间 genState 未变化。改为：

```ts
async function doExport() {
  await exportPptx(slides.value, projectId);
}
```

并删除 `status.value;` 那行。导出进度可后续优化（本次不阻塞）。

- [ ] **Step 5: 类型检查**

Run: `npm run build`
Expected: PASS。`syncIdxFromStore` 若未被调用会报 unused——它在 template 外定义但未使用。删除 `syncIdxFromStore` 函数（功能由 `current` 的 computed 与手动点击 `currentIdx` 覆盖；生成全部时改用 watch）。

改为在 script 加 watch 同步 slideIdx：

```ts
import { ref, computed, onMounted, watch } from "vue";
```

并在 `load()` 后加：

```ts
watch(
  () => genState.slideIdx,
  (idx) => {
    if (
      genState.running &&
      genState.projectId === projectId &&
      (genState.phase === "slide" || genState.phase === "chat")
    ) {
      currentIdx.value = Math.min(idx, Math.max(0, slides.value.length - 1));
    }
  }
);
```

删除 `syncIdxFromStore` 函数定义。

- [ ] **Step 6: 手动验证**

Run: `npm run tauri dev`
验证：
- 无大纲项目进 Editor → "生成大纲"按钮跳 `/outline/:id`。
- 已有大纲项目 → 可逐页生成、生成全部（预览自动翻页、对话栏出现完成简述）。
- 生成全部中切到设置页再回 Editor → 仍在正确页、预览/对话栏显示实时内容。
- 对话修改单页 → 预览实时流、对话栏显示思考流、完成追加消息。

- [ ] **Step 7: Commit**

```bash
git add src/pages/Editor.vue
git commit -m "refactor(editor): view-only, driven by global gen store + ChatPanel"
```

---

## Task 8: ProjectList — 卡片首页缩略图 + 风格选择器 + 隐藏旧列表

**Files:**
- Modify: `src/pages/ProjectList.vue`（script + template + style）

**Interfaces:**
- Consumes: `createProject`（带 style）、`listProjects`、`getFirstSlide`（Task 1）；`STYLE_PRESETS`、`getStyle`（Task 2）；`SlidePreview`（缩略）。
- Produces: 新建项目带风格 → 跳 `/outline/:id`；卡片显示首页缩略图；新建展开时隐藏旧列表。

- [ ] **Step 1: 重写 ProjectList script**

替换 `src/pages/ProjectList.vue` 的 `<script setup>`（1-30 行）：

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { listProjects, createProject, getFirstSlide } from "../lib/db";
import { STYLE_PRESETS } from "../lib/styles";
import type { Project, Slide } from "../lib/db";
import Icon from "../components/Icon.vue";
import SlidePreview from "../components/SlidePreview.vue";

const router = useRouter();
const projects = ref<Project[]>([]);
const thumbs = ref<Record<number, string>>({});
const showNew = ref(false);
const title = ref("");
const topic = ref("");
const selectedStyle = ref<string | null>(null);

onMounted(load);

async function load() {
  projects.value = await listProjects();
  thumbs.value = {};
  await Promise.all(
    projects.value.map(async (p) => {
      const first = await getFirstSlide(p.id!);
      if (first?.html_content) thumbs.value[p.id!] = first.html_content;
    })
  );
}

async function create() {
  if (!topic.value.trim()) return;
  const t = title.value.trim() || topic.value.slice(0, 20);
  const id = await createProject(t, topic.value.trim(), selectedStyle.value);
  router.push(`/outline/${id}`);
}

function open(p: Project) {
  router.push(`/editor/${p.id}`);
}
</script>
```

- [ ] **Step 2: 重写 ProjectList template**

替换 `src/pages/ProjectList.vue` 的 `<template>`（32-70 行）：

```vue
<template>
  <div class="page">
    <div class="row" style="justify-content: space-between">
      <h2>项目</h2>
      <button class="primary" @click="showNew = !showNew">
        <Icon name="plus" :size="14" />
        {{ showNew ? "取消" : "新建项目" }}
      </button>
    </div>

    <div v-if="showNew" class="panel new">
      <div class="col">
        <label>
          主题（必填）
          <textarea
            v-model="topic"
            rows="3"
            placeholder="例如：介绍 Rust 编程语言的核心特性"
          ></textarea>
        </label>
        <label>
          标题（可选）
          <input v-model="title" placeholder="留空则取主题前 20 字" />
        </label>
        <div class="field">
          <span class="label">风格</span>
          <div class="style-chips">
            <button
              class="chip"
              :class="{ active: selectedStyle === null }"
              @click="selectedStyle = null"
            >
              自动（AI 选）
            </button>
            <button
              v-for="s in STYLE_PRESETS"
              :key="s.id"
              class="chip"
              :class="{ active: selectedStyle === s.id }"
              :title="s.desc"
              @click="selectedStyle = s.id"
            >
              {{ s.name }}
            </button>
          </div>
        </div>
        <button class="primary" :disabled="!topic.trim()" @click="create">
          创建并生成大纲
        </button>
      </div>
    </div>

    <div v-if="!showNew && !projects.length" class="empty muted">
      还没有项目，点击右上角新建。
    </div>
    <div v-else-if="!showNew" class="grid">
      <div v-for="p in projects" :key="p.id" class="card" @click="open(p)">
        <div class="card-thumb">
          <SlidePreview v-if="thumbs[p.id!]" :html="thumbs[p.id!]" />
          <div v-else class="thumb-empty muted">无预览</div>
        </div>
        <div class="card-title">{{ p.title }}</div>
        <div class="card-topic muted">{{ p.topic }}</div>
        <div class="card-time muted">{{ p.updated_at }}</div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: 扩展 ProjectList style**

`src/pages/ProjectList.vue` 的 `<style scoped>` 在末尾追加（保留原有 `.page`/`.panel`/`label`/`.grid`/`.card`/`.card-title`/`.card-topic`/`.card-time`）：

```css
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-weight: 600;
}
.field .label {
  font-weight: 600;
}
.style-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  font-size: 13px;
  padding: 4px 10px;
  white-space: nowrap;
}
.chip.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.card-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  margin-bottom: 8px;
  border-radius: 6px;
  overflow: hidden;
  background: #f7f8fa;
}
.thumb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.card-thumb :deep(.preview-wrap) {
  border: none;
  border-radius: 6px;
}
```

- [ ] **Step 4: 类型检查**

Run: `npm run build`
Expected: PASS。`Slide` 类型 import 若未显式使用（仅 thumbs 是 string），删除 `type Slide` import。

- [ ] **Step 5: 手动验证**

Run: `npm run tauri dev`
验证：
- 项目页卡片顶部显示首页缩略图（有 HTML 的项目）；无 HTML 的显示"无预览"。
- 点"新建项目" → 下方列表隐藏，仅见新建表单 + 风格 chips（含"自动"与 12 种）。
- 选风格 + 填主题 → "创建并生成大纲" → 跳 `/outline/:id`。
- 取消新建 → 列表恢复。

- [ ] **Step 6: Commit**

```bash
git add src/pages/ProjectList.vue
git commit -m "feat(projects): card thumbnails, style picker, hide list on new"
```

---

## Task 9: 设置页 — API Key 显示/隐藏 + 模型回填

**Files:**
- Modify: `src/pages/Settings.vue`
- Modify: `src/lib/settings.ts`
- Modify: `src/components/Icon.vue`（加 eye/eye-off 图标）

**Interfaces:**
- Consumes: `getModelsCache`/`saveModelsCache`（新增于 settings.ts）。
- Produces: Settings 页 API Key 可见切换；重开页面模型下拉回填已选模型。

- [ ] **Step 1: settings.ts 加模型缓存读写**

`src/lib/settings.ts` 末尾加：

```ts
export async function getModelsCache(): Promise<string[]> {
  const d = await db();
  const rows = await d.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'models'"
  );
  if (!rows.length) return [];
  try {
    return JSON.parse(rows[0].value) as string[];
  } catch {
    return [];
  }
}

export async function saveModelsCache(ids: string[]): Promise<void> {
  const d = await db();
  await d.execute(
    `INSERT INTO settings(key, value) VALUES('models', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(ids)]
  );
}
```

- [ ] **Step 2: Icon.vue 加 eye/eye-off 图标**

`src/components/Icon.vue`，在 `<g v-else-if="name === 'chevron-right'">…</g>` 之后加：

```html
    <g v-else-if="name === 'eye'">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </g>
    <g v-else-if="name === 'eye-off'">
      <path
        d="M9.88 9.88a3 3 0 0 0 4.24 4.24"
      />
      <path
        d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"
      />
      <path
        d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"
      />
      <line x1="2" y1="2" x2="22" y2="22" />
    </g>
```

- [ ] **Step 3: Settings.vue — 加 showKey 状态与图标按钮**

`src/pages/Settings.vue` script（在 `const saved = ref(false);` 后）加：

```ts
import { ref, watch, onMounted, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getSettings, saveSettings, getModelsCache, saveModelsCache, type ApiSettings } from "../lib/settings";
import Icon from "../components/Icon.vue";

const showKey = ref(false);
```

（替换原 import 行，合并。）

修改 API Key 的 `<label>` 块（原 81-83 行）：

```vue
      <label>
        API Key
        <div class="key-row">
          <input
            v-model="form.api_key"
            :type="showKey ? 'text' : 'password'"
            placeholder="sk-..."
          />
          <button class="ghost icon-btn" @click="showKey = !showKey" type="button">
            <Icon :name="showKey ? 'eye-off' : 'eye'" :size="16" />
          </button>
        </div>
      </label>
```

- [ ] **Step 4: Settings.vue — onMounted 回填模型缓存**

修改 `onMounted`（原 29-32 行）：

```ts
onMounted(async () => {
  form.value = await getSettings();
  models.value = await getModelsCache();
  syncChoice();
});
```

- [ ] **Step 5: Settings.vue — fetchModels 成功后缓存**

修改 `fetchModels`（原 34-52 行），在 `models.value = ids;` 后加：

```ts
    models.value = ids;
    await saveModelsCache(ids);
```

- [ ] **Step 6: Settings.vue — api_base 变更清缓存**

加 watch（在 `watch(models, syncChoice);` 后）：

```ts
watch(
  () => form.value.api_base,
  (v, old) => {
    if (old && v !== old) {
      models.value = [];
      saveModelsCache([]);
    }
  }
);
```

- [ ] **Step 7: Settings.vue — 模型下拉兜底显示当前模型**

修改下拉 `<select>`（原 88-91 行），在 `自定义输入` option 后、`v-for` 前加一个兜底 option：

```vue
          <select :value="modelChoice" @change="onChoice">
            <option :value="CUSTOM">自定义输入</option>
            <option
              v-if="form.model && !models.includes(form.model)"
              :value="form.model"
            >
              {{ form.model }}（已保存）
            </option>
            <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
          </select>
```

并修正 `syncChoice` 使已保存但不在列表的模型不被强制改为 CUSTOM——当前逻辑 `form.model && models.includes(form.model) ? form.model : CUSTOM` 会在模型不在列表时落到 CUSTOM。改为：

```ts
function syncChoice() {
  // 已保存模型优先作为选择；不在列表时也保留（下拉有兜底 option）
  modelChoice.value = form.value.model ? form.value.model : CUSTOM;
}
```

但这样自定义输入框（`v-if="modelChoice === CUSTOM"`）不再出现。需要区分"自定义输入"与"选了某个模型"。改为：`modelChoice` 只在用户显式选 `自定义输入` 时为 CUSTOM，否则等于 `form.model`：

```ts
function syncChoice() {
  if (modelChoice.value === CUSTOM) return; // 用户正在自定义输入，不打断
  modelChoice.value = form.value.model ? form.value.model : CUSTOM;
}
```

`onChoice` 已处理 `v !== CUSTOM` 时写 `form.model`，保持不变。

- [ ] **Step 8: Settings.vue style 加 key-row/icon-btn**

`<style scoped>` 末尾加：

```css
.key-row {
  display: flex;
  gap: 8px;
}
.key-row input {
  flex: 1;
}
.icon-btn {
  padding: 6px 10px;
  display: flex;
  align-items: center;
}
```

- [ ] **Step 9: 类型检查**

Run: `npm run build`
Expected: PASS。`computed` 若未使用会报 unused——本 Step 未用到 computed，删除 import 中的 `computed`，改为 `import { ref, watch, onMounted } from "vue";`。

- [ ] **Step 10: 手动验证**

Run: `npm run tauri dev`
验证：
- 设置页 API Key 输入框旁有眼睛图标，点击切换明文/星号。
- 填好 api_base+key → 获取列表 → 选模型 → 保存 → 重开应用进设置页 → 下拉仍显示已选模型。
- 改 api_base → 缓存清空，下拉只剩"自定义输入"+ 兜底。

- [ ] **Step 11: Commit**

```bash
git add src/pages/Settings.vue src/lib/settings.ts src/components/Icon.vue
git commit -m "feat(settings): toggle API key visibility + model dropdown persistence"
```

---

## Task 10: 预览横向滚动条修复

**Files:**
- Modify: `src/components/SlidePreview.vue`

**Interfaces:**
- Consumes: `SLIDE_W`/`SLIDE_H`。
- Produces: 等比双向 contain 缩放，无横向滚动条。被 Editor、ProjectList 缩略图共用。

- [ ] **Step 1: 重写 SlidePreview scale 计算**

`src/components/SlidePreview.vue`，替换 `<script setup>`：

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { SLIDE_W, SLIDE_H } from "../lib/prompt";

defineProps<{ html: string }>();
const wrap = ref<HTMLElement | null>(null);
const scale = ref(0);
let ro: ResizeObserver | null = null;

function update() {
  if (!wrap.value) return;
  const w = wrap.value.clientWidth;
  const h = wrap.value.clientHeight;
  // 双向 contain：取宽高各自比例的最小值，保证 1920×1080 完整装入不溢出
  scale.value = Math.min(w / SLIDE_W, h / SLIDE_H);
}
onMounted(() => {
  update();
  if (wrap.value) {
    ro = new ResizeObserver(update);
    ro.observe(wrap.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());
</script>
```

- [ ] **Step 2: 重写 SlidePreview template + style**

替换 `<template>` 与 `<style scoped>`：

```vue
<template>
  <div class="preview-wrap" ref="wrap">
    <div class="preview-stage" :style="{ width: SLIDE_W + 'px', height: SLIDE_H + 'px', transform: `scale(${scale})` }">
      <iframe v-if="html" :srcdoc="html" />
      <div v-else class="empty">尚未生成 HTML</div>
    </div>
  </div>
</template>

<style scoped>
.preview-wrap {
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  position: relative;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview-stage {
  transform-origin: center center;
  flex: 0 0 auto;
  position: relative;
}
.preview-stage iframe {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
.empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}
</style>
```

- [ ] **Step 3: Editor e-preview 改 overflow:hidden**

`src/pages/Editor.vue` `<style scoped>` 中 `.e-preview`（约 373-379 行）把 `overflow: auto` 改为 `overflow: hidden`，并确保居中：

```css
.e-preview {
  padding: 20px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

（原 `align-items: flex-start` 改 `center`，配合 SlidePreview 双向 contain 居中。）

- [ ] **Step 4: 类型检查**

Run: `npm run build`
Expected: PASS。

- [ ] **Step 5: 手动验证（关键，肉眼定稿）**

Run: `npm run tauri dev`
验证：
- Editor 预览区：幻灯片完整可见、无横向/竖向滚动条。
- 拖动窗口缩放 → 预览等比 contain、始终居中。
- 项目页卡片缩略图：等比、无溢出。

若仍有滚动条，检查 `preview-wrap` 父容器是否给了确定高度（`aspect-ratio` 需父级有宽度），必要时给 `.e-preview` 明确 `min-height`。

- [ ] **Step 6: Commit**

```bash
git add src/components/SlidePreview.vue src/pages/Editor.vue
git commit -m "fix(preview): dual-axis contain scaling, eliminate horizontal scrollbar"
```

---

## Task 11: 端到端回归验证

**Files:** 无（仅验证）

- [ ] **Step 1: 全量类型检查 + 构建**

Run: `npm run build`
Expected: PASS，`dist/` 生成。

- [ ] **Step 2: 启动完整应用**

Run: `npm run tauri dev`

- [ ] **Step 3: 回归清单逐项验证**

1. **设置页**：API Key 可见切换 ✓；模型下拉重开后回填 ✓；改 api_base 清缓存 ✓。
2. **项目页**：卡片首页缩略图 ✓；新建展开隐藏旧列表 ✓；风格 chips（12+自动）✓。
3. **新建项目**：选风格 + 主题 → 跳 `/outline/:id` ✓。
4. **大纲工作台**：流式思考+JSON 正文 ✓；完成结构化卡片 ✓；对话修改大纲（思考流实时、大纲更新）✓；进入编辑器 ✓。
5. **编辑器逐页/全部**：预览实时流 ✓；对话栏完成简述 ✓；genAll 自动翻页 ✓。
6. **切走再回来**：生成中切设置页再回 Editor → 实时内容可见 ✓。
7. **预览无横滚动条**：窗口缩放等比 contain ✓。
8. **导出 PPT**：仍可正常导出（回归，确认未破坏）✓。

- [ ] **Step 4: 记录结果**

将验证结果（通过/失败项）反馈。若有失败，定位到对应 Task 修复后重验。

- [ ] **Step 5: 最终 Commit（若期间有修复）**

```bash
git add -A
git commit -m "chore: e2e regression pass"
```

---

## Self-Review 记录

- **Spec 覆盖**：8 项 + 大纲页对话均有对应 Task（1-10 覆盖；11 回归）。项 1=Task9，项2=Task8缩略部分，项3=Task8隐藏列表，项4=Task6(+5)，项5=Task4+7，项6=Task2+3+8，项7=Task4+7，项8=Task10。
- **占位符**：无 TBD/TODO；每个 Step 含实际代码或命令。
- **类型一致性**：`genState.slideIdx`/`phase`/`reasoning`/`content`/`status`/`running` 在 Task4 定义、Task6/7 消费一致；`ChatPanel` props 在 Task5 定义、Task6/7 消费一致；`createProject(title,topic,style?)` 在 Task1 定义、Task8 消费一致；`outlinePrompt(topic,count,style?)` 在 Task3 定义、Task4 消费一致。
