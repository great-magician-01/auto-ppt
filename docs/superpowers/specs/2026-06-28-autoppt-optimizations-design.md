# AutoPPT 优化设计（8 项 + 大纲页对话补充）

- 日期：2026-06-28
- 状态：待评审
- 范围：AutoPPT（Tauri 2 + Vue 3 + TS）现有可跑通基础流程的 8 项优化，以及大纲页增加对话式修改能力的补充。

## 0. 背景与贯穿性约束

现有基础流程能跑通：设置页配 API → 新建项目（主题）→ Editor 内生成大纲（JSON 模式，两阶段）→ 逐页生成 HTML → 对话修改单页 → 导出 pptx。

存在的问题集中在三处：
1. **状态局部化**：`busy / status / 流式缓冲` 都是 `Editor.vue` 组件本地 ref，组件卸载即丢，而后端 Rust `chat_stream` 的 invoke 仍在后台运行 → 生成中切走再回来"像没在动"。
2. **生成过程不可见**：大纲与逐页生成的思考/正文都不流式给用户看，对话栏只在迭代修改时显示一句固定文本。
3. **设置/项目/预览三处细节缺漏**：API Key 恒星号、模型下拉空白、项目卡片无预览、新建时旧列表并存、预览横向滚动条。

### 贯穿约束
- UI 文案、提示词保持中文。
- 画布尺寸不变：`SLIDE_W=1920 / SLIDE_H=1080`（`src/lib/prompt.ts`）。
- JSON 模式仅大纲生成用；HTML 与对话修改均不开 JSON 模式（现有约定）。
- Rust 端只做浏览器沙箱做不了的事（代理 SSE、取模型、写文件）；本设计不新增 Rust 命令，仅可能新增一个 DB migration（version 2）。
- 不引新前端依赖（不加 Pinia 等）。

## 1. 架构地基：全局生成 store（服务项 4 / 5 / 7，以及大纲页对话）

### 动机
当前编排与流式缓冲都在组件 ref 上。要满足"切走再回来见实时内容"和"genAll 跨导航仍自动翻页"，必须把编排与缓冲提到组件生命周期之外。

### 方案：模块单例 store（不引依赖）
- 新文件 `src/lib/genStore.ts`，导出一个 `reactive({...})` 单例对象与一组动作函数。
- store 持有：
  - `running: boolean`
  - `phase: 'idle' | 'outline' | 'outline-chat' | 'slide' | 'chat'`
  - `projectId: number | null`
  - `slideIdx: number`（当前生成/选中的页索引）
  - `reasoning: string`（实时思考流缓冲）
  - `content: string`（实时正文流缓冲，原始文本/JSON）
  - `status: string`
  - `error: string | null`
  - `lastOutlineJson: string | null`（大纲页展示与重试用）
- 动作函数（都进 store，组件不再自管这些状态）：
  - `startOutline(projectId, topic, style)` —— 阶段1生成，JSON 模式，解析失败重试 1 次（逻辑从 `Editor.genOutline` 搬入），写库（projects + slides）。
  - `sendOutlineChat(projectId, topic, style, instruction)` —— 大纲对话修改，非 JSON 模式，提示词约束返回相同 JSON 结构，`parseOutline` 解析后覆盖写 slides。
  - `startSlide(idx)` —— 阶段2单页 HTML。
  - `startAll()` —— 循环逐页；每完成一页：写库 + 追加一条本地拼装的完成消息 + `slideIdx` 推进到下一页；继续。
  - `sendChat(instruction)` —— 对话修改当前页。
- `chat()`（`src/lib/chat.ts`）的 `onChunk / onReasoning` 回调直接写 store 的响应式字段。Tauri 监听随 invoke 调用创建、invoke 返回即释放，与组件无关。
- 关键不变量：**store 是生成过程的唯一真相源**。`running` 为真时，预览与对话栏读取 store 缓冲；`running` 为假时，读取库里的最终态。
- 预留 `cancel()` 接口位（本次不实现，需 Rust 端 reqwest abort 句柄，留作后续）。

### 与组件的关系
- `Editor.vue` 退化为视图：`onMounted` 仍 `load()` 取库最终态，同时读 store；若 `store.running && store.projectId===本页`，则预览/对话栏呈现 store 实时缓冲，否则按库内容显示。`busy`/`status` 改为 `store.running`/`store.status` 的计算属性。
- `Outline.vue`（新增）同理：挂载即读 store，必要时触发 `startOutline`。

## 2. 逐项设计

