# Tavily 联网搜索 + 文案先行生成 设计

日期：2026-06-30
状态：待评审

## 1. 目标与背景

为「纸光幻演」新增基于 Tavily 的联网搜索能力，并把大纲生成重构为「先写完整文案 → 再按文案拆页」的两阶段流程。最终导出 PPT 时，文案随每页讲者备注一起导出。

核心需求：
- 设置项配置 Tavily API Key；未配置时不显示联网开关。
- 生成时提供「是否联网搜索」开关（仅当已配置 Key 时显示）。
- 联网搜索不是"搜一次就结束"：把 `tavily_search` 与 `tavily_extract` 注册为 LLM 工具，由模型在「写文案」阶段自主决定搜什么、搜几次、是否对某 URL 深挖全文，研究充分后再产出完整文案。
- 无论是否联网，大纲生成都走「先文案 → 后拆页」新流程。
- 导出时每页文案写入 pptx 讲者备注（speaker notes）。
- Tavily 有免费额度，需记录使用次数与消耗积分。

## 2. 架构概览

新增一个 **研究型 agent loop**：把两个 Tavily 端点封装为 Rust 命令并注册为 LLM 工具，模型在「文案」阶段多轮调用工具做调研，最终输出完整 markdown 文案；随后用现有 JSON 模式调用把文案拆成带 `notes` 的页面结构。

```
startOutline(projectId, topic, style, searchEnabled)
  ├─ [searchEnabled && key]  manuscript 阶段：chatAgent() 带 tavily 工具
  │     loop: chat(带 tools) → 解析 tool_calls → 执行 tavily_search/extract → 追加结果 → 下一轮
  │           直到无工具调用的最终回复（=完整文案 markdown）
  │     失败/不支持工具 → 降级 chatOnce() 无工具写文案
  ├─ [未开联网]              manuscript 阶段：chatOnce() 无工具写文案
  │   → updateProject(manuscript) + addMessage("已生成完整文案", reasoning)
  └─ outline 阶段（拆页）：chatOnce(splitOutlinePrompt, jsonMode=true) + 解析失败重试一次
      → parseOutline → 写 design_tokens/theme_css/style + slides(每页带 notes)
```

调用上限：**LLM ≤50 轮、工具调用 ≤20 次**，触顶则强制进入收尾（模型被要求停止调用工具并产出文案）。

### 涉及层

| 层 | 改动 |
|---|---|
| Rust (`lib.rs`) | 新增 `tavily_search`/`tavily_extract` 命令；扩展 `chat_stream` 支持工具调用（流式解析 OpenAI/Anthropic 双格式 tool_call） |
| DB (`migrations/006`) | `projects` 加 `manuscript`、`search_enabled` 两列 |
| 前端 lib | 新建 `src/lib/tavily.ts`（Tavily 调用 + 用量记录）；`chat.ts` 增 `tools`/`onToolCalls` 与 `chatAgent()` loop；`genStore.ts` 增 `manuscript` phase；`prompt.ts` 增文案/拆页提示词；`db.ts` 增字段与函数；`ppt.ts` 导出讲者备注 |
| UI | `Settings.vue`（Tavily Key + 用量）、`ProjectList.vue`（联网开关）、`Outline.vue`（文案面板 + 阶段标签） |

无新增 Rust 依赖（复用 `reqwest`+`rustls-tls`+`serde_json`+`futures-util`），无 capabilities 改动（新命令与 `list_models` 同级，纯命令）。

## 3. 数据库（migration 006）

新建 `src-tauri/migrations/006_add_manuscript_and_search.sql`：

```sql
ALTER TABLE projects ADD COLUMN manuscript TEXT;
ALTER TABLE projects ADD COLUMN search_enabled INTEGER NOT NULL DEFAULT 0;
```

并在 `lib.rs` `run()` 的 `migrations` vec 末尾追加 version 6 条目。

`src/lib/db.ts`：
- `Project` 接口加 `manuscript?: string | null`、`search_enabled?: number`。
- `createProject(title, topic, style, searchEnabled?)`：增第四参；INSERT 加 `search_enabled` 列（`searchEnabled ? 1 : 0`）。
- `updateProject` 的 `Partial<Pick<Project, …>>` 增加 `manuscript`、`search_enabled`。

旧项目（迁移前）：`manuscript=null`、`search_enabled=0`，打开/导出均兼容。

## 4. Rust 层

### 4.1 `tavily_search` 命令

