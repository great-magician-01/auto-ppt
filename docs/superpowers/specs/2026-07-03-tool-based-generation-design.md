# 工具调用驱动的生成流程设计

**日期**：2026-07-03
**状态**：已确认设计，待审阅
**作者**：brainstorming 会话产出

## 1. 背景与动机

当前 AutoPPT 的生成流程依赖"模型返回一大段 JSON/HTML 文本，前端解析"：

- **大纲拆分 / 大纲对话**：模型返回 `{design_tokens, theme_css, slides, style}` JSON。前端 `parseOutline`（去代码块 + 大括号配平提取）解析，失败重试一次。
- **单页 HTML / 自检 / 单页对话**：模型返回完整 HTML 文档文本，`cleanHtml` 去围栏后流式进 iframe。
- **文案**：模型返回 markdown 文案文本。

两个痛点：

1. **对话框显示奇怪**：生成中 `genState.content` 装的是原始 JSON / markdown 源码，`Outline.vue` 把它原样塞进 `<pre>`——用户看到 `{"design_tokens":…}` 这种 JSON 语法文本逐字流出，解析成功瞬间又突变到结构化卡片。文案阶段看到的是带 `#`、`**` 的原始 markdown 源码。用户感知到的"AI 回复"就是这些原始结构化文本。
2. **Anthropic JSON 风险**：OpenAI 有 `response_format:json_object` 可强制 JSON，但 Anthropic 无此能力，纯靠提示词约束——存在不返回 JSON 或返回畸形 JSON 的风险。

工具调用基础设施已存在却未被充分利用：`chat()` 支持 `tools`/`onToolCalls`，Rust 累积 tool_calls（OpenAI 按 index、Anthropic 按 content_block）并在回合末发 `chat-tool-calls` 事件，`chatAgent()` 驱动多轮循环。目前只有文案联网调研阶段用了 `chatAgent` + Tavily 工具。

## 2. 目标与非目标

**目标**

- 所有结构化产物（文案 / 大纲 / 单页 HTML / 自检 HTML）改为通过**工具调用**产出，模型回复用**自然语言**。
- 对话框只显示自然语言回复（markdown 渲染）+ 可折叠工具调用卡片，不再出现原始 JSON/HTML 源码。
- 每个环节**强制**调用其指定工具，否则不允许通过——靠工程化保证（API Schema 强校验 + `tool_choice` 强制 + 业务校验 + 重试 + 硬报错）。
- 消灭 Anthropic 不返回 JSON 的风险（结构化输出由 API 工具 Schema 保证）。
- 保留 HTML / 文案的逐 token 实时预览（流式推送工具参数）。

**非目标**

- 不改生成流程的阶段划分（仍为 manuscript-first：文案→拆页→逐页→自检）。
- 不改 `projects` / `slides` 表结构（产物落库位置不变）。
- 不做细粒度工具（`add_slide`/`update_slide` 逐页增删改）——粗粒度工具已满足诉求，复杂度收益不划算。
- 不改导出（ppt.ts）、预览缩放（SlidePreview）、多 AI 配置等无关子系统。

## 3. 总体架构

### 核心转变

每个生成阶段从"模型返回大段 JSON/HTML 文本、前端解析"变成"模型用自然语言对话（流式进对话框）+ 调用指定工具提交结构化产物"。编排层强制每阶段必须调用其工具，校验后落库，回填工具结果。**不再有任何阶段解析自由文本 JSON。**

### `genState` 拆分

让对话框与预览各取所需：

- `genState.content` = 模型**自然语言**回复流（始终人话，进 ChatPanel）。原本塞原始 JSON/HTML 的用法全部废除。
- `genState.artifact`（新增）= 工具参数里提取的**结构化产物**流（html / 文案字符串，进 iframe / 文案面板）。
- 大纲嵌套结构不进 artifact 流式预览，工具落地时整体渲染卡片（与现状一致，无回归）。

### 删除的死代码