### 项 1 — 设置页：API Key 显示 + 模型回填

**API Key 显示/隐藏：**
- API Key 输入框旁加切换按钮，在 `type="password"` 与 `type="text"` 间切换。
- 给 `src/components/Icon.vue` 补 `eye` / `eye-off` 两个 Lucide 风格图标。

**模型下拉空白修复（两步）：**
- `Settings.vue` `fetchModels` 成功后，把列表 JSON 存入 `settings` 表 key=`models`；`onMounted` 读出回填 `models.value`，下拉即有上次内容。
- 兜底：下拉始终把当前已存 `form.model` 作为一个额外 option 渲染，即使不在列表里也不丢。
- `api_base` 变更时清掉缓存的 `models`（避免用旧 provider 列表）。
- `src/lib/settings.ts`：`models` 不属于 `ApiSettings`，单独加 `getModelsCache() / saveModelsCache(ids)` 读写 `settings` 表的 `models` key。

**验证：** 设置页保存 key 后重开，下拉仍显示已选模型；点眼睛图标可见/隐藏明文 key。

### 项 2 — 项目页：卡片显示首页缩略图

- `src/lib/db.ts` 加 `getFirstSlide(projectId): Promise<Slide | null>`（`ORDER BY sort ASC LIMIT 1`）。
- `ProjectList.vue` 加载项目后，并行取每个项目的第 1 页 `html_content`，存入本地 `Map<projectId, html>`。
- 卡片内嵌轻量缩略组件：复用 `SlidePreview.vue` 的等比 `transform:scale` 缩放，固定 16:9 顶图尺寸。无 HTML 的项目显示占位。
- 性能注记：多 iframe 较重；若项目变多，后续再做"导出时存 PNG 缩略图到 `slides.image_path`/项目缩略图列"缓存优化。**本次不做**，留作后续。

**验证：** 项目列表每张卡片顶部显示第 1 页缩略图。

### 项 3 — 新建项目：隐藏下方旧列表

- `ProjectList.vue` 模板：项目网格与空状态用 `v-if="!showNew"` 包裹。新建面板展开期间只见表单，取消/创建后恢复列表。

**验证：** 点"新建项目"后下方列表消失；取消后回来。

### 项 4 — 大纲生成：独立路由 `/outline/:id` + 流式 + 对话修改（含 4-bis 补充）

**路由：**
- `src/router.ts` 加懒加载项 `{ path: '/outline/:id', name:'outline', component: ()=>import('./pages/Outline.vue'), props:true }`。
- `ProjectList.create()` 创建项目后 `router.push('/outline/:id')`（不再直接进 Editor）。
- `Editor.vue` 在"无大纲"时把"生成大纲"按钮改为跳 `/outline/:id`（不在 Editor 内直接生成）。

**`src/pages/Outline.vue`（大纲工作台）：**
- 两栏布局：主区 + 右侧对话栏（对话栏抽成共享组件 `src/components/ChatPanel.vue`，Editor 与 Outline 共用，见下）。
- 主区状态机：
  - 生成中（`store.phase==='outline'`）：流式显示 `store.reasoning`（思考）与 `store.content`（正文 = 原始 JSON 逐字增长）。
  - 已有大纲（库中存在 slides）：主区渲染结构化大纲卡片视图（逐页标题 + 版式徽标 + 要点列表）。
  - 对话修改中（`store.phase==='outline-chat'`）：思考流进对话栏，正文（JSON）流式进主区正文位，完成后重新解析渲染结构化卡片。
- 底部固定一个「进入编辑器 →」按钮 → `router.push('/editor/:id')`。**不自动跳转**（对话修改需要用户主动确认完成）。
- `onMounted`：读 store；若 `store.projectId===本页 && store.running`，直接呈现实时缓冲；若该项目库中已有大纲，显示结构化视图并允许继续对话修改；否则触发 `startOutline`。
- 大纲已完成、用户又想改：直接在对话栏输入指令 → `sendOutlineChat`。

**共享组件 `src/components/ChatPanel.vue`：**
- props: `messages: Message[]`, `running: boolean`, `reasoning: string`（实时思考流，可选展示）, `disabled`, `placeholder`。
- emits: `send(text)`。
- 内部：消息列表 + 实时生成卡片（`v-if="running"` 显示 `reasoning`）+ 文本框（Ctrl/⌘+Enter 发送）。
- `Editor.vue` 与 `Outline.vue` 都用 `ChatPanel`，样式统一。