```text
POST https://api.tavily.com/search
Header: Authorization: Bearer <api_key>
Body: { query, search_depth:"basic", topic:"general", include_answer:true, max_results:5, include_usage:true }
```

- 固定 `search_depth:"basic"`（1 积分/次，成本可控；不向 AI 暴露 depth 选择）。
- 返回 `TavilySearchResult { answer: String, results: Vec<TavilyResult>, credits: i64 }`，`TavilyResult { title, url, content }`。
- 每条 `content` 截断 ~1500 字，最多 5 条。
- `credits` 优先取响应 `usage.credits`；缺失则按本地规则估算（basic search = 1）。
- HTTP 非 2xx → `Err("HTTP {status}: {text}")`。响应缺 `results`/`answer` 不报错，按空处理。

### 4.2 `tavily_extract` 命令

```text
POST https://api.tavily.com/extract
Header: Authorization: Bearer <api_key>
Body: { urls, format:"markdown", extract_depth:"basic", include_usage:true }
```

- `urls` 为 `Vec<String>`，**调用侧已限制 ≤3 个/次**（前端 tavily.ts 校验，工具描述也声明上限）。
- 固定 `extract_depth:"basic"`（每成功 5 个 URL = 1 积分）。
- 返回 `TavilyExtractResult { results: Vec<{url, raw_content}>, failed: Vec<{url, error}>, credits: i64 }`。
- 每条 `raw_content` 截断 ~4000 字。
- `credits` 优先取响应 `usage.credits`；缺失则本地估算 `ceil(successful_urls / 5)`（basic）。
- 失败的 URL 计入 `failed` 不收费。

### 4.3 扩展 `chat_stream` 支持工具调用

`ChatConfig` 增加可选字段 `tools: Vec<ToolDef>`，`ToolDef { name: String, description: String, parameters: serde_json::Value }`（中性 JSON Schema）。

`ChatMessage` 增加可选字段：
- `tool_calls: Vec<ToolCall>`（role:"assistant" 时携带），`ToolCall { id, name, arguments: String }`（arguments 为 JSON 字符串）。
- `tool_call_id: Option<String>`（role:"tool" 时携带，content 为工具结果文本）。

**body 构造**：
- OpenAI：`tools` → `[{type:"function", function:{name,description,parameters}}]`；assistant 的 `tool_calls` 原样回填；role:"tool" → `{role:"tool", tool_call_id, content}`。`tool_choice` 设为 `"auto"`。
- Anthropic：`tools` → `[{name, description, input_schema: parameters}]`；assistant tool_use → `content:[{type:"tool_use", id, name, input: <parsed json>}]`；role:"tool" → 作为 user 消息 `content:[{type:"tool_result", tool_use_id, content}]`。注意 Anthropic 要求 tool_result 紧跟在对应 tool_use 之后，`anthropic_split` 按消息顺序构造即可（agent loop 保证顺序正确）。

**流式 tool_call 解析**（按 index 维护累积缓冲 `Vec<ToolCallAccum>`，每条 `{index, id, name, arguments_buf}`）：
- OpenAI：`choices[0].delta.tool_calls[]` → 按 `index` 对齐，`function.name` 非空则记录（首次），`function.arguments` 追加到 buf。`finish_reason:"tool_calls"` 或流结束时，把每个累积项封为 `ToolCall{arguments: arguments_buf}`。
- Anthropic：`content_block_start` 且 `content_block.type=="tool_use"` → 新增累积项（index 来自事件 sequence/index），记录 id/name；`content_block_delta` 且 `delta.type=="input_json_delta"` → `partial_json` 追加到对应项 buf；`content_block_stop` → 封项。
- 两种格式：`chat-chunk`（text_delta/delta.content）与 `chat-reasoning`（thinking）照旧。回合结束时，若有任意 tool_call，发 **`chat-tool-calls` 事件**（payload 为 `Vec<ToolCall>`），随后发 `chat-done`；无 tool_call 则仅 `chat-done`（最终文本回复，`chat-chunk` 已逐 token 发出）。

`cancel_chat` 不变（AbortSlot 中止整个流）。

### 4.4 命令注册

`invoke_handler` 增加 `tavily_search, tavily_extract`。无 capabilities 变更。

## 5. 前端

### 5.1 `src/lib/tavily.ts`（新建）

封装 Tavily 调用与用量记录，供 agent loop 与设置页共用。

