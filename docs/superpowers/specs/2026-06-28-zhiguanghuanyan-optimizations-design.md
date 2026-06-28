# 纸光幻演 · 优化设计（第二轮：多AI / Anthropic / 多模态 / 调试 / 安全 / 命名）

- 日期：2026-06-28
- 状态：待评审
- 产品中文名：**纸光幻演**（项目内部代号 auto-ppt / AutoPPT 仅作工程名，不显示于界面）
- 范围：在第一轮已落地的全局 store 流程基础上，新增 7 项优化 + 取消生成 + 导出文件名。
- 第一轮工作（genStore / Outline 工作台 / 风格库 / ChatPanel / SlidePreview）**已完成并上线**，本设计不复述其实现，只在其上叠加。

## 0. 背景与贯穿约束

第一轮已建立的事实（本设计的依赖与不变量）：

- 生成流程由模块单例 `src/lib/genStore.ts`（`genState` reactive）编排，是生成的唯一真相源；组件 `Outline.vue`/`Editor.vue` 只读 store。
- 提示词在 `src/lib/prompt.ts`；画布 `SLIDE_W=1920 / SLIDE_H=1080`。
- `src/lib/ppt.ts` 的 `renderSlideToDataUrl(html)` 已能把一页渲染到隔离隐藏 iframe（1920×1080）并截图为 **PNG dataURL**（`modern-screenshot` 的 `domToPng`）。
- 设置是 `settings` 表扁平 key-value（`api_base/api_key/model/thinking_mode/thinking_effort/models` 缓存），`src/lib/settings.ts` 负责 marshalling。
- Rust 端 `src-tauri/src/lib.rs` 仅做浏览器沙箱做不了的事：`chat_stream`（OpenAI 兼容 SSE 代理，解析 `choices[0].delta.content`/`reasoning_content`）、`list_models`（GET `/models`）、`save_file`（写导出文件）。迁移由 `run()` 在启动时应用（已到 version 3）。
- Tauri 2 默认行为：debug 构建开 devtools、release 构建 devtools 不带 `devtools` feature 故关闭——"开发可调出/生产不可调出"已是默认。

### 贯穿约束
- UI 文案、提示词保持中文。
- 画布尺寸不变。
- JSON 模式仅大纲生成用；HTML 生成与对话修改不开 JSON 模式（沿用旧约定）。
- 不引新的前端依赖；Rust 依赖新增 `futures-util`（取消生成用，前端已间接依赖）——**已存在于 Cargo.toml**。
- 取消生成是本次新增的唯一 Rust 命令；其余 Rust 改动为现有命令的格式/多模态分支扩展，不新增命令。

## 1. 数据模型与迁移（需求 1/2/3 地基）

### 方案选型

- **A. 独立 `ai_configs` 表（采纳）** —— 与 `db.ts` 现有 typed helper 风格一致，migration 建表，可查询可扩展。
- B. `settings` 表存 JSON blob + `active_ai_id` —— 不建表，但无类型、难扩展，与现有 typed-helper 风格不符。
- C. 扁平 key 前缀（`ai_1_api_base`…）—— 放弃，命名混乱。

采纳 **A**。

### 新 migration `src-tauri/migrations/004_ai_configs.sql`