**验证：** 新建项目 → 跳大纲页 → 流式见思考+JSON 正文 → 完成见结构化大纲 → 输入修改指令 → 思考流实时显示 → 大纲按指令更新 → 点进入编辑器。

### 项 5 — 逐页生成流入对话栏 + genAll 自动翻页

- 全部走 store。对话栏（`ChatPanel`）渲染规则：
  - 进行中：`store.phase==='slide' && store.slideIdx===currentIdx` 时，显示一张"实时生成"卡片，内容是 `store.reasoning` 流式文本。
  - 完成：store 往 `messages` 表追加一条本地拼装的助手消息：`第 N 页已生成 · 版式 {kind} · {bullets.length} 个要点 · {title}`，数据来自该页 `outline`，**不额外调 AI**。
- `startAll` 循环：每完成一页 → 写库 → 追加完成消息 → `store.slideIdx = i+1`（预览与对话栏自动跟随）→ 继续 `i+1`。切走再回来仍由 store 驱动 `slideIdx`。
- `sendChat`（迭代修改）并入 store：思考流进对话栏，预览继续实时流入 `cur.html_content`，完成追加"已按指令更新当前页"。与生成体验一致。

**验证：** 点"生成全部" → 预览逐页切换 → 对话栏每页完成后出现一条简述 → 切走再回来仍在正确页且见实时内容。

### 项 6 — 风格库（标题+描述+设计提示，只传元数据）

**`src/lib/styles.ts`：**
- 内置固定风格集（约 12 种），每条结构：
  ```
  { id, name, desc, palette, font, density }
  ```
  - 例：`palette:"深色+霓虹蓝紫"`、`font:"无衬线+等宽点缀"`、`density:"中等"`。
- **只有 `name + desc + palette + font + density` 进提示词**，不含完整 CSS。
- 提议清单（可在评审阶段增删）：科技风 / 商务汇报 / 极简小清新 / 杂志编辑 / 中国风水墨 / 暗夜霓虹 / 学术严谨 / 卡通活泼 / 复古印刷 / 自然有机 / 未来工业 / 优雅奢华。

**DB migration（version 2）：**
- 新文件 `src-tauri/migrations/002_add_style.sql`：`ALTER TABLE projects ADD COLUMN style TEXT;`（存风格 id 或 `null`=自动）。
- `src-tauri/src/lib.rs` `run()` 的 migrations vec 加 version 2。
- `src/lib/db.ts`：`Project` 接口加 `style?: string | null`；`createProject(title, topic, style?)` 支持传入；`updateProject` 的 `Partial<Pick<...>>` 加入 `style`。

**`ProjectList.vue` 新建面板：**
- 加风格选择器：chip 网格 + "自动"选项，每个 chip 显示 `name + desc`（hover/选中时）。
- 创建项目时把所选风格 id（或 `null`）传入 `createProject`。

**提示词（`src/lib/prompt.ts`）：**
- `outlinePrompt(topic, slideCount, style?)` 新增 `style` 参数：
  - 显式选了 → 注入该风格 `name+desc+提示`，要求"严格按此风格设计 design_tokens/theme_css"。
  - 自动（`style==null`）→ 注入**全部 12 条的 `name+desc+提示`**，要求"挑最契合主题的一个，并在 JSON 里返回 `style` 字段为其 id"。
  - store（`startOutline`）把返回 JSON 里的 `style` 写回 `project.style`（卡片/编辑器可显示风格徽标）。
- 风格只在**大纲阶段**注入；逐页 HTML 通过 design_tokens/theme_css 继承风格，不再重复传。

**验证：** 新建项目选"科技风" → 大纲按科技风配色/版式；选"自动" → AI 自选并回填风格徽标。

### 项 7 — 生成中切走再回来见实时内容

- 直接收益自架构地基（项 1 store）：
  - store 单例 + 响应式状态跨组件存活。
  - Editor `onMounted` 仍 `load()` 取库最终态；同时读 store：若 `store.running && store.projectId===本页`，预览/对话栏呈现 store 实时缓冲；若 idle，按库内容显示。
  - 切走时 invoke 仍在后台跑，缓冲持续写 store；回来读到最新。
- 无需额外机制。

**验证：** 生成全部过程中切到设置页再回 Editor → 仍在正确页且预览/对话栏显示实时内容。

### 项 8 — 预览横向滚动条