```ts
export interface TavilyResult { answer: string; results: {title,url,content}[]; credits: number }
export interface TavilyExtract { results: {url,raw_content}[]; failed: {url,error}[]; credits: number }

export async function tavilySearch(query: string): Promise<TavilyResult>      // invoke("tavily_search", {apiKey, query})
export async function tavilyExtract(urls: string[]): Promise<TavilyExtract>   // invoke("tavily_extract", {apiKey, urls})，内部 urls.slice(0,3)
export async function getTavilyKey(): Promise<string | null>                  // getSetting("tavily_api_key")

// 用量（settings 表 key="tavily_usage"，JSON 字符串）
export interface TavilyUsage { searchCalls: number; extractCalls: number; extractUrls: number; credits: number }
export async function getTavilyUsage(): Promise<TavilyUsage>
export async function recordTavilySearch(credits: number): Promise<TavilyUsage>   // searchCalls+1, credits+=credits
export async function recordTavilyExtract(credits: number, urls: number): Promise<TavilyUsage> // extractCalls+1, extractUrls+=urls, credits+=credits
```

`apiKey` 由调用方传入（agent loop 从 `getTavilyKey()` 取，设置页测试也取）。`recordTavily*` 内部读-改-写 settings（非原子，但单用户桌面场景可接受）。

### 5.2 `src/lib/chat.ts` 扩展

```ts
export interface ToolDef { name: string; description: string; parameters: object }
export interface ToolCall { id: string; name: string; arguments: string }

export async function chat(
  messages: ChatMsg[],
  onChunk, onReasoning?, jsonMode = false,
  opts?: { tools?: ToolDef[]; onToolCalls?: (calls: ToolCall[]) => void }
): Promise<{ toolCalls: ToolCall[] | null }>
```

`ChatMsg` 增加可选 `tool_calls?: ToolCall[]`（assistant）与 `tool_call_id?: string`（role:"tool"）。`invoke("chat_stream", {config, messages, tools?})` 传 `tools`（Rust `ChatConfig` 新字段）。`chat` 订阅 `chat-tool-calls` 事件收集本轮回合的工具调用，resolve 时返回。

**对现有调用的影响**：`chat` 返回类型由 `Promise<void>` 变为 `Promise<{toolCalls: ToolCall[] | null}>`。现有不传 `tools` 的调用（`startSlide`/`sendChat`/`selfCheckSlide`/`sendOutlineChat` 与 `chatOnce`）均以 `await chat(...)` 形式调用、忽略返回值，且未传 `tools` 时 `toolCalls` 恒为 `null`，故无需改动这些调用点；仅 `chatOnce` 内部仍只取 `full` 文本，签名不变。

新增 `chatAgent()`：

```ts
export async function chatAgent(
  initMessages: ChatMsg[],
  tools: ToolDef[],
  execTool: (call: ToolCall) => Promise<string>,   // 执行工具，返回结果文本
  onChunk, onReasoning?, onToolActivity?: (line: string) => void,
  limits = { maxLlmRounds: 50, maxToolCalls: 20 }
): Promise<string>   // 最终文本回复（= 完整文案）
```

循环：
1. 每轮开始 `genState.content = ""`（只保留最终文案；reasoning 跨轮累积不清）。
2. `await chat(messages, onChunk, onReasoning, { tools, onToolCalls })`。
3. 检查 `genState.cancelled` → 中断。
4. 若 `toolCalls` 非空且未超 `maxToolCalls`：
   - 把 assistant 消息（含 `tool_calls`）append 进 `messages`。
   - 对每个 call 调 `execTool(call)`，结果作为 `{role:"tool", tool_call_id, content}` append。
   - 通过 `onToolActivity` 上报研究轨迹（如 `[🔍 搜索] {query} · +{n} 积分 → {k} 条`、`[📄 提取] {url} · +{n} 积分`），并追加到 `genState.reasoning`。
   - 轮计数 +1，工具计数 += call 数；触顶则向 messages 追加一条 system 指令"已达上限，请停止调用工具并直接产出最终文案"。
   - 回到步骤 2。
5. 若 `toolCalls` 为空 → 当前 `genState.content`（`cleanHtml` 不需要，文案是 markdown，但若有代码块包裹可剥离）即为最终回复，return。