```sql
CREATE TABLE IF NOT EXISTS ai_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_base TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'openai',        -- openai | anthropic
  multimodal INTEGER NOT NULL DEFAULT 0,          -- 0 否 / 1 是
  thinking_mode INTEGER NOT NULL DEFAULT 0,
  thinking_effort TEXT NOT NULL DEFAULT 'high',
  enabled INTEGER NOT NULL DEFAULT 0,             -- 单选启用：同一时刻至多一条为 1
  models_cache TEXT,                              -- JSON 数组，缓存该 config 的模型下拉
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`lib.rs` `run()` 的 migrations vec 追加 version 4。

### 旧数据兼容（需求 3："空 = openai"）

- **不靠 SQL 自连接**，而在 TS 层 `ensureLegacyImport()`：表为空 且 `settings` 表存在非空 `api_base` 时，建一条 `format='openai', multimodal=0, enabled=1, thinking_mode=(settings.thinking_mode==='true'?1:0)` 的记录（沿用其 api_base/api_key/model/thinking_effort/models）。
- 在 `src/main.ts` 启动时 `ensureLegacyImport()` 调用一次（`createApp(...).mount()` 之前）。
- 兼容语义：旧数据本就按 OpenAI 格式工作，故空 format 默认 openai；导入后 `enabled=1` 保证应用开箱仍用原配置。

## 2. 设置访问层 `src/lib/aiConfig.ts`（新）

替换原 `settings.ts` 的全局单组 ApiSettings 模型：

- `AiConfig` 接口：`id?, name, api_base, api_key, model, format:'openai'|'anthropic', multimodal:boolean, thinking_mode:boolean, thinking_effort:string, enabled:boolean, models_cache?:string[]`。
- helpers：
  - `listAiConfigs(): Promise<AiConfig[]>`
  - `getActiveAi(): Promise<AiConfig | null>` —— 返回 `enabled=1` 那条（至多一条）。
  - `saveAiConfig(c: AiConfig): Promise<number>` —— 插入或更新；`enabled` 由 `setActiveAi` 专管，不在此处改。
  - `deleteAiConfig(id): Promise<void>`
  - `setActiveAi(id): Promise<void>` —— 事务内 `UPDATE ai_configs SET enabled=0` 再 `UPDATE … WHERE id=? SET enabled=1`（单选语义）。
  - `getModelsCache(id)/saveModelsCache(id, ids)` —— 改为按 config 存取（读写 `ai_configs.models_cache`）。
- `chat.ts`：`chat()` 改读 `getActiveAi()`（含 format/multimodal）；无启用项则抛 `请先在「设置」页配置并启用一个 AI`。`hasSettings()` → `hasActiveAi()`。
- 旧 `settings.ts` 的 `getSettings/saveSettings/getModelsCache/saveModelsCache`：仅保留 `ensureLegacyImport` 需要的最小读路径，或并入 `aiConfig.ts`。删除已无用的 `ApiSettings` 全局单组导出。

## 3. 设置页 UI 改造（需求 1/2/3）

`src/pages/Settings.vue` 重构为「多 AI 配置列表 + 编辑表单」：

- 顶部：AI 配置列表（卡片/行），每条显示 `name + format 徽标 + multimodal 标记 + 当前启用态`；右侧「启用」单选 radio（点选即 `setActiveAi`，自动停用其余）、「编辑」「删除」。
- 「新建 AI 配置」按钮 → 空表单。
- 编辑表单字段：
  - 名称（如「DeepSeek」「Claude」）
  - 格式：下拉 `openai` / `anthropic`（默认 openai）—— **需求 3 在设置页直接选**
  - API 地址（api_base）
  - API Key（眼睛切换显示/隐藏，沿用第一轮 `eye`/`eye-off` 图标）
  - 模型（下拉 + 自定义 + 「获取列表」按钮，沿用第一轮逻辑，缓存按 config 存）
  - 是否多模态：开关（默认否）—— **需求 1**
  - 思考模式 / 思考强度（沿用第一轮）
- 帮助文案：OpenAI 格式自动补 `/chat/completions`；Anthropic 格式走 `/v1/messages`。
- 格式切换时清空 `models_cache`（不同 provider 列表不同），与第一轮 `api_base` 变更清缓存同理。

## 4. Rust 端格式分支 + 多模态（需求 3 / 4a / 4b 前置）

不新增命令，扩展 `chat_stream` 与 `list_models` 按 `config.format` 分支。

### `ChatConfig` / `ChatMessage` 扩展

```rust
struct ChatConfig {
    api_base, api_key, model: String,
    format: String,            // "openai" | "anthropic"，缺省 openai
    #[serde(default)] thinking_mode: bool,
    #[serde(default)] thinking_effort: String,
    #[serde(default)] json_mode: bool,
    #[serde(default)] multimodal: bool,   // 仅供前端分支用，Rust 实际按消息里 images 是否非空决定
}
struct ChatMessage {
    role: String,
    content: String,
    #[serde(default)] images: Vec<String>,   // dataURL，多模态时附带
}
```

### OpenAI 分支（现状 + 多模态图片）
- URL `{api_base}/chat/completions`，header `Authorization: Bearer {key}`。
- body：`messages` 里若该消息 `images` 非空，把 `content` 组装成 `[{type:"text",text:content}, {type:"image_url",image_url:{url: <dataURL>}}]`。
- SSE 解析不变：`choices[0].delta.content`→`chat-chunk`，`reasoning_content`→`chat-reasoning`。

### Anthropic 分支（新，需求 3）
- URL `{api_base}/v1/messages`，header `x-api-key: {key}` + `anthropic-version: 2023-06-01` + `Content-Type: application/json`。
- body：
  - `system` 从 `role==='system'` 的消息合并为顶层字符串；非 system 消息进 `messages`。
  - `model`、`stream:true`、`max_tokens`（必填，给一个较大默认如 8192）。
  - 多模态：用户消息 `content` 组装为 `[{type:"text",text:...}, {type:"image",source:{type:"base64",media_type:"image/png",data:<去前缀的base64>}}]`。
  - thinking：开启时 `thinking:{type:"enabled",budget_tokens: <effort 映射>}`（high→约 16k，max→约 32k），并据此调高 `max_tokens`。
- SSE 解析 Anthropic 事件类型：
  - `content_block_delta` 中 `delta.type==='text_delta'` → `chat-chunk`（`delta.text`）。
  - `delta.type==='thinking_delta'` → `chat-reasoning`（`delta.thinking`）。
  - `message_stop` → `chat-done`，返回。
- 其余事件（`message_start`/`content_block_start`/`ping`）忽略。

### `list_models` 分支
- OpenAI：GET `{api_base}/models` + Bearer（现状）。
- Anthropic：GET `{api_base}/v1/models` + `x-api-key`/`anthropic-version`。
- 返回结构两边都取 `data[].id`（Anthropic 同为 `{data:[{id}]}`）。

## 5. 多模态自检（需求 4a — 自动重写并应用）

### 图片传输：base64 dataURL（确认）
无公网托管，截图只能内联 base64。`ppt.ts` 的 `domToPng` 返回 PNG dataURL，**零转换**直接进 `images` 数组传给 Rust。一张 1920×1080 PNG 约 1–2MB（base64 后 ~1.5–2.7MB），在各家单请求体积上限内。两种格式分支在第 4 节已支持 base64 图片块。

### 自检流程（genStore）
- 新增 phase `"selfcheck"` 与 action `selfCheckSlide(projectId, slides, idx)`：
  1. `renderSlideToDataUrl(slide.html_content)` 截当前页 PNG。
  2. `chat([system:"你是 PPT 自检员，对照截图与当前 HTML 找出视觉/排版/溢出/留白/对齐问题并返回改进后的完整 HTML 文档", user:"当前HTML:\n{html}\n\n请对照截图自检并返回改进版完整HTML，只输出HTML"])`，`images=[dataUrl]`。流式进 `genState.content` → `slide.html_content = cleanHtml(content)`（预览实时跟随，与 chat 体验一致）。
  3. 完成后 `cleanHtml` 校验：含 `<html` 且含 `.slide` 或 `<div class="slide"` 才 `upsertSlide`；否则保留原页，记一条消息"自检未返回有效 HTML，已保留原页"。
  4. 成功追加消息"已自检并改进第 N 页"。
- 触发点：`startSlide` 完成、`startAll` 每页完成、`Editor.genOne` 完成后，若 `getActiveAi().multimodal && autoSelfcheck`（app 级开关，见下）→ 调 `selfCheckSlide`。`startAll` 循环照常推进。
- **成本控制开关** `auto_selfcheck`（settings 表 key，默认 `"true"`）：多模态 AI 每页多一次调用，关掉则不自动跑。自检同样受取消标志影响（见第 6 节）。
- 非多模态 AI（multimodal=false）整条跳过自检。

## 6. 取消生成（新增需求）

唯一并发性约束：`genState` 单例、`running` 全程 gate，**同一时刻只有一个流在跑**，取消只需单槽。

### Rust（不新增依赖，复用已有的 `futures-util`）
- `tauri::State<Mutex<Option<AbortHandle>>>`（单槽）。
- `chat_stream` 开始时 `AbortHandle::new_pair()`：把 handle 存入 state，把 `AbortRegistration` 交给 `Abortable::new(streaming_fut, reg)` 包住整个「发请求→读 SSE 循环」的 future。
- `Abortable` 每次 poll 检查中止标志，`abort()` 主动唤醒挂起的 future——即使模型在停顿、无新 chunk，取消也能**立刻**生效并 drop reqwest response（真正关闭连接）。
- 取消时 `emit("chat-done")` 让前端清理监听，返回 `Err("__cancelled__")`（哨兵）。
- 新命令 `cancel_chat`：从 state 取 handle 调 `.abort()`，幂等（无 handle 时空操作）。

### 前端
- `genState` 加 `cancelled: boolean`；`cancelGeneration()`：置 flag + `invoke("cancel_chat")`。`resetBuffers()` 清 flag（新一次 run 不残留）。
- `chat()` 捕获 `__cancelled__` 哨兵 → 抛一个带 `__cancelled: true` 标记的错误，**不当硬错误**。
- 各 action 的 `catch` 识别该标记：`status="已取消"`、跳过 `upsertSlide`/解析（不写半截 HTML 进库）、提前 `return`（`finally` 仍把 `running/phase` 复位）；`startAll` 循环每页后检查 `genState.cancelled` 中断循环。
- 自检同样可被取消（`selfCheckSlide` 内部的 `chat()` 受同一哨兵影响）。

### UI
- `Editor`/`Outline`：`genState.running` 时把原操作按钮（"生成全部"/"导出"）位临时换为一个红色"取消"按钮 → `cancelGeneration()`；`running` 结束恢复。

## 7. 调试模式点选元素入对话（需求 6 — 返回整页新 HTML）

### 交互
- `Editor` 头部加"调试模式"开关（默认关）。
- `SlidePreview` 加 `inspectMode?: boolean` prop。
- inspectMode 开时：iframe（srcdoc，同源可读 `contentDocument`）`load` 后挂 `click` 监听——`e.preventDefault()`，取 `target.outerHTML` + 一条 CSS 选择器路径（`el.tagName.toLowerCase() > …`，带 `:nth-child`），iframe 内高亮该元素（临时 outline）。
- `SlidePreview` emit `pick { html, selector }` 给 `Editor`。

### 入对话栏
- `ChatPanel` 暴露 `prepend(text)` 方法（`defineExpose`）。
- `Editor` 收 `pick` → 调 `ChatPanel.prepend`，把下面文本插入输入框（光标置于其后）：
  ```
  【选中元素】
  ```html
  {outerHTML}
  ```
  定位：{selector}
  ```
- 用户在其后补写自然语言指令后发送。

### 精确修改
- `Editor` 追踪"待发送含选中元素"状态（从输入框前缀检测，或单独 ref）。
- `sendChat` 收到含选中元素时，提示词附加：
  `用户用调试模式选中了页面中一个元素，仅改动该元素对应的部分，其余结构保持不变，返回完整 HTML 文档：\n选中元素HTML:\n{elementHtml}\n定位：{selector}\n用户指令：{instruction}`。
- 仍返回**整页新 HTML**（沿用 chat 契约，安全；不破坏整页结构）。

## 8. 右键禁用 + devtools dev/prod（需求 4b）

- `main.ts`：`window.addEventListener('contextmenu', e => e.preventDefault())` —— **始终禁右键菜单**（"先直接禁止"）。dev 仍可用 F12。
- devtools"开发可调出/生产不可调出"：Tauri 2 默认即此行为。显式加固：`import.meta.env.PROD` 为真时 `keydown` 拦截 F12 / Ctrl+Shift+I/J/C / Cmd+Opt+I 等（`preventDefault()`）。dev 构建不拦截。
- 不加 `devtools` Cargo feature（保持 release 默认关闭）。

## 9. 中文名 + 命名（需求 5 — 纸光幻演）

- `index.html`：`lang="zh"`、`<title>纸光幻演</title>`（去掉 `vite.svg` favicon 指向或保留无妨）。
- `src-tauri/tauri.conf.json`：窗口 `title` → `"纸光幻演"`；`productName` 保留 `AutoPPT`（安装包/内部代号）。
- `src/App.vue`：品牌 `<span>` → `纸光幻演`。
- `src/lib/ppt.ts`：`pptx.author` → `"纸光幻演"`。
- `package.json`/`Cargo.toml` 的 `name` 保持工程代号（不动）。

## 10. 导出文件名（需求 7 — 用项目名）

- `exportPptx(slides, projectId, title?: string)`：`defaultPath = sanitize(title) + ".pptx"`（去 `/ \ : * ? " < > |` 等非法字符并 trim）；空则 fallback `presentation.pptx`。
- `Editor.doExport` 传 `project.value.title`。
- `dialog` 的 `save` `defaultPath` 直接用该名。