- `parseOutline` / `extractFirstJsonObject`（不再解析自由 JSON）。
- `json_mode` 参数与 Rust 的 `response_format` 分支（唯一用户大纲拆页改走工具后，jsonMode 全无用武之地）。
- `cleanHtml` 保留作安全网（模型可能在工具字符串参数内误加围栏）。

## 4. 工具表面与 Schema

四个工具，每个产物一个，参数即完整载荷。**全部启用 OpenAI `strict:true`**（要求 `additionalProperties:false` + 全字段进 `required`），Anthropic 用原生 `input_schema` 强校验——结构化输出由 API 保证，这正是消灭"Anthropic 不返回 JSON"风险的关键。

| 工具 | 参数（Schema 摘要） | 强制用于 | 实时预览 |
|---|---|---|---|
| `write_manuscript` | `{content: string}` | 文案阶段（收尾轮） | `content`→文案面板逐字 |
| `commit_outline` | `{design_tokens:{...9 字段}, theme_css:string, slides:[{title,kind,bullets[],notes}], style:string}` | 拆页 / 大纲对话 | 落地后渲染卡片 |
| `write_slide_html` | `{html: string}` | 单页生成 / 单页对话 | `html`→iframe 逐 token |
| `apply_selfcheck` | `{html: string}` | 自检 | `html`→iframe 逐 token |

**Schema 设计要点**

- `commit_outline.style` 设为**必填 string**（非自动模式填 `""`），仅为满足 strict 模式"无可选字段"约束；语义不变。
- `slides[].notes` 由"可选"改**必填**（strict 要求），与现有"每页必须有 notes"提示一致。
- `design_tokens` 为对象，9 个字段（primary/accent/background/surface/text/textMuted/fonts/titleSize/bodySize）全必填、`additionalProperties:false`。
- 单字段工具（manuscript/slide_html/selfcheck）的流式提取最简单：参数形如 `{"html":"…"}`，`html` 是首个也是唯一字段，容错提取首个字符串值即可，无需完整 JSON 解析。
- 工具结果（`tool_result`）统一返回简短中文确认（如"已保存 12 页大纲"），便于模型在重试/多轮场景理解状态。

**每阶段强制工具映射**：文案→`write_manuscript`（调研轮 auto，收尾轮强制）；拆页/大纲对话→`commit_outline`（强制）；单页/单页对话→`write_slide_html`（强制）；自检→`apply_selfcheck`（强制）。

## 5. 编排原语

两个原语，共享"校验→落库→回填→重试"模式。

### `runToolPhase`（单发）

用于拆页 / 大纲对话 / 单页 / 自检 / 单页对话 / 无搜索文案。

```
入参：requiredTool, tools, systemPrompt, userPrompt, execTool(call)->result, opts{toolChoice, maxRetries=1}
流程：
  1. messages = [system, user]
  2. chat({tools:[requiredTool], toolChoice: 强制 requiredTool})  // 一轮到位
     · chat-chunk → genState.content（自然语言，进对话框，实时）
     · chat-tool-args → 提取大字符串字段 → genState.artifact（HTML/文案，进预览，实时）
  3. 回合末收 chat-tool-calls（含被强制的 requiredTool 调用）
  4. 校验：API 已按 Schema 强校验 + 业务规则
     · 合法 → execTool 落库，回填 tool_result("已保存")；模型自然语言文本存为 assistant 消息
     · 不合法 → 回填 tool_result(错误说明) + system"请重新调用 X 修正：…"，重试一次（再强制 toolChoice）
     · 仍失败 → 抛错，不写半截数据
  5. 单发阶段拿到产物即结束，不再请求模型（无需消费 tool_result，不会 400）
```

### `chatAgent`（多轮，仅联网文案）

新增 `commitTool` 参数（=`write_manuscript`）。