`execTool` 在 `genStore.ts` 中定义，分发到 `tavilySearch`/`tavilyExtract`：
- `tavily_search`：解析 `arguments.query`，调 `tavilySearch(query)`，`recordTavilySearch(credits)`，返回格式化文本（answer + 各 result 的 title/url/content）。
- `tavily_extract`：解析 `arguments.urls`（数组），调 `tavilyExtract(urls)`，`recordTavilyExtract(credits, results.length)`，返回各 raw_content。
- 工具执行异常 → 返回 `"[工具错误] {msg}"` 文本，让模型自行处理（不中断 loop）。

### 5.3 `src/lib/genStore.ts`

`GenPhase` 增 `"manuscript"`。`startOutline` 改签名：

```ts
export async function startOutline(projectId, topic, style?, searchEnabled = false)
```

流程（详见 §2）：
1. resetBuffers；若 `searchEnabled`，`getTavilyKey()` 取 key；无 key 则 `searchEnabled=false`（status 提示"未配置 Tavily Key，离线生成"）。
2. **manuscript** phase：
   - `searchEnabled` → `chatAgent(msgs, tavilyTools, execTool, onChunk, onReasoning, onToolActivity)`，`tavilyTools` 工具定义见 §5.4。**首轮 chat 报错（模型不支持工具/格式不支持）→ catch 后降级**为 `chatOnce(msgs, onReasoning)`（无工具），status 提示"联网搜索不可用，改为离线生成"。
   - 否则 → `chatOnce(msgs, onReasoning)`。
   - 成功后 `genState.content` 为完整文案 → `updateProject(projectId, { manuscript })` + `addMessage("已生成完整文案（{字数} 字）", null, genState.reasoning)`。
   - resetBuffers（清 content/reasoning，进下一阶段）。
3. 阶段间检查 `genState.cancelled`；取消则不写 manuscript。
4. **outline** phase（拆页，复用现有逻辑）：`chatOnce([{system},{user: splitOutlinePrompt(topic, manuscript, style)}], onReasoning, true)` + 解析失败重试一次 → `parseOutline` → `updateProject(design_tokens/theme_css/style)` + 覆盖写 slides（每页 `outline` JSON 含 `notes`）+ `addMessage("已生成大纲（N 页）", reasoning)`。
5. 错误/取消不写半截数据（manuscript 仅成功后落库；slides 仅解析成功后覆盖）。

`sendOutlineChat`（大纲对话修改）：提示词补一句"每页保留 `notes` 并与正文要点对齐"（不重跑文案，属可接受范围；如文案已存在，把 manuscript 一并注入提示词供参考）。

### 5.4 `src/lib/prompt.ts`

新增 `manuscriptPrompt(topic)`：
- 系统约束：你是 PPT 文案策划，先充分调研再撰写，最终消息只输出一份完整 markdown 文案（不输出调研过程的工具调用摘要）。
- 要求：按 8–20 页分章节，每章节有标题 + 该页要讲的内容（要点/数据/案例/过渡语），专业充实、紧扣主题、适合宣讲。
- 有联网工具时：要求用工具查证关键事实/数据/最新进展，并在文案中以 `[来源: {title}]` 标注来源；不确定处不要编造。
- 工具定义（随 manuscript 调用注入）：
  - `tavily_search`：参数 `{query: string}`，描述"用关键词联网搜索，返回摘要答案 + 多条结果（title/url/content）。需要查证事实、数据、最新信息时调用。"
  - `tavily_extract`：参数 `{urls: string[]}`（≤3），描述"提取指定网页的完整内容（markdown）。对某个搜索结果想看全文时调用。"

现 `outlinePrompt` 改名 `splitOutlinePrompt(topic, manuscript, style)`：
- 注入 manuscript 作为内容源："以下是完整文案，请据此拆分 PPT 页面：\n{manuscript}\n"。要求每页要点对应文案相应章节，保证内容覆盖。
- 每页含 `notes`：该页讲稿片段（从文案摘取，演讲用，1–3 句或对应要点），写入 JSON。
- JSON 结构示例加 `notes`：`{"title":"","kind":"cover","bullets":[],"notes":""}`。
- 其余（design_tokens/theme_css 铁律、style 选择、页数自由判断）不变。

`OutlineSlide` 接口加 `notes?: string`。`parseOutline` 不变（顺带带上 notes）。

### 5.5 `src/lib/ppt.ts`（导出讲者备注）

`exportPptx` 每页循环：`addImage` 后，解析 `slide.outline`（JSON），若 `notes` 非空则 `s.addNotes(ol.notes)`。旧项目无 notes → 无备注，行为兼容。

## 6. 设置项与用量记录（`Settings.vue`）