## 11. 数据流总览（新增部分）

```
启动 main.ts
  └─ ensureLegacyImport()  [表空且 settings 有旧配置 → 建 1 条 openai/enabled]

Settings.vue
  └─ 多 AI 列表：启用(单选) / 编辑 / 删除 / 新建
  └─ 表单：name / format(openai|anthropic) / api_base / key / model / multimodal / thinking

chat.ts
  └─ getActiveAi() → 含 format/multimodal → invoke chat_stream

chat_stream (Rust)
  ├─ format=openai  → /chat/completions, Bearer, images→image_url
  └─ format=anthropic → /v1/messages, x-api-key, system 顶层, images→image base64
  └─ Abortable 包住，cancel_chat 可中止 → Err("__cancelled__")

genStore
  ├─ startSlide → (multimodal && autoSelfcheck) → selfCheckSlide[截图→images→改写HTML]
  ├─ sendChat (+调试选中元素) → 返回整页新 HTML
  └─ cancelGeneration → invoke cancel_chat，识别 __cancelled__ 不当硬错误

Editor/Outline
  └─ running 时显示"取消"按钮
  └─ 调试模式：SlidePreview inspectMode → 点选元素 → ChatPanel.prepend 入输入框

导出
  └─ exportPptx(slides, projectId, title) → defaultPath = sanitize(title)+".pptx"
```