- 调研轮 `toolChoice=auto`；模型调 `tavily_*`→执行继续；模型调 `commitTool`→`execTool` 落库、返回 NL 收尾。若同一轮既调 `commitTool` 又调研究工具，全部执行（配额内），`commitTool` 落库后即返回 NL 收尾。
- 模型纯文本无调用→追加 system"请调用 write_manuscript 提交文案"并下一轮强制 `commitTool`。
- 触顶轮数/工具数→强制 `commitTool` 收尾轮，仍不调则抛错。
- **这消除了旧逻辑"模型只产工具调用无文本→throw"的边界**——文案就是 `write_manuscript` 调用本身。
- 取消：`isCancelled` 在轮间/工具间检查（沿用现有）。

### `execTool` 落库逻辑（替换 genStore 现有内联持久化）

- `write_manuscript`：`args.content` → `updateProject({manuscript})`；label = "N 字"。
- `commit_outline`：`args` → `updateProject({design_tokens, theme_css, style})` + 删旧插新 slides；label = "N 页"。
- `write_slide_html`：`args.html` → `upsertSlide({html_content})`；label = "第 N 页"。
- `apply_selfcheck`：`args.html` → 主题指纹校验通过则 `upsertSlide`，否则还原原页；label = "自检改写"。

### 业务校验规则（API Schema 之外）

- `commit_outline`：`slides.length >= 1`、每页有 title。
- `write_slide_html` / `apply_selfcheck`：含 `.slide` 且为完整 `<html>` 文档。
- `apply_selfcheck`：`themeFingerprint(html)` 与原页一致（沿用现有函数）。

## 6. 各阶段数据流

| 阶段 | 工具/强制 | 流式 | 落库 |
|---|---|---|---|
| 文案·无搜索 | `write_manuscript` 强制 | content→文案面板逐字 | `projects.manuscript` |
| 文案·联网 | `chatAgent`，`write_manuscript` 收尾 | 同上 | 同上 |
| 拆页 | `commit_outline` 强制 | NL 进对话框；卡片落地后渲染 | `projects.{design_tokens,theme_css,style}` + 覆盖写 `slides` |
| 大纲对话 | `commit_outline` 强制 | 同上 | 同上（校验失败不写，等同旧"解析失败保留原大纲"） |
| 单页生成 | `write_slide_html` 强制 | html→iframe 逐 token | `slides.html_content` → `maybeSelfCheck` |
| 自检 | `apply_selfcheck` 强制 | html→iframe 逐 token | 校验主题指纹通过才写，否则还原原页 |
| 单页对话 | `write_slide_html` 强制（debug 模式元素作用域） | 同单页 | `slides.html_content` |

**文案复用**：`projects.manuscript` 已存在则跳过文案阶段直接拆页（沿用现有）。

**批量化噪音控制**：`startAll` 逐页生成 20 页会有 20 条 NL。提示词要求"一句话设计思路"；落库消息优先用模型 NL，为空则回退生成的摘要"第 N 页 · 版式 X · M 要点"（沿用现有格式）。交互式单页对话保留完整 NL。

**自检阶段对话框静默修复**：`Editor.vue` 的 `runningOnCurrent` 现纳入 `selfcheck` 阶段，自检时对话框也显示 NL/思考（旧 bug 顺手修）。

## 7. Rust 改动

### 7.1 `ChatConfig` 增 `tool_choice`（中性枚举，Rust 按格式翻译）

```rust
#[derive(Deserialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ToolChoice { Auto, Required, Tool { name: String } }
```

- OpenAI：`Auto`→`"auto"`，`Required`→`"required"`，`Tool{name}`→`{type:"function",function:{name}}`
- Anthropic：`Auto`→`{type:"auto"}`，`Required`→`{type:"any"}`，`Tool{name}`→`{type:"tool",name}`

仅在 `tools` 非空时写入 body。这是"每环节必须调用"的工程化强制力来源。

### 7.2 新增 `chat-tool-args` 增量事件（纯增量，与现有 `chat-tool-calls` 互补）