- 新增「联网搜索 (Tavily)」区：
  - API Key 密码框 + 显隐眼睛（复用 Icon）。
  - 「保存」按钮 → `setSetting("tavily_api_key", value)`，保存后刷新 `tavilyReady`（供 ProjectList 同源读取，但因各页面独立 load，ProjectList 自行 onMounted 读取即可）。
  - 「测试」按钮 → `tavilySearch("test query")`，弹窗报成功（显示返回结果数与 +1 积分）或失败（HTTP 错误信息）。
  - 累计用量行：`getTavilyUsage()` → 显示"搜索 {searchCalls} 次 · 提取 {extractCalls} 次（{extractUrls} URL）· 已用 {credits} 积分"。每次测试成功也累加。提供「清零」按钮（写回零值）。
- Key 明文存 `settings` 表（与现有 AI key 一致）。

## 7. UI

### 7.1 `ProjectList.vue`
- onMounted 读 `getTavilyKey()` → `tavilyReady`。
- 新建项目表单：仅当 `tavilyReady` 时显示「联网搜索」开关（checkbox，默认开）；`create()` 把 `searchEnabled` 传给 `createProject`。未配置 key 时表单不显示该项，等价离线。

### 7.2 `Outline.vue`
- `load()` auto-start 调 `startOutline(projectId, topic, style, !!project.search_enabled)`。
- 流式区标签按 phase 切换：`manuscript` →「文案（生成中）」；`outline` →「正文（JSON 流式）」。manuscript 阶段的 `genState.content` 直接展示（markdown 文本，不 cleanHtml）。
- reasoning 区（`<pre>`）同时展示研究轨迹（工具活动已追加进 `genState.reasoning`）。
- 完成后新增折叠 `<details>`「完整文案」：读 `project.manuscript`（reload 后从库取），非运行时展示。

### 7.3 `Editor.vue`
- 无需改动。`notes` 随 `slide.outline` JSON 走，导出自动读取。

## 8. 错误与边界

- **Tavily 工具执行失败**（HTTP 错/解析错）：`execTool` 返回 `[工具错误]` 文本，loop 继续，模型自行决定重试或放弃。
- **模型不支持工具调用**（首轮 chat 报错）：降级为无工具 `chatOnce` 写文案，status 可见提示。
- **未配置 Tavily Key 但开了联网**：`searchEnabled` 被强制 false，status 提示"未配置 Tavily Key，离线生成"。
- **触顶上限**（50 轮 / 20 次工具）：追加 system 指令强制收尾，不报错。
- **文案/拆页 LLM 失败**：致命，status 显示错误，不写半截（manuscript 仅成功落库；slides 仅解析成功覆盖）。
- **取消**：AbortSlot 中止当前流；轮间检查 `genState.cancelled`；工具执行中取消会在当前工具返回后停止。
- **全局锁**：manuscript/search 阶段 `running=true`，阻塞其它项目（同现状）。
- **旧项目**：manuscript=null、search_enabled=0，打开/导出/重新生成均兼容。
- **多 AI 格式**：OpenAI 与 Anthropic 都支持工具调用，Rust 双格式翻译（§4.3）。

## 9. 积分规则与记录

Tavily 计费（本地 fallback 估算，优先用响应 `usage.credits`）：

| 操作 | depth | 积分 |
|---|---|---|
| Search | basic（固定） | 1 / 次 |
| Search | advanced | 2 / 次（本设计不使用） |
| Extract | basic（固定） | 1 / 每 5 个成功 URL（按 `ceil(urls/5)`） |
| Extract | advanced | 2 / 每 5 个成功 URL（本设计不使用） |

固定 basic depth 以控制成本与可预测性；不向 AI 暴露 depth 参数。

用量记录（§5.1 `TavilyUsage`，存 `settings.tavily_usage`）：累计 `searchCalls` / `extractCalls` / `extractUrls` / `credits`。设置页显示，可清零。每次工具调用成功后由 `execTool` 经 `recordTavily*` 累加。

## 10. 非目标（YAGNI）

- 不做按项目维度的用量统计（仅全局累计）。
- 不暴露 search_depth / extract_depth 给 AI 或用户（固定 basic）。
- 不做 Tavily Crawl/Map/Research 端点。
- 不做联网搜索的结果缓存。
- 不重做 `sendOutlineChat` 的文案再生（仅大纲层修改）。
- 导出文案仅走讲者备注，不另出 .md 文件。