- `src/components/SlidePreview.vue`：
  - scale 改为 `Math.min(wrapW / SLIDE_W, wrapH / SLIDE_H)`（双向 contain，当前只按宽度算会因高度溢出产生横/竖向滚动条）。
  - iframe 居中。
  - 核对 `box-sizing`、`flex` 居中、`e-preview` 容器是否需要 `overflow:hidden`，确保 1920×1080 的布局盒不撑出容器（当前 `preview-wrap` 已 `overflow:hidden`，但 `e-preview` 是 `overflow:auto`，可能仍出现滚动条 → 一并修）。
- **实现时跑 `npm run dev` 肉眼验证**再定稿，不靠纯推理。

**验证：** 预览框内 1920×1080 幻灯片完整可见、无横向滚动条、窗口缩放时保持等比 contain。

## 3. 数据流总览

```
ProjectList.create(topic, style)
  └─ createProject(title, topic, style) ─ router.push('/outline/:id')
Outline.vue
  ├─ startOutline(projectId, topic, style)  [JSON mode, retry×1]
  │     └─ store.reasoning/content 流式 → 主区 + 对话栏(思考)
  │     └─ parseOutline → 写 projects(design_tokens,theme_css[,style]) + slides
  ├─ sendOutlineChat(...)  [non-JSON, 约束返回同结构 JSON]
  │     └─ parseOutline → 覆盖写 slides
  └─ 进入编辑器 → /editor/:id
Editor.vue (视图化)
  ├─ onMounted: load() + 读 store
  ├─ startSlide(idx) / startAll()  [non-JSON]
  │     └─ 预览实时流 content(html) / 对话栏实时流 reasoning
  │     └─ 完成: 写 slides.html_content + 追加本地完成消息 + slideIdx++
  └─ sendChat(instruction)  [non-JSON]
        └─ 预览实时流 + 对话栏思考流 → 写 slides.html_content
Settings.vue
  └─ API Key 显示/隐藏 + models 缓存回填
SlidePreview.vue
  └─ 双向 contain scale（修滚动条）
```

## 4. 不做（YAGNI）
- 生成中断/取消（需 Rust 端 reqwest abort 句柄；store 仅预留 `cancel()` 接口位）。
- 风格用户自定义（项 6 选定"内置固定集"）。
- 项目缩略图 PNG 缓存（项 2 先用 iframe 实时缩略，留作后续优化）。
- Rust 端新增命令（本设计仅新增 DB migration，不动 invoke_handler）。

## 5. 文件改动清单

**新增：**
- `src/lib/genStore.ts` — 全局生成 store 与编排动作。
- `src/lib/styles.ts` — 风格库常量表。
- `src/pages/Outline.vue` — 大纲工作台。
- `src/components/ChatPanel.vue` — 共享对话栏。
- `src-tauri/migrations/002_add_style.sql` — projects 加 style 列。

**修改：**
- `src/router.ts` — 加 `/outline/:id` 路由。
- `src/lib/chat.ts` — `chat()` 回调仍由调用方（store）传入，无大改。
- `src/lib/prompt.ts` — `outlinePrompt` 加 `style` 参数与注入逻辑。
- `src/lib/db.ts` — `Project` 加 `style`；`getFirstSlide`；`createProject/updateProject` 支持 `style`。
- `src/lib/settings.ts` — `getModelsCache/saveModelsCache`。
- `src/pages/Editor.vue` — 视图化，用 `ChatPanel`，"生成大纲"改为跳路由，读取 store。
- `src/pages/ProjectList.vue` — 卡片首页缩略图；新建面板风格选择器 + 隐藏旧列表。
- `src/pages/Settings.vue` — API Key 切换；模型回填。
- `src/components/SlidePreview.vue` — 双向 contain scale。
- `src/components/Icon.vue` — `eye`/`eye-off` 图标。
- `src-tauri/src/lib.rs` — 注册 migration version 2。

## 6. 风险与回退
- **store 单例是较大重构**：迁移期间 Editor 原有逻辑与 store 并存易出双写。实现时按"先建 store + 动作 → Editor 切换调用 → 删旧本地逻辑"顺序推进，每步可独立验证。
- **DB migration**：`ALTER TABLE ADD COLUMN` 对已有库是安全的非破坏操作；version 2 由 `tauri_plugin_sql` 在启动时应用。回退仅需不注册 version 2（列保留但代码不读写，无副作用）。
- **大纲对话解析失败**：沿用 `parseOutline` 失败重试 1 次的现有逻辑；若仍失败，status 显示错误、保留原大纲不覆盖写库（避免破坏已有大纲）。