- OpenAI：每个 `delta.tool_calls[].arguments` 片段→emit `{name, delta}`（首个片段带 id/name）。
- Anthropic：`content_block_start(tool_use)`→emit `{name, delta:""}`；每个 `input_json_delta.partial_json`→emit `{name, delta}`。
- 现有 `chat-tool-calls`（回合末完整调用）**不变**，仍用于校验/执行。
- 前端：`chat-tool-args` 喂实时预览，`chat-tool-calls` 喂校验落库——职责分离。

### 7.3 删除 `json_mode`

移除 `ChatConfig.json_mode` 字段与 OpenAI body 的 `response_format` 分支；前端 `chat()`/`chatOnce()` 去掉 `jsonMode` 参数。Anthropic 侧本就无此分支。

### 7.4 工具消息翻译不变

`openai_messages`/`anthropic_split` 已正确处理 `tool_calls` + `role:"tool"`（含连续 tool_result 合并）。重试路径回填 `tool_result` 复用现有翻译，**无需改动**。

### 7.5 OpenAI strict 模式

工具定义增 `strict:true` 字段（OpenAI 分支注入，Anthropic 不需要）。Schema 已按 strict 约束设计（`additionalProperties:false` + 全 `required`）。

## 8. 前端展示与对话框

### 8.1 `ChatPanel.vue`（对话框，核心 UX 落点）

- **assistant 消息 markdown 渲染**：新增 `marked` + `DOMPurify`（小而标准，防注入），替换现在 `{{ m.content }}` 纯文本。`content` 现在是自然语言，渲染后 `**加粗**`/列表/标题正常显示。user 消息保持纯文本。
- **工具调用卡片**：assistant 消息下方新增可折叠 `<details>` 卡片（`m.tool_call` 存在时）。一行折叠态展示工具摘要，展开看工具名 + 参数概要。标签映射：
  - `write_manuscript` → `📝 文案 · 3580 字`
  - `commit_outline` → `🗂 大纲 · 12 页`
  - `write_slide_html` → `🎨 单页 HTML · 第 3 页`
  - `apply_selfcheck` → `🔍 自检改写`
- **思考**：沿用现有 `<details>` 折叠 reasoning，不变。
- 流式"思考中"卡片不变（仍由 `genState.reasoning` 喂）。

### 8.2 `messages.tool_call` 新列（migration 007）

`ALTER TABLE messages ADD COLUMN tool_call TEXT;`（JSON `{name,label}` 或 null）。落库时由 `execTool` 生成 label 一并写入。旧消息 `null` → 无卡片，正常显示。

### 8.3 `genStore` / `chat.ts`

- `genState` 增 `artifact: string`（工具参数提取的产物流）；`resetBuffers` 一并清。
- `chat()` opts 增 `toolChoice` + `onToolArgs`（订阅 `chat-tool-args`）；去 `jsonMode`。
- `chatOnce()` 去 `jsonMode`（拆页改走 `runToolPhase` 后当前无调用方，保留为无工具便捷封装供后续复用）。
- `chatAgent()` 增 `commitTool` 参数与收尾语义。
- 新增 `runToolPhase(...)` 原语 + `execTool` 分发表（按工具名→落库）。
- 新增 `extractStringArg(partialJson)`：容错提取首个字符串值（单字段工具的 html/content），unescape JSON 字符串转义（`\"` `\\` `\/` `\b` `\f` `\n` `\r` `\t` `\uXXXX`）；`commit_outline` 不提取（嵌套）。
- `cleanHtml` 保留作安全网，施于 `artifact`。

### 8.4 `Outline.vue`

- **删除** `.stream` 里 `{{ genState.content }}` 原始 JSON `<pre>`——这是"奇怪"的根源。
- 生成中：显示 ChatPanel（NL 流）+ 卡片位"正在生成大纲…"占位。
- 完成后（`watch(running)`）：重读 slides → 渲染 `.outline-cards`（现有逻辑）。
- `outlineView` computed 里 `parseOutline(genState.content)` 删除（不再有原始 JSON 可解析，卡片来自 DB）。
- 文案面板：生成中读 `genState.artifact`（原读 `content`）；完成读 `project.manuscript`。