## 12. 不做（YAGNI）

- 调试点选的"仅替换元素"分支（已选整页方案，沿用 chat 契约更安全）。
- 自检的"只反馈问题不自动改"与"手动按钮"模式（已选自动重写并应用）。
- 多 AI 多选启用（已选单选启用）。
- 生成中断后的断点续传（取消即丢弃本次，重新生成即可）。
- 第一轮 spec 已留的 PNG 缩略图缓存优化（与本轮无关）。

## 13. 文件改动清单

**新增：**
- `src/lib/aiConfig.ts` — 多 AI 配置 typed helpers（替代 settings.ts 全局单组模型）。
- `src-tauri/migrations/004_ai_configs.sql` — ai_configs 表。

**修改：**
- `src/main.ts` — `ensureLegacyImport()` 启动调用；contextmenu 全局禁用；PROD 下拦截 devtools 快捷键。
- `src/lib/chat.ts` — `chat()` 读 `getActiveAi()`，消息支持 `images`；识别 `__cancelled__` 哨兵。
- `src/lib/settings.ts` — 删除全局单组 `ApiSettings` 与 `getSettings/saveSettings`；保留（或并入 aiConfig.ts）`ensureLegacyImport` 所需的旧 settings 读路径，以及 app 级开关 `getSetting(key)/setSetting(key,val)`（用于 `auto_selfcheck` 等纯开关项）。`getModelsCache/saveModelsCache` 按 config 移入 aiConfig.ts。
- `src/lib/genStore.ts` — 加 `cancelled`/`selfcheck` phase/`selfCheckSlide`/`cancelGeneration`；startSlide/startAll 触发自检；catch 识别取消。
- `src/lib/prompt.ts` — 自检提示词；调试选中元素的修改提示词（可内联 sendChat 处组装）。
- `src/lib/ppt.ts` — `exportPptx` 加 `title` 参数与 sanitize；`author` 改中文名。
- `src/pages/Settings.vue` — 多 AI 列表 + 编辑表单（含格式/多模态）。
- `src/pages/Editor.vue` — 取消按钮；调试模式开关与 pick 处理；导出传 title。
- `src/pages/Outline.vue` — 取消按钮。
- `src/components/SlidePreview.vue` — `inspectMode` prop + 点选 emit。
- `src/components/ChatPanel.vue` — `prepend()` 暴露。
- `src/App.vue` — 品牌中文名。
- `index.html` — lang/title 中文。
- `src-tauri/tauri.conf.json` — 窗口 title 中文名。
- `src-tauri/src/lib.rs` — 注册 migration v4；`chat_stream`/`list_models` 格式分支 + 多模态图片；`ChatConfig`/`ChatMessage` 加字段；`Abortable` + `cancel_chat` 命令 + `Mutex<Option<AbortHandle>>` state；invoke_handler 注册 `cancel_chat`。
- `src-tauri/capabilities/default.json` — 若 `cancel_chat` 需权限则补（同为 invoke 命令，预期无需额外 capability）。

## 14. 风险与回退

- **Anthropic 格式是新增网络路径**：实现时用真实 Anthropic key 跑一次大纲生成 + 一次带图自检验证。解析失败时 status 报错、保留原内容不写库（沿用第一轮容错约定）。
- **Abortable 中止的连接清理**：`abort()` drop reqwest response 即关闭底层连接，不留泄漏；哨兵 `__cancelled__` 在前端唯一识别，不会被误判为业务错误。
- **多 AI 单选一致性**：`setActiveAi` 在事务内先全置 0 再置 1，避免出现 0 条或 ≥2 条 enabled。`getActiveAi` 取第一条 enabled，即使误有多条也不崩。
- **旧数据导入幂等**：`ensureLegacyImport` 仅在表空时执行；已导入过则不再触发，不重复建记录。
- **devtools 加固仅在 PROD**：dev 构建完全不拦截，保证开发期 F12 可用；release 靠 Tauri 默认（不带 devtools feature）+ JS 拦截双保险。