### 8.5 `Editor.vue`

- `currentHtml`：当前页 slide/chat/selfcheck 期间 → `cleanHtml(genState.artifact)`（原 `genState.content`）；空则回退 `cur.html_content`。
- `runningOnCurrent` 纳入 `selfcheck`（修自检对话框静默 bug）。
- `generatingIdx` 不变（已含 selfcheck）。

## 9. 错误处理与强制

### 强制调用五层兜底（"靠工程化"的落点）

1. **API Schema 强校验**（OpenAI `strict:true` / Anthropic `input_schema`）—保证形状。
2. **`tool_choice` 强制**—保证当轮必调指定工具。
3. **业务规则校验**—slides 非空 / html 含 `.slide` / 主题指纹一致。
4. **重试一次**—校验失败回填 `tool_result(错误)` + system 重申，再强制 `tool_choice`。
5. **硬报错**—仍失败→throw，不写半截数据，UI 显示错误状态。

### 取消 / 不写半截数据（沿用现有原则）

- `execTool` 只在回合末校验通过后执行，cancel 在此之前中断则不落库。
- 自检 cancel→还原原页（现有逻辑保留）。
- `chatAgent` 轮间/工具间检查 `isCancelled`。
- 各 `start*`/`send*` 保留 `genState.cancelled` 检查点。

## 10. 测试

无测试框架，人工验证矩阵：

- **双格式**（DeepSeek/OpenAI 兼容 + Anthropic）× 各阶段（文案/拆页/大纲对话/单页/自检/单页对话）。
- **强制调用**：正常流程工具被调且落库正确。
- **失败注入**：构造校验失败→确认重试一次后报错、无半截数据。
- **流式**：HTML/文案逐 token；大纲卡片落地后出现。
- **取消**：各阶段中途取消→无半截。
- **旧项目**：已有 manuscript 跳过文案直接拆页；旧 messages 无 tool_call→无卡片正常。
- **类型检查**：`npm run build`（vue-tsc）通过。

## 11. 迁移与兼容

- `007_add_tool_call_to_messages.sql`：加 `messages.tool_call` 列。无 projects/slides schema 变更。
- 旧数据兼容：`tool_call=null`→无卡片；`projects.manuscript` 复用如故。
- 死代码清理：删 `parseOutline`/`extractFirstJsonObject`/`json_mode`；`cleanHtml` 保留。

## 12. 风险

- 部分 OpenAI 兼容小厂对 `strict`/`tool_choice` 支持不完整：`tool_choice` 不被支持时校验+重试+硬报错兜底；`strict` 导致 400 时降级为不带 `strict` 重试（Schema 仍由我方业务校验兜底）；Settings 提示"建议使用支持工具调用的模型"。
- 大 tool arg（整页 HTML/长文案）流式：已验证单字段提取可行。
- forced `tool_choice` 下模型可能先输出长文本→提示词约束"一句话设计思路"。

## 13. 涉及文件清单

**Rust**：`src-tauri/src/lib.rs`（ChatConfig + tool_choice 翻译 + chat-tool-args 事件 + 删 json_mode + strict）、`src-tauri/migrations/007_add_tool_call_to_messages.sql`（新增）。

**前端核心**：`src/lib/chat.ts`（chat/chatOnce/chatAgent + ToolChoice + runToolPhase）、`src/lib/genStore.ts`（全部阶段重写 + genState.artifact + execTool）、`src/lib/prompt.ts`（四个工具定义 + 各提示词改为"调用工具"+ 删 parseOutline/extractFirstJsonObject）。

**前端展示**：`src/components/ChatPanel.vue`（markdown + 工具卡片）、`src/pages/Outline.vue`（删原始 JSON pre + 读 artifact）、`src/pages/Editor.vue`（currentHtml 读 artifact + selfcheck 纳入 runningOnCurrent）。

**依赖**：`package.json` 增 `marked` + `dompurify`。
