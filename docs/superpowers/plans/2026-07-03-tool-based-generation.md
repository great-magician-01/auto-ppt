# 工具调用驱动的生成流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把大纲/HTML/文案/自检的返回从"自由文本 JSON/HTML 解析"改为"自然语言回复 + 工具调用产出结构化产物"，每环节强制调用指定工具，消灭 Anthropic 不返回 JSON 的风险，并保留逐 token 实时预览。

**Architecture:** `genState` 拆 `content`(自然语言进对话框) / `artifact`(工具参数提取的产物流进预览) 双流。四个工具 `write_manuscript` / `commit_outline` / `write_slide_html` / `apply_selfcheck` 走 OpenAI `strict`+`tool_choice` 强制 / Anthropic `input_schema`+`tool_choice` 强制。Rust 增 `tool_choice` 翻译与 `chat-tool-args` 流式事件；`runToolPhase` 单发原语 + `chatAgent` 的 `commitTool` 收尾驱动各阶段；校验+重试+硬报错五层兜底；ChatPanel markdown 渲染 + 工具卡片；migration 007 加 `messages.tool_call`。

**Tech Stack:** Tauri 2 / Rust（reqwest + rustls SSE）/ Vue 3 `<script setup>` + TS / SQLite（@tauri-apps/plugin-sql）/ 新增 `marked` + `dompurify`。

## Global Constraints

- **无测试框架**：项目无 test 脚本/依赖（CLAUDE.md）。每个任务的"测试周期"= 类型检查 + 纯函数 sanity 脚本 + `npm run tauri dev` 手动验证，**不引入 Vitest 等框架**。
- **UI 与提示词一律中文**（CLAUDE.md）。
- **画布常量** `SLIDE_W=1920` / `SLIDE_H=1080` 不变（prompt.ts）。
- **TLS**：`reqwest` 保持 `rustls-tls` + `stream` feature（CLAUDE.md）——改 Cargo.toml 时不得换默认 features。
- **每个 commit 必须通过类型检查**：TS 改动后 `npx vue-tsc --noEmit`；Rust 改动后 `cargo check`（在 `src-tauri/` 下）。
- **不写半截数据**：`execTool` 只在回合末校验通过后执行；cancel/错误不落库（沿用现有原则）。
- **每个 tool_call_id 必须有匹配的 tool 结果**（重试路径需回填 `tool_result`）。

## File Structure

**新建**
- `src-tauri/migrations/007_add_tool_call_to_messages.sql` — `messages.tool_call` 列。
- `src/lib/toolUtils.ts` — 纯函数 `extractStringArg` / `toolLabel`（无 Vue/DB 依赖，可独立校验）。
- `scripts/verify-tool-utils.ts` — `extractStringArg` sanity 脚本（`npx tsx` 运行）。

**重写**
- `src-tauri/src/lib.rs` — `ToolChoice` 枚举 + `ChatConfig.tool_choice` + 翻译 + `chat-tool-args` 事件 + `ToolDef.strict` + 删 `json_mode`。
- `src/lib/chat.ts` — `ToolChoice` 类型 / `chat()` 增 `toolChoice`+`onToolArgs` / `chatAgent` 增 `commitTool` 收尾 / 删 `jsonMode`。
- `src/lib/genStore.ts` — `genState.artifact` / `runToolPhase` 原语 / 全部阶段改工具调用。
- `src/lib/prompt.ts` — 四个工具定义 + 各提示词改为"调用工具" + 删 `parseOutline`/`extractFirstJsonObject`。
- `src/components/ChatPanel.vue` — markdown 渲染 + 工具卡片。
- `src/pages/Outline.vue` — 删原始 JSON `<pre>` / 读 `artifact`。
- `src/pages/Editor.vue` — `currentHtml` 读 `artifact` / `runningOnCurrent` 纳入 selfcheck。

**依赖**：`package.json` 增 `marked` + `dompurify`。

---

## Task 1: Migration 007 + db.ts 支持 tool_call

**Files:**
- Create: `src-tauri/migrations/007_add_tool_call_to_messages.sql`
- Modify: `src-tauri/src/lib.rs`（注册 migration version 7）
- Modify: `src/lib/db.ts:38-47,157-169`（Message 接口 + addMessage）

**Interfaces:**
- Produces: `Message.tool_call?: string | null`；`addMessage(projectId, role, content, slideId?, reasoning?, tool_call?)`（第 6 参可选，现有 5 参调用方仍编译通过）。

- [ ] **Step 1: 创建 migration 文件**

`src-tauri/migrations/007_add_tool_call_to_messages.sql`:
```sql
-- 工具调用卡片：assistant 消息携带的工具调用摘要 JSON {name,label}；null 表示无工具调用
ALTER TABLE messages ADD COLUMN tool_call TEXT;
```

- [ ] **Step 2: 在 lib.rs 注册 migration**

在 `src-tauri/src/lib.rs` 的 `run()` 函数 `migrations` vec 末尾（version 6 之后）追加：
```rust
        tauri_plugin_sql::Migration {
            version: 7,
            description: "add tool_call to messages for tool-call card",
            sql: include_str!("../migrations/007_add_tool_call_to_messages.sql"),
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
```

- [ ] **Step 3: db.ts Message 接口加 tool_call**

`src/lib/db.ts` 第 38-47 行 `Message` 接口，在 `reasoning` 后加：
```ts
export interface Message {
  id?: number;
  project_id: number;
  slide_id?: number | null;
  role: ChatRole;
  content: string;
  /** 思考过程（仅助手完成消息可能附带，由生成/对话结束时回填） */
  reasoning?: string | null;
  /** 工具调用卡片摘要 JSON {name,label}；仅助手消息，工具调用产物阶段回填 */
  tool_call?: string | null;
  created_at?: string;
}
```

- [ ] **Step 4: db.ts addMessage 加 tool_call 参数**

`src/lib/db.ts:157-169` 整个 `addMessage` 替换为：
```ts
export async function addMessage(
  projectId: number,
  role: ChatRole,
  content: string,
  slideId?: number | null,
  reasoning?: string | null,
  toolCall?: string | null
) {
  const d = await db();
  await d.execute(
    "INSERT INTO messages(project_id, slide_id, role, content, reasoning, tool_call) VALUES(?, ?, ?, ?, ?, ?)",
    [projectId, slideId ?? null, role, content, reasoning ?? null, toolCall ?? null]
  );
}
```

- [ ] **Step 5: 类型检查 + Rust 检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误（现有 addMessage 调用方未传第 6 参，可选参数兼容）。

Run（在 `src-tauri/` 下）: `cargo check`
Expected: 编译通过，migration 已注册。

- [ ] **Step 6: 手动验证迁移生效**

Run: `npm run tauri dev`，启动后打开已有项目（触发 DB 打开）。
检查：应用正常启动无迁移错误（可关闭应用）。

- [ ] **Step 7: Commit**
```bash
git add src-tauri/migrations/007_add_tool_call_to_messages.sql src-tauri/src/lib.rs src/lib/db.ts
git commit -m "feat(db): messages.tool_call 列 + addMessage 参数（migration 007）"
```

---

## Task 2: Rust — tool_choice 翻译 + strict

**Files:**
- Modify: `src-tauri/src/lib.rs:13-18`（ToolDef 加 strict）、`41-56`（ChatConfig 加 tool_choice）、新增 `ToolChoice` 枚举、`295-385`（两格式 body 注入 tool_choice + strict）

**Interfaces:**
- Produces: Rust 接受 `tool_choice: {type:"auto"|"required"|"tool", name?}`（中性枚举），按格式翻译；`ToolDef.strict` OpenAI 分支注入 `strict:true`。前端 Task 4 起消费。

- [ ] **Step 1: ToolDef 加 strict 字段**

`src-tauri/src/lib.rs:13-18` 替换：
```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
struct ToolDef {
    name: String,
    description: String,
    parameters: serde_json::Value,
    #[serde(default)]
    strict: Option<bool>,
}
```

- [ ] **Step 2: 新增 ToolChoice 枚举 + ChatConfig 加 tool_choice**

在 `ChatConfig` 结构体**之前**插入枚举：
```rust
/// 中性工具选择策略，Rust 按格式翻译为 OpenAI/Anthropic 各自的 tool_choice。
#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ToolChoice {
    Auto,
    Required,
    Tool { name: String },
}
```

`src-tauri/src/lib.rs:41-56` 的 `ChatConfig` 末尾（`tools` 字段后）加：
```rust
    #[serde(default)]
    tool_choice: Option<ToolChoice>,
```

- [ ] **Step 3: Anthropic 分支注入 tool_choice + strict**

在 `chat_stream` 的 Anthropic 分支（`if !config.tools.is_empty()` 块内，`obj.insert("tools"...)` 之后）追加：
```rust
            if let Some(tc) = &config.tool_choice {
                let v = match tc {
                    ToolChoice::Auto => serde_json::json!({"type":"auto"}),
                    ToolChoice::Required => serde_json::json!({"type":"any"}),
                    ToolChoice::Tool { name } => serde_json::json!({"type":"tool","name":name}),
                };
                if let Some(obj) = body.as_object_mut() {
                    obj.insert("tool_choice".to_string(), v);
                }
            }
```
注：Anthropic 工具定义不注入 strict（其 input_schema 原生强校验）。

- [ ] **Step 4: OpenAI 分支注入 tool_choice + strict**

在 OpenAI 分支的 `if !config.tools.is_empty()` 块内，把 tools 构造改为带 strict，并在 `tool_choice:"auto"` 处替换为按 `config.tool_choice` 翻译。该块替换为：
```rust
        if !config.tools.is_empty() {
            let tools: Vec<serde_json::Value> = config.tools.iter().map(|t| {
                let mut func_obj = serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                });
                if t.strict.unwrap_or(false) {
                    func_obj["strict"] = serde_json::json!(true);
                }
                serde_json::json!({ "type": "function", "function": func_obj })
            }).collect();
            if let Some(obj) = body.as_object_mut() {
                obj.insert("tools".to_string(), serde_json::Value::Array(tools));
                let tc = match &config.tool_choice {
                    Some(ToolChoice::Auto) => serde_json::json!("auto"),
                    Some(ToolChoice::Required) => serde_json::json!("required"),
                    Some(ToolChoice::Tool { name }) => serde_json::json!({"type":"function","function":{"name":name}}),
                    None => serde_json::json!("auto"),
                };
                obj.insert("tool_choice".to_string(), tc);
            }
        }
```

- [ ] **Step 5: cargo check**

Run（在 `src-tauri/` 下）: `cargo check`
Expected: 编译通过（无 `unused variable` 之外警告）。

- [ ] **Step 6: 手动验证无回归**

Run: `npm run tauri dev`，用联网文案流程（已用 chatAgent+Tavily，走 auto tool_choice 默认）生成一个项目，确认文案调研正常（验证 tool_choice 默认 auto 不破坏现有流程）。

- [ ] **Step 7: Commit**
```bash
git add src-tauri/src/lib.rs
git commit -m "feat(rust): ChatConfig.tool_choice 翻译 + ToolDef.strict（OpenAI/Anthropic）"
```

---

## Task 3: Rust — chat-tool-args 流式事件

**Files:**
- Modify: `src-tauri/src/lib.rs:189-259`（`emit_anthropic_event` 增 tool-args emit）、`448-506`（OpenAI tool_calls 增 emit）

**Interfaces:**
- Produces: 新事件 `chat-tool-args`，payload `{name: string, delta: string}`。`chat-tool-calls`（回合末完整调用）不变。

- [ ] **Step 1: Anthropic content_block_start(tool_use) 发起始事件**

`src-tauri/src/lib.rs` `emit_anthropic_event` 函数的 `"content_block_start"` 分支，替换为（在 push ToolAccum 后发 chat-tool-args 起始）：
```rust
        "content_block_start" => {
            let b = &v["content_block"];
            if b["type"].as_str() == Some("tool_use") {
                if let Ok(mut acc) = tool_acc.lock() {
                    let new_idx = acc.len();
                    let name = b["name"].as_str().unwrap_or("").to_string();
                    acc.push(ToolAccum {
                        index: new_idx,
                        id: b["id"].as_str().unwrap_or("").to_string(),
                        name: name.clone(),
                        arguments: String::new(),
                    });
                    *last_tool_slot = (acc.len() as i64) - 1;
                    if !name.is_empty() {
                        let _ = app.emit("chat-tool-args", serde_json::json!({"name": name, "delta": ""}));
                    }
                }
            }
        }
```

- [ ] **Step 2: Anthropic input_json_delta 发增量事件**

同函数 `"content_block_delta"` 的 `Some("input_json_delta")` 分支替换为：
```rust
                Some("input_json_delta") => {
                    if let Some(pj) = delta["partial_json"].as_str() {
                        if let Ok(mut acc) = tool_acc.lock() {
                            let i = *last_tool_slot as usize;
                            if i < acc.len() {
                                acc[i].arguments.push_str(pj);
                                if !pj.is_empty() {
                                    let name = acc[i].name.clone();
                                    let _ = app.emit("chat-tool-args", serde_json::json!({"name": name, "delta": pj}));
                                }
                            }
                        }
                    }
                }
```

- [ ] **Step 3: OpenAI delta.tool_calls 发增量事件**

OpenAI SSE 分支里 `if let Some(calls) = delta["tool_calls"].as_array()` 块替换为（累积后按 slot.name emit）：
```rust
                        if let Some(calls) = delta["tool_calls"].as_array() {
                            if let Ok(mut acc) = tool_acc2.lock() {
                                for c in calls {
                                    let idx = c["index"].as_u64().unwrap_or(0) as usize;
                                    while acc.len() <= idx {
                                        let new_idx = acc.len();
                                        acc.push(ToolAccum { index: new_idx, ..Default::default() });
                                    }
                                    let slot = &mut acc[idx];
                                    if let Some(id) = c["id"].as_str() {
                                        slot.id = id.to_string();
                                    }
                                    if let Some(name) = c["function"]["name"].as_str() {
                                        slot.name = name.to_string();
                                    }
                                    if let Some(args) = c["function"]["arguments"].as_str() {
                                        slot.arguments.push_str(args);
                                        if !args.is_empty() {
                                            let _ = app2.emit("chat-tool-args", serde_json::json!({"name": slot.name.clone(), "delta": args}));
                                        }
                                    }
                                }
                            }
                        }
```

- [ ] **Step 4: cargo check**

Run（在 `src-tauri/` 下）: `cargo check`
Expected: 编译通过。

- [ ] **Step 5: 手动验证事件已发**

临时在 `src/lib/chat.ts` 的 `chat()` 内（Task 4 会正式接 onToolArgs；本步先验证事件到达）加一行临时监听：
```ts
const _dbg = await listen<{name:string;delta:string}>("chat-tool-args", (e) => console.log("[dbg tool-args]", e.payload.name, e.payload.delta.length));
```
（放在 `onChunkUn` 旁；记得 `finally` 里 `_dbg()`。）
Run: `npm run tauri dev`，跑联网文案（Tavily 工具会触发 tool-args 事件）。打开开发者工具 Console，确认有 `[dbg tool-args]` 日志输出。验证后**移除临时监听**。

- [ ] **Step 6: Commit**
```bash
git add src-tauri/src/lib.rs src/lib/chat.ts
git commit -m "feat(rust): chat-tool-args 流式事件（工具参数增量，供实时预览）"
```
注：若已移除 chat.ts 临时监听，则只 add lib.rs。

## Task 4: chat.ts — 传输层（ToolChoice / chat 增参 / chatAgent commitTool）

**Files:**
- Modify: `src/lib/chat.ts:17-27`（ToolDef 加 strict）、`23-27`（ToolCall 不变）、新增 `ToolChoice` 类型、`44-103`（chat 增 toolChoice+onToolArgs）、`118-204`（chatAgent 增 commitTool+onToolArgs）

**Interfaces:**
- Consumes: Task 2/3 的 Rust `tool_choice` + `chat-tool-args` 事件。
- Produces: `ToolChoice` 类型；`chat()` opts 增 `{toolChoice?, onToolArgs?}`；`chatAgent()` 末尾增 `commitTool?, onToolArgs?`（均可选，现有调用方仍编译通过）。**保留 `jsonMode` 参数**（Task 14 统一删除）。

- [ ] **Step 1: ToolDef 加 strict + 新增 ToolChoice 类型**

`src/lib/chat.ts:17-21` 的 `ToolDef` 替换为：
```ts
export interface ToolDef {
  name: string;
  description: string;
  parameters: object; // JSON Schema
  /** OpenAI strict 模式（强 Schema 校验）；Anthropic 忽略（input_schema 原生强校验） */
  strict?: boolean;
}

/** 中性工具选择策略，由 Rust 按格式翻译。 */
export type ToolChoice =
  | { type: "auto" }
  | { type: "required" }
  | { type: "tool"; name: string };
```

- [ ] **Step 2: chat() 增 toolChoice + onToolArgs**

`src/lib/chat.ts:44-103` 整个 `chat` 函数替换为：
```ts
export async function chat(
  messages: ChatMsg[],
  onChunk: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  jsonMode = false,
  opts?: {
    tools?: ToolDef[];
    toolChoice?: ToolChoice;
    onToolCalls?: (calls: ToolCall[]) => void;
    onToolArgs?: (e: { name: string; delta: string }) => void;
  }
): Promise<{ toolCalls: ToolCall[] | null }> {
  const ai = await getActiveAi();
  if (!ai || !ai.api_base || !ai.api_key || !ai.model) {
    throw new Error("请先在「设置」页配置并启用一个 AI");
  }
  const config: Record<string, unknown> = {
    api_base: ai.api_base,
    api_key: ai.api_key,
    model: ai.model,
    format: ai.format,
    thinking_mode: ai.thinking_mode,
    thinking_effort: ai.thinking_effort,
    json_mode: jsonMode,
  };
  if (opts?.tools?.length) {
    config.tools = opts.tools;
    if (opts.toolChoice) config.tool_choice = opts.toolChoice;
  }

  let collected: ToolCall[] | null = null;
  const onChunkUn = await listen<string>("chat-chunk", (e) => onChunk(e.payload));
  const onReasoningUn = onReasoning
    ? await listen<string>("chat-reasoning", (e) => onReasoning(e.payload))
    : null;
  const onToolsUn = opts?.onToolCalls
    ? await listen<ToolCall[]>("chat-tool-calls", (e) => {
        collected = e.payload;
        opts.onToolCalls!(e.payload);
      })
    : await listen<ToolCall[]>("chat-tool-calls", (e) => {
        collected = e.payload;
      });
  const onToolArgsUn = opts?.onToolArgs
    ? await listen<{ name: string; delta: string }>("chat-tool-args", (e) =>
        opts.onToolArgs!(e.payload)
      )
    : null;
  const onStartUn = await listen("chat-start", () =>
    console.log("[chat] 连接已建立，开始接收流")
  );
  try {
    await invoke("chat_stream", { config, messages });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "__cancelled__") {
      const err = new Error("已取消") as CancelledError;
      err.__cancelled = true;
      throw err;
    }
    console.error("[chat] 调用失败：", e);
    throw e;
  } finally {
    onChunkUn();
    onReasoningUn?.();
    onToolsUn();
    onToolArgsUn?.();
    onStartUn();
  }
  return { toolCalls: collected };
}
```

- [ ] **Step 3: chatAgent 增 commitTool 收尾语义**

`src/lib/chat.ts:118-204` 整个 `chatAgent` 函数替换为：
```ts
/**
 * 多轮 agent loop：模型用工具调研/产出，每轮执行工具回填结果。
 * - commitTool 指定"收尾工具"（如 write_manuscript）：模型调用它即收尾返回。
 *   纯文本无调用 → 提示并下一轮强制；触顶 → 强制收尾轮；强制后仍不调 → 抛错。
 *   commitTool 执行不计入 maxToolCalls（它是必需的收尾，非调研）。
 * - 无 commitTool 时退化为旧行为：首个无工具调用轮即最终回复。
 * - onToolArgs 透传给 chat，供实时预览提取工具参数。
 */
export async function chatAgent(
  initMessages: ChatMsg[],
  tools: ToolDef[],
  execTool: (call: ToolCall) => Promise<string>,
  onChunk: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  onRoundStart?: () => void,
  limits: { maxLlmRounds: number; maxToolCalls: number } = {
    maxLlmRounds: 50,
    maxToolCalls: 20,
  },
  isCancelled?: () => boolean,
  commitTool?: string,
  onToolArgs?: (e: { name: string; delta: string }) => void
): Promise<string> {
  const messages: ChatMsg[] = [...initMessages];
  let toolCount = 0;
  let finalText = "";
  let forceFinalize = false;
  for (let round = 0; round < limits.maxLlmRounds; round++) {
    if (isCancelled?.()) return finalText;
    onRoundStart?.();
    finalText = "";
    const forced = forceFinalize && !!commitTool;
    const toolChoice: ToolChoice = forced
      ? { type: "tool", name: commitTool! }
      : { type: "auto" };
    const { toolCalls } = await chat(
      messages,
      (d) => { finalText += d; onChunk(d); },
      onReasoning,
      false,
      { tools, toolChoice, onToolArgs }
    );
    if (isCancelled?.()) return finalText;
    if (!toolCalls || !toolCalls.length) {
      if (!commitTool) return finalText; // 旧行为：首个无工具轮即最终回复
      if (forced) throw new Error(`模型未调用工具 ${commitTool} 提交结果，请重试`);
      messages.push({ role: "assistant", content: finalText });
      messages.push({
        role: "system",
        content: `请调用 ${commitTool} 工具提交最终结果，不要只输出文本。`,
      });
      forceFinalize = true;
      continue;
    }
    // 选出要执行的调用
    let callsToExec: ToolCall[];
    if (forced) {
      // 强制收尾轮：只执行 commitTool（必需，不受配额限制）
      callsToExec = toolCalls.filter((c) => c.name === commitTool);
      if (!callsToExec.length) throw new Error(`模型未调用工具 ${commitTool} 提交结果，请重试`);
    } else {
      const remaining = limits.maxToolCalls - toolCount;
      callsToExec = toolCalls.slice(0, Math.max(0, remaining));
    }
    const dropped = toolCalls.length - callsToExec.length;
    const assistantMsg: ChatMsg = { role: "assistant", content: finalText };
    if (callsToExec.length > 0) assistantMsg.tool_calls = callsToExec;
    messages.push(assistantMsg);
    const executedNames = new Set<string>();
    for (const call of callsToExec) {
      if (isCancelled?.()) return finalText;
      const result = await execTool(call);
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
      if (call.name !== commitTool) toolCount++; // commitTool 不占调研配额
      executedNames.add(call.name);
    }
    if (isCancelled?.()) return finalText;
    if (commitTool && executedNames.has(commitTool)) return finalText; // 收尾工具已执行
    // 未收尾：配额耗尽则下轮强制
    if (!forced && toolCount >= limits.maxToolCalls) {
      let msg = "已达到工具调用上限，请停止调研，直接调用工具提交最终结果。";
      if (dropped > 0) {
        const names = toolCalls.slice(callsToExec.length).map((c) => c.name).join("、");
        msg += ` 本轮有 ${dropped} 个调用因配额不足被跳过：${names}`;
      }
      messages.push({ role: "system", content: msg });
      forceFinalize = true;
    }
  }
  // 触顶 LLM 轮数：最后强制一次收尾
  if (isCancelled?.()) return finalText;
  if (commitTool) {
    onRoundStart?.();
    finalText = "";
    await chat(
      messages,
      (d) => { finalText += d; onChunk(d); },
      onReasoning,
      false,
      { tools, toolChoice: { type: "tool", name: commitTool }, onToolArgs }
    );
  }
  return finalText;
}
```

- [ ] **Step 4: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误（chatAgent 新增参数均可选，genStore 现有调用未传 commitTool → 旧行为）。

- [ ] **Step 5: 手动验证无回归**

Run: `npm run tauri dev`，跑联网文案流程，确认 chatAgent 仍正常调研收尾（commitTool 未传 → 旧行为）。

- [ ] **Step 6: Commit**
```bash
git add src/lib/chat.ts
git commit -m "feat(chat): ToolChoice 类型 + chat toolChoice/onToolArgs + chatAgent commitTool 收尾"
```

---

## Task 5: prompt.ts — 四个工具定义（additive）

**Files:**
- Modify: `src/lib/prompt.ts`（末尾追加四个工具定义 export）

**Interfaces:**
- Produces: `manuscriptTool` / `outlineTool` / `slideHtmlTool` / `selfCheckTool`（均为 `ToolDef`，`strict:true`，Schema 符合 strict 约束）。Task 7-10 消费。

- [ ] **Step 1: 在 prompt.ts 末尾追加工具定义**

在 `src/lib/prompt.ts` 文件**末尾**追加（不动现有内容）：
```ts

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
```

- [ ] **Step 2: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误（纯 additive export）。

- [ ] **Step 3: Commit**
```bash
git add src/lib/prompt.ts
git commit -m "feat(prompt): 四个工具定义 write_manuscript/commit_outline/write_slide_html/apply_selfcheck"
```

---

## Task 6: toolUtils.ts + genStore 原语（additive）

**Files:**
- Create: `src/lib/toolUtils.ts`
- Create: `scripts/verify-tool-utils.ts`
- Modify: `src/lib/genStore.ts:46-63`（genState 加 artifact + resetBuffers）、新增 `runToolPhase` 原语 + `makeCancelled` 辅助

**Interfaces:**
- Produces: `extractStringArg(partialJson): string`、`toolLabel(name, args, ctx?): string`、`genState.artifact: string`、`runToolPhase({...}): Promise<{nlText, parsedArgs}>`。Task 7-10 消费。**现有阶段函数不动**（additive）。

- [ ] **Step 1: 创建 toolUtils.ts（纯函数）**

`src/lib/toolUtils.ts`:
```ts
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
```

- [ ] **Step 2: 创建 verify-tool-utils.ts（sanity 脚本）**

`scripts/verify-tool-utils.ts`:
```ts
import { extractStringArg, toolLabel } from "../src/lib/toolUtils";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}

// 完整 JSON
assert(extractStringArg('{"html":"<div>hi</div>"}') === "<div>hi</div>", "完整 html 提取");
assert(extractStringArg('{"content":"## 标题\\n正文"}') === "## 标题\n正文", "转义 \\n 解析");

// 不完整（流式中途）
assert(extractStringArg('{"html":"<div>partial') === "<div>partial", "未闭合提取");
assert(extractStringArg('{"html":"') === "", "仅起始引号");
assert(extractStringArg('') === "", "空串");
assert(extractStringArg('{"html":123}') === "", "非字符串值返回空");

// unicode 转义
assert(extractStringArg('{"html":"\\u4e2d"}') === "中", "unicode 转义");

// toolLabel
assert(toolLabel("write_manuscript", { content: "x".repeat(10) }) === "📝 文案 · 10 字", "manuscript label");
assert(toolLabel("commit_outline", { slides: [1, 2, 3] }) === "🗂 大纲 · 3 页", "outline label");
assert(toolLabel("write_slide_html", {}, { index: 2 }) === "🎨 单页 HTML · 第 3 页", "slide label");
assert(toolLabel("apply_selfcheck", {}) === "🔍 自检改写", "selfcheck label");

console.log("\n全部通过");
```

- [ ] **Step 3: 运行 sanity 脚本**

Run: `npx tsx scripts/verify-tool-utils.ts`
Expected: 输出 `全部通过`（npx 自动拉取 tsx，无需装依赖）。

- [ ] **Step 4: genStore 加 genState.artifact + resetBuffers**

`src/lib/genStore.ts:46-63` 的 `genState` 与 `resetBuffers` 替换为：
```ts
export const genState = reactive({
  running: false,
  phase: "idle" as GenPhase,
  projectId: null as number | null,
  slideIdx: 0,
  reasoning: "",
  content: "",
  artifact: "", // 工具参数提取的产物（html/文案），进预览
  status: "",
  error: null as string | null,
  cancelled: false,
});

function resetBuffers() {
  genState.reasoning = "";
  genState.content = "";
  genState.artifact = "";
  genState.error = null;
  genState.cancelled = false;
}
```

并在 `reset()`（文件末尾）加 `genState.artifact = "";`：
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
（resetBuffers 已清 artifact，reset 里无需重复加——保持原样即可。即 reset() 不动。）

- [ ] **Step 5: genStore 加 makeCancelled + runToolPhase 原语**

在 `src/lib/genStore.ts` 的 `isCancelled` 函数之后、`cancelGeneration` 之前，插入：
```ts
/** 构造取消哨兵错误，供 runToolPhase 在 cancel 时抛出。 */
function makeCancelled(): CancelledError {
  const err = new Error("已取消") as CancelledError;
  err.__cancelled = true;
  return err;
}
```

在 `startOutline` 函数**之前**插入 `runToolPhase` 原语：
```ts
import { extractStringArg } from "./toolUtils";
import { toolLabel } from "./toolUtils";
import type { ToolChoice } from "./chat";

/**
 * 单发工具阶段原语：强制 requiredTool 一轮到位。
 * - chat-chunk → genState.content（自然语言，进对话框，实时）
 * - chat-tool-args → 提取 artifactField → genState.artifact（进预览，实时）
 * - 回合末校验（API Schema 已强校验 + validate 业务规则）；合法 → execTool 落库 + 回填 tool_result；
 *   不合法/未调用 → 回填错误 + system 重试一次（再强制）；仍失败 → 抛错。
 * 返回 { nlText, parsedArgs } 供调用方生成消息卡片 label。
 */
async function runToolPhase(args: {
  systemPrompt: string;
  userPrompt: string;
  requiredTool: ToolDef;
  tools?: ToolDef[];
  execTool: (call: ToolCall, parsedArgs: unknown) => Promise<string>;
  validate?: (parsedArgs: unknown) => string | null;
  artifactField?: string; // 单字段工具：从参数提取该字段进 genState.artifact
  maxRetries?: number;
}): Promise<{ nlText: string; parsedArgs: unknown; call: ToolCall }> {
  const tools = args.tools ?? [args.requiredTool];
  const maxRetries = args.maxRetries ?? 1;
  const messages: ChatMsg[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userPrompt },
  ];
  let lastErr = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (genState.cancelled) throw makeCancelled();
    let nlText = "";
    let argBuf = "";
    const { toolCalls } = await chat(
      messages,
      (d) => { nlText += d; genState.content += d; },
      (d) => { genState.reasoning += d; },
      false,
      {
        tools,
        toolChoice: { type: "tool", name: args.requiredTool.name } as ToolChoice,
        onToolArgs: (e) => {
          if (e.name === args.requiredTool.name) {
            argBuf += e.delta;
            if (args.artifactField) {
              genState.artifact = extractStringArg(argBuf);
            }
          }
        },
      }
    );
    if (genState.cancelled) throw makeCancelled();
    const call = toolCalls?.find((c) => c.name === args.requiredTool.name) ?? null;
    if (!call) {
      lastErr = `模型未调用工具 ${args.requiredTool.name}`;
      messages.push({ role: "assistant", content: nlText });
      messages.push({ role: "system", content: `${lastErr}，请调用 ${args.requiredTool.name} 提交结果。` });
      continue;
    }
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(call.arguments);
    } catch {
      lastErr = "工具参数不是合法 JSON";
      messages.push({ role: "assistant", content: nlText, tool_calls: [call] });
      messages.push({ role: "tool", content: `[校验错误] ${lastErr}`, tool_call_id: call.id });
      messages.push({ role: "system", content: `请重新调用 ${args.requiredTool.name}，修正：${lastErr}` });
      continue;
    }
    const verr = args.validate ? args.validate(parsedArgs) : null;
    if (verr) {
      lastErr = verr;
      messages.push({ role: "assistant", content: nlText, tool_calls: [call] });
      messages.push({ role: "tool", content: `[校验错误] ${lastErr}`, tool_call_id: call.id });
      messages.push({ role: "system", content: `请重新调用 ${args.requiredTool.name}，修正：${lastErr}` });
      continue;
    }
    // 合法 → 落库 + 回填（单发不再请求模型，但保持历史完整）
    const result = await args.execTool(call, parsedArgs);
    messages.push({ role: "assistant", content: nlText, tool_calls: [call] });
    messages.push({ role: "tool", content: result, tool_call_id: call.id });
    return { nlText, parsedArgs, call };
  }
  throw new Error(`${args.requiredTool.name} 校验失败：${lastErr}`);
}
```

注：`ToolDef` / `ToolCall` / `ChatMsg` / `CancelledError` 已从 `./chat` import；`ToolChoice` 需补 import（见上）。若 `import type { ToolChoice }` 与现有 import 冲突，合并到现有 `import { chat, chatOnce, chatAgent, type ChatMsg, type CancelledError, type ToolCall } from "./chat";` 行，追加 `type ToolDef, type ToolChoice`。

- [ ] **Step 6: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。`runToolPhase` 未被调用（unused export 不报错）；`extractStringArg`/`toolLabel` 导入暂未使用 → 若 vue-tsc 报 `unused import`，先注释掉 genStore 里的 `import { extractStringArg }...` 与 `toolLabel`，留到 Task 7 启用（TS `noUnusedLocals` 可能开启）。检查 `tsconfig.json` 是否 `noUnusedLocals`：若是，则本步暂不 import toolUtils，Task 7 再加。

- [ ] **Step 7: Commit**
```bash
git add src/lib/toolUtils.ts scripts/verify-tool-utils.ts src/lib/genStore.ts
git commit -m "feat(genStore): genState.artifact + runToolPhase 原语 + toolUtils 纯函数"
```

## Task 7: 文案阶段改 write_manuscript（manuscriptPrompt + startOutline 文案子阶段）

**Files:**
- Modify: `src/lib/prompt.ts:186-202`（manuscriptPrompt 改"调用工具"）
- Modify: `src/lib/genStore.ts`（startOutline 文案子阶段，`let manuscript = "";` 到 `} // 结束 if (proj?.manuscript) else 分支`）
- Modify: `src/lib/genStore.ts` import 行（加 manuscriptTool）

**Interfaces:**
- Consumes: Task 5 `manuscriptTool`、Task 6 `runToolPhase`/`extractStringArg`/`toolLabel`、Task 4 `chatAgent` commitTool。
- Produces: 文案阶段产出 `projects.manuscript` + assistant 消息（content=NL，tool_call={name:"write_manuscript",label}）；`genState.artifact` 流式文案。

- [ ] **Step 1: 改 manuscriptPrompt 为"调用工具"**

`src/lib/prompt.ts:186-202` 整个 `manuscriptPrompt` 替换为：
```ts
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
```

- [ ] **Step 2: genStore import 加 manuscriptTool + toolUtils**

`src/lib/genStore.ts` 现有 prompt import（`manuscriptPrompt, splitOutlinePrompt, ...`）行追加 `manuscriptTool`；并在 import 区加：
```ts
import { extractStringArg, toolLabel } from "./toolUtils";
```
（若 Task 6 因 noUnusedLocals 未加此 import，本步加上。）

- [ ] **Step 3: 替换 startOutline 文案子阶段**

`src/lib/genStore.ts` 中从 `  let manuscript = "";`（try 之后第一行）到 `    } // 结束 if (proj?.manuscript) else 分支`（含该注释行）整块替换为：
```ts
  let manuscript = "";
  try {
    // —— 文案阶段 ——
    // 若项目已有完整文案（如上次拆页失败/取消但文案已存），跳过调研直接复用
    const proj = await getProject(projectId);
    if (proj?.manuscript) {
      manuscript = proj.manuscript;
      genState.status = "已有完整文案（" + manuscript.length + " 字），跳过调研直接拆分大纲…";
      genState.content = manuscript; // 让 UI 可见
    } else {
      let useSearch = searchEnabled;
      let apiKey: string | null = null;
      if (useSearch) {
        apiKey = await getTavilyKey();
        if (!apiKey) {
          useSearch = false;
          genState.status = "未配置 Tavily Key，离线生成文案…";
        }
      }
      const sysMsg = "你是专业 PPT 文案策划，严格按要求输出。";
      const userMsg = manuscriptPrompt(topic);
      let manuscriptLabel = "";
      if (useSearch && apiKey) {
        genState.status = "联网调研并撰写文案…";
        let capturedManuscript = "";
        let manArgBuf = "";
        const execManuscriptTool = async (call: ToolCall): Promise<string> => {
          if (call.name === "write_manuscript") {
            try {
              const a = JSON.parse(call.arguments) as { content?: string };
              capturedManuscript = a.content ?? "";
              genState.artifact = capturedManuscript;
              await updateProject(projectId, { manuscript: capturedManuscript });
              manuscriptLabel = toolLabel("write_manuscript", a);
              return `已保存文案（${capturedManuscript.length} 字）`;
            } catch {
              return "[工具错误] 参数解析失败";
            }
          }
          return execTavilyTool(call, apiKey!);
        };
        try {
          await chatAgent(
            [{ role: "system", content: sysMsg }, { role: "user", content: userMsg }],
            [...tavilyTools, manuscriptTool],
            execManuscriptTool,
            (d) => {
              genState.content += d;
              genState.status = `撰写文案中… 已收到 ${genState.content.length} 字`;
            },
            (d) => { genState.reasoning += d; },
            () => { genState.content = ""; }, // 每轮清空 NL（只留最终轮）
            undefined,
            () => genState.cancelled,
            "write_manuscript",
            (e) => {
              if (e.name === "write_manuscript") {
                manArgBuf += e.delta;
                genState.artifact = extractStringArg(manArgBuf);
              }
            }
          );
          manuscript = capturedManuscript;
        } catch (e) {
          if (isCancelled(e)) throw e;
          // 联网不可用 → 降级离线 runToolPhase
          genState.status = "联网搜索不可用，改为离线生成文案…";
          genState.content = "";
          const r = await runToolPhase({
            systemPrompt: sysMsg,
            userPrompt: userMsg,
            requiredTool: manuscriptTool,
            artifactField: "content",
            execTool: async (_c, parsed) => {
              const a = parsed as { content: string };
              manuscript = a.content;
              await updateProject(projectId, { manuscript });
              manuscriptLabel = toolLabel("write_manuscript", a);
              return `已保存文案（${a.content.length} 字）`;
            },
          });
          manuscript = (r.parsedArgs as { content: string }).content;
        }
      } else {
        genState.status = "撰写文案中…";
        const r = await runToolPhase({
          systemPrompt: sysMsg,
          userPrompt: userMsg,
          requiredTool: manuscriptTool,
          artifactField: "content",
          execTool: async (_c, parsed) => {
            const a = parsed as { content: string };
            manuscript = a.content;
            await updateProject(projectId, { manuscript });
            manuscriptLabel = toolLabel("write_manuscript", a);
            return `已保存文案（${a.content.length} 字）`;
          },
        });
        manuscript = (r.parsedArgs as { content: string }).content;
      }
      if (genState.cancelled) {
        genState.status = "已取消";
        return;
      }
      if (!manuscript.trim()) {
        throw new Error("文案生成失败：模型未产出任何文案内容，请重试或调整主题。");
      }
      await addMessage(
        projectId,
        "assistant",
        "已生成完整文案。",
        null,
        genState.reasoning,
        JSON.stringify({ name: "write_manuscript", label: manuscriptLabel || toolLabel("write_manuscript", { content: manuscript }) })
      );
    } // 结束 if (proj?.manuscript) else 分支
```

- [ ] **Step 4: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。注：本步后 startOutline 的拆页阶段仍是旧的 chatOnce+parseOutline（Task 8 改），整个函数仍编译。

- [ ] **Step 5: 手动验证文案阶段（双路径）**

Run: `npm run tauri dev`
- **离线路径**：新建项目（不勾选联网），确认：对话框显示模型一两句思路 + `📝 文案 · N 字` 卡片；文案面板逐字流式；DB `projects.manuscript` 有值。
- **联网路径**：配置 Tavily Key，新建项目勾选联网，确认调研后调用 write_manuscript 落库。
- 确认 `genState.content` 是自然语言（非原始 markdown 源码进对话框）。

- [ ] **Step 6: Commit**
```bash
git add src/lib/prompt.ts src/lib/genStore.ts
git commit -m "feat(manuscript): 文案阶段改 write_manuscript 工具调用（双路径）"
```

---

## Task 8: 大纲阶段改 commit_outline（splitOutlinePrompt + startOutline 拆页子阶段 + sendOutlineChat）

**Files:**
- Modify: `src/lib/prompt.ts:15-52`（splitOutlinePrompt 改"调用工具"）
- Modify: `src/lib/genStore.ts`（startOutline 拆页子阶段：`// —— 拆页阶段 ——` 到 `genState.status = "大纲已生成..."`）、`sendOutlineChat` 整个函数
- Modify: `src/lib/genStore.ts` import 加 `outlineTool`

**Interfaces:**
- Consumes: Task 5 `outlineTool`、Task 6 `runToolPhase`/`toolLabel`。
- Produces: 拆页/大纲对话产出 `projects.{design_tokens,theme_css,style}` + 覆盖 `slides` + assistant 消息（tool_call commit_outline label）。

- [ ] **Step 1: 改 splitOutlinePrompt 为"调用工具"**

`src/lib/prompt.ts:15-52` 整个 `splitOutlinePrompt` 替换为：
```ts
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
```

- [ ] **Step 2: genStore import 加 outlineTool**

`src/lib/genStore.ts` prompt import 行追加 `outlineTool`。

- [ ] **Step 3: 替换 startOutline 拆页子阶段**

`src/lib/genStore.ts` 中从 `    // —— 拆页阶段 ——` 到 `    genState.status = "大纲已生成，可进入编辑器逐页生成 HTML";`（含）整块替换为：
```ts
    // —— 拆页阶段 ——
    if (genState.cancelled) {
      genState.status = "已取消";
      return;
    }
    genState.phase = "outline";
    resetBuffers();
    const r = await runToolPhase({
      systemPrompt: "你是专业 PPT 设计师，按要求调用 commit_outline 提交设计系统与全部页面大纲。",
      userPrompt: splitOutlinePrompt(topic, manuscript, style),
      requiredTool: outlineTool,
      validate: (parsed) => {
        const a = parsed as { slides?: OutlineSlide[] };
        if (!a.slides || !a.slides.length) return "slides 不能为空";
        if (a.slides.some((s) => !s.title)) return "每页必须有 title";
        return null;
      },
      execTool: async (_c, parsed) => {
        const a = parsed as {
          design_tokens: Record<string, string>;
          theme_css: string;
          slides: OutlineSlide[];
          style?: string;
        };
        const tokensJson = JSON.stringify(a.design_tokens, null, 2);
        const resolvedStyle = a.style ?? style ?? null;
        await updateProject(projectId, {
          design_tokens: tokensJson,
          theme_css: a.theme_css,
          style: resolvedStyle,
        });
        for (const s of await listSlides(projectId)) {
          if (s.id) await deleteSlide(s.id);
        }
        for (let i = 0; i < a.slides.length; i++) {
          const s = a.slides[i];
          await upsertSlide({
            project_id: projectId,
            sort: i,
            title: s.title,
            outline: JSON.stringify(s),
            html_content: null,
          });
        }
        return `已保存 ${a.slides.length} 页大纲`;
      },
    });
    const slideCount = (r.parsedArgs as { slides: OutlineSlide[] }).slides.length;
    const label = toolLabel("commit_outline", r.parsedArgs);
    await addMessage(
      projectId,
      "assistant",
      r.nlText || `已生成大纲（${slideCount} 页）与设计系统。`,
      null,
      genState.reasoning,
      JSON.stringify({ name: "commit_outline", label })
    );
    genState.status = "大纲已生成，可进入编辑器逐页生成 HTML";
```

- [ ] **Step 4: 替换 sendOutlineChat 整个函数**

`src/lib/genStore.ts` 中 `sendOutlineChat` 整个函数替换为：
```ts
// 大纲对话修改：强制 commit_outline，校验通过才覆盖写库。
export async function sendOutlineChat(
  projectId: number,
  topic: string,
  style: string | null,
  currentSlides: OutlineSlide[],
  instruction: string,
  manuscript?: string | null
): Promise<void> {
  genState.projectId = projectId;
  genState.running = true;
  genState.phase = "outline-chat";
  resetBuffers();
  try {
    const userPrompt =
      `主题：${topic}${manuscript ? `\n\n【完整文案（供参考，修改大纲时确保覆盖文案要点）】\n${manuscript}` : ""}\n\n当前大纲 JSON：\n${JSON.stringify(
        { slides: currentSlides },
        null,
        2
      )}\n\n用户修改指令：${instruction}`;
    const r = await runToolPhase({
      systemPrompt:
        "你是专业 PPT 设计师。根据用户指令修改大纲，调用 commit_outline 提交修改后的完整设计系统与全部页面（design_tokens/theme_css/slides/style）。每页必须保留 notes 字段，修改页面的同时维护 notes 与要点对齐。",
      userPrompt,
      requiredTool: outlineTool,
      validate: (parsed) => {
        const a = parsed as { slides?: OutlineSlide[] };
        if (!a.slides || !a.slides.length) return "slides 不能为空";
        if (a.slides.some((s) => !s.title)) return "每页必须有 title";
        return null;
      },
      execTool: async (_c, parsed) => {
        const a = parsed as {
          design_tokens: Record<string, string>;
          theme_css: string;
          slides: OutlineSlide[];
          style?: string;
        };
        const tokensJson = JSON.stringify(a.design_tokens, null, 2);
        const resolvedStyle = a.style ?? style ?? null;
        await updateProject(projectId, {
          design_tokens: tokensJson,
          theme_css: a.theme_css,
          style: resolvedStyle,
        });
        for (const s of await listSlides(projectId)) {
          if (s.id) await deleteSlide(s.id);
        }
        for (let i = 0; i < a.slides.length; i++) {
          const s = a.slides[i];
          await upsertSlide({
            project_id: projectId,
            sort: i,
            title: s.title,
            outline: JSON.stringify(s),
            html_content: null,
          });
        }
        return `已保存 ${a.slides.length} 页大纲`;
      },
    });
    const slideCount = (r.parsedArgs as { slides: OutlineSlide[] }).slides.length;
    const label = toolLabel("commit_outline", r.parsedArgs);
    await addMessage(
      projectId,
      "assistant",
      r.nlText || `已按指令更新大纲（${slideCount} 页）。`,
      null,
      genState.reasoning,
      JSON.stringify({ name: "commit_outline", label })
    );
    genState.status = "大纲已更新";
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "错误：" + genState.error;
      // 校验失败不写库（execTool 仅在校验通过后执行）
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}
```

- [ ] **Step 5: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。`parseOutline` 仍被 Outline.vue 使用（Task 12 删），暂留。

- [ ] **Step 6: 手动验证大纲阶段**

Run: `npm run tauri dev`
- 新建项目跑到大纲：对话框显示设计思路 NL + `🗂 大纲 · N 页` 卡片；主面板不再出现原始 JSON `<pre>`（Outline.vue 仍用旧模板 Task 12 改，但 `genState.content` 已是 NL 非 JSON，故 `.stream` 的 `<pre>` 显示的是 NL——可接受过渡态）；大纲卡片在完成后出现；DB slides 写入。
- 大纲对话：发"把第3页拆成两页"，确认 NL 回复 + 卡片 + slides 更新。
- 失败注入：临时把 outlineTool 的 required slides 改为要求 title 带特定前缀（或临时在 validate 加 `return "测试失败"`），确认重试一次后报错、不写半截。验证后还原。

- [ ] **Step 7: Commit**
```bash
git add src/lib/prompt.ts src/lib/genStore.ts
git commit -m "feat(outline): 拆页/大纲对话改 commit_outline 工具调用"
```

## Task 9: 单页生成 + 自检改工具调用（slideHtmlPrompt + selfCheckPrompt + startSlide + selfCheckSlide）

**Files:**
- Modify: `src/lib/prompt.ts:61-100`（slideHtmlPrompt）、`160-183`（selfCheckPrompt）
- Modify: `src/lib/genStore.ts`（startSlide 整个函数、selfCheckSlide 整个函数；import 加 slideHtmlTool/selfCheckTool）
- 注：`startAll` 不动（仍循环 startSlide）；`maybeSelfCheck`/`themeFingerprint` 不动。

**Interfaces:**
- Consumes: Task 5 `slideHtmlTool`/`selfCheckTool`、Task 6 `runToolPhase`/`extractStringArg`/`toolLabel`。
- Produces: 单页生成产出 `slides.html_content` + assistant 消息（tool_call write_slide_html label）；自检产出改写 HTML 或保留原页。

- [ ] **Step 1: 改 slideHtmlPrompt 为"调用工具"**

`src/lib/prompt.ts:61-100` 整个 `slideHtmlPrompt` 替换为：
```ts
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
```

- [ ] **Step 2: 改 selfCheckPrompt 为"调用工具"**

`src/lib/prompt.ts:160-183` 整个 `selfCheckPrompt` 替换为：
```ts
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
```

- [ ] **Step 3: genStore import 加 slideHtmlTool / selfCheckTool**

`src/lib/genStore.ts` prompt import 行追加 `slideHtmlTool, selfCheckTool`。

- [ ] **Step 4: 替换 startSlide 整个函数**

`src/lib/genStore.ts` 中 `startSlide` 整个函数替换为：
```ts
// 阶段2：生成单页 HTML。预览实时流由组件读 genState.artifact 渲染，完成后写库 + 自检。
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
    const r = await runToolPhase({
      systemPrompt:
        "你是专业前端工程师，先用一句话说明本页设计思路，再调用 write_slide_html 提交完整 HTML 文档。",
      userPrompt: slideHtmlPrompt({
        topic: proj.topic,
        designTokens: proj.design_tokens ?? "",
        themeCss: proj.theme_css ?? "",
        slide: outlineSlide,
        index: idx + 1,
        total: slides.length,
      }),
      requiredTool: slideHtmlTool,
      artifactField: "html",
      validate: (parsed) => {
        const html = (parsed as { html?: string }).html ?? "";
        if (!/<html/i.test(html) || (!/\.slide\b/.test(html) && !/class="slide"/.test(html)))
          return "HTML 必须是含 .slide 画布的完整文档";
        return null;
      },
      execTool: async (_c, parsed) => {
        slide.html_content = cleanHtml((parsed as { html: string }).html);
        await upsertSlide(slide);
        return `已保存第 ${idx + 1} 页 HTML`;
      },
    });
    const label = toolLabel("write_slide_html", r.parsedArgs, { index: idx });
    const kind = outlineSlide.kind;
    const bulletsLen = outlineSlide.bullets?.length ?? 0;
    await addMessage(
      projectId,
      "assistant",
      r.nlText || `第 ${idx + 1} 页已生成 · 版式 ${kind} · ${bulletsLen} 个要点 · ${outlineSlide.title}`,
      slide.id,
      genState.reasoning,
      JSON.stringify({ name: "write_slide_html", label })
    );
    genState.status = `第 ${idx + 1} 页已生成`;
    // 多模态自检（单页生成入口）
    await maybeSelfCheck(projectId, slides, idx);
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "错误：" + genState.error;
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}
```

- [ ] **Step 5: 替换 selfCheckSlide 整个函数**

`src/lib/genStore.ts` 中 `selfCheckSlide` 整个函数替换为（自检不重试：主题指纹不一致即保留原页，匹配原语义）：
```ts
/** 自检：多模态发截图+HTML、非多模态仅发 HTML → 强制 apply_selfcheck → 校验主题指纹后写库（破坏主题则还原）。 */
export async function selfCheckSlide(
  projectId: number,
  slides: Slide[],
  idx: number
): Promise<void> {
  const slide = slides[idx];
  if (!slide?.html_content) return;
  const originalHtml = slide.html_content;
  const originalFp = themeFingerprint(originalHtml);
  genState.projectId = projectId;
  genState.slideIdx = idx;
  genState.running = true;
  genState.phase = "selfcheck";
  resetBuffers();
  try {
    const ai = await getActiveAi();
    const multimodal = !!ai?.multimodal;
    const dataUrl = multimodal ? await renderSlideToDataUrl(slide.html_content) : null;
    let argBuf = "";
    const userMsg: ChatMsg = {
      role: "user",
      content: selfCheckPrompt(slide.html_content, multimodal),
    };
    if (dataUrl) userMsg.images = [dataUrl];
    const { toolCalls } = await chat(
      [
        { role: "system", content: "你是 PPT 自检员，调用 apply_selfcheck 提交改进后的完整 HTML。" },
        userMsg,
      ],
      (d) => { genState.content += d; },
      (d) => { genState.reasoning += d; },
      false,
      {
        tools: [selfCheckTool],
        toolChoice: { type: "tool", name: "apply_selfcheck" },
        onToolArgs: (e) => {
          if (e.name === "apply_selfcheck") {
            argBuf += e.delta;
            genState.artifact = cleanHtml(extractStringArg(argBuf));
          }
        },
      }
    );
    if (genState.cancelled) {
      genState.status = "已取消";
      slide.html_content = originalHtml;
      return;
    }
    const call = toolCalls?.find((c) => c.name === "apply_selfcheck") ?? null;
    let html = "";
    if (call) {
      try {
        html = (JSON.parse(call.arguments) as { html?: string }).html ?? "";
      } catch {
        html = "";
      }
    }
    html = cleanHtml(html || genState.artifact);
    const structOk = /<html/i.test(html) && (/\.slide\b/.test(html) || /class="slide"/.test(html));
    const themeOk = structOk && themeFingerprint(html) === originalFp;
    if (themeOk) {
      slide.html_content = html;
      await upsertSlide(slide);
      await addMessage(
        projectId,
        "assistant",
        "已自检并改进当前页",
        slide.id,
        genState.reasoning,
        JSON.stringify({ name: "apply_selfcheck", label: toolLabel("apply_selfcheck", {}) })
      );
      genState.status = `第 ${idx + 1} 页已自检改进`;
    } else {
      slide.html_content = originalHtml;
      const reason = structOk ? "样式被改动" : "未返回有效 HTML";
      await addMessage(
        projectId,
        "assistant",
        `第 ${idx + 1} 页自检${reason}，已保留原页`,
        slide.id
      );
      genState.status = `第 ${idx + 1} 页自检${reason}，已保留原页`;
    }
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
      slide.html_content = originalHtml;
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "自检错误：" + genState.error;
      slide.html_content = originalHtml;
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}
```

- [ ] **Step 6: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: 手动验证单页生成 + 自检**

Run: `npm run tauri dev`，进入编辑器：
- 生成单页：对话框显示一句话设计思路 + `🎨 单页 HTML · 第 N 页` 卡片；iframe 逐 token 流式预览；DB `slides.html_content` 有值。
- 自检（`auto_selfcheck` 开）：自检后预览更新或保留原页；对话框显示自检 NL（Task 13 后 `runningOnCurrent` 含 selfcheck，本步可能仍静默——Task 13 修）。
- 失败注入：临时在 startSlide validate 改 `return "测试"`，确认重试一次后报错、不写半截 HTML。还原。

- [ ] **Step 8: Commit**
```bash
git add src/lib/prompt.ts src/lib/genStore.ts
git commit -m "feat(slide): 单页生成+自检改 write_slide_html/apply_selfcheck 工具调用"
```

---

## Task 10: 单页对话改工具调用（chatWithElementPrompt + sendChat）

**Files:**
- Modify: `src/lib/prompt.ts:236-254`（chatWithElementPrompt）
- Modify: `src/lib/genStore.ts`（sendChat 整个函数）

**Interfaces:**
- Consumes: Task 5 `slideHtmlTool`、Task 6 `runToolPhase`/`toolLabel`。
- Produces: 单页对话产出改写 HTML + assistant 消息（tool_call write_slide_html label）。

- [ ] **Step 1: 改 chatWithElementPrompt 为"调用工具"**

`src/lib/prompt.ts:236-254` 整个 `chatWithElementPrompt` 替换为：
```ts
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
```

- [ ] **Step 2: 替换 sendChat 整个函数**

`src/lib/genStore.ts` 中 `sendChat` 整个函数替换为：
```ts
// 对话修改单页：预览实时流（genState.artifact），完成写库 + 追加消息。
export async function sendChat(
  projectId: number,
  slides: Slide[],
  idx: number,
  instruction: string,
  element?: { html: string; selector: string }
): Promise<void> {
  const cur = slides[idx];
  if (!cur?.html_content) return;
  await addMessage(projectId, "user", instruction, cur.id);
  genState.projectId = projectId;
  genState.slideIdx = idx;
  genState.running = true;
  genState.phase = "chat";
  resetBuffers();
  try {
    const userPrompt = element
      ? chatWithElementPrompt({
          html: cur.html_content,
          elementHtml: element.html,
          selector: element.selector,
          instruction,
        })
      : `这是当前页 HTML：\n${cur.html_content}\n\n用户修改指令：${instruction}`;
    const r = await runToolPhase({
      systemPrompt:
        "你是专业前端。根据用户指令修改幻灯片，先用一两句说明改动，再调用 write_slide_html 提交修改后的完整 HTML 文档。",
      userPrompt,
      requiredTool: slideHtmlTool,
      artifactField: "html",
      validate: (parsed) => {
        const html = (parsed as { html?: string }).html ?? "";
        if (!/<html/i.test(html) || (!/\.slide\b/.test(html) && !/class="slide"/.test(html)))
          return "HTML 必须是含 .slide 画布的完整文档";
        return null;
      },
      execTool: async (_c, parsed) => {
        cur.html_content = cleanHtml((parsed as { html: string }).html);
        await upsertSlide(cur);
        return "已更新当前页";
      },
    });
    const label = toolLabel("write_slide_html", r.parsedArgs, { index: idx });
    await addMessage(
      projectId,
      "assistant",
      r.nlText || "已按指令更新当前页",
      cur.id,
      genState.reasoning,
      JSON.stringify({ name: "write_slide_html", label })
    );
    genState.status = "已更新";
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "错误：" + genState.error;
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}
```

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: 手动验证单页对话**

Run: `npm run tauri dev`，编辑器内对某页发"把标题放大、加 accent 条"：
- 对话框显示改动说明 NL + `🎨 单页 HTML` 卡片；iframe 逐 token 更新；DB 更新。
- 调试模式：开启调试模式点选元素，发指令，确认元素作用域改写 + 整页 HTML 提交。

- [ ] **Step 5: Commit**
```bash
git add src/lib/prompt.ts src/lib/genStore.ts
git commit -m "feat(chat): 单页对话改 write_slide_html 工具调用（含调试模式元素作用域）"
```

## Task 11: ChatPanel — markdown 渲染 + 工具卡片

**Files:**
- Modify: `package.json`（增 marked + dompurify）
- Modify: `src/components/ChatPanel.vue`（script 加 renderMd/toolLabelOf；template 改 assistant 渲染 + 工具卡片；style 加 .md/.msg-tool）

**Interfaces:**
- Consumes: Task 1 `Message.tool_call`。
- Produces: 对话框 assistant 消息 markdown 渲染（`**加粗**`/列表/标题）+ 可折叠工具调用卡片（显示 `tool_call.label`）。

- [ ] **Step 1: 安装依赖**

Run: `npm i marked dompurify`
Expected: `package.json` dependencies 增 `marked` 与 `dompurify`（两者均自带 TS 类型，无需 @types）。

- [ ] **Step 2: ChatPanel script 加渲染函数**

`src/components/ChatPanel.vue` `<script setup>` 顶部 import 区加：
```ts
import { marked } from "marked";
import DOMPurify from "dompurify";
```
在 `defineEmits` 之后加：
```ts
/** assistant 消息 markdown 渲染为安全 HTML（防注入）。 */
function renderMd(s: string): string {
  if (!s) return "";
  return DOMPurify.sanitize(marked.parse(s) as string);
}
/** 工具调用卡片的一行标签（从 messages.tool_call JSON 取 label）。 */
function toolLabelOf(m: Message): string | null {
  if (!m.tool_call) return null;
  try {
    return (JSON.parse(m.tool_call) as { label?: string }).label ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: ChatPanel template 改渲染 + 工具卡片**

`src/components/ChatPanel.vue` 模板中消息循环（`<div v-for="m in messages"...>` 块内）替换为：
```vue
      <div v-for="m in messages" :key="m.id ?? m.content" class="msg" :class="m.role">
        <span class="role">{{ m.role }}</span>
        <div v-if="m.role === 'assistant'" class="md" v-html="renderMd(m.content)"></div>
        <div v-else>{{ m.content }}</div>
        <!-- 工具调用卡片：工具调用产物阶段回填的 {name,label} -->
        <details v-if="m.role === 'assistant' && toolLabelOf(m)" class="msg-tool">
          <summary>{{ toolLabelOf(m) }}</summary>
        </details>
        <!-- 持久化思考：完成时回填到助手消息上，默认收起，可点开 -->
        <details v-if="m.role === 'assistant' && m.reasoning" class="msg-reasoning">
          <summary>思考 · {{ m.reasoning.length }} 字</summary>
          <pre>{{ m.reasoning }}</pre>
        </details>
      </div>
```

- [ ] **Step 4: ChatPanel style 加 .md / .msg-tool**

`src/components/ChatPanel.vue` `<style scoped>` 末尾（`</style>` 前）加：
```css
.msg.assistant .md {
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}
.msg.assistant .md :first-child {
  margin-top: 0;
}
.msg.assistant .md :last-child {
  margin-bottom: 0;
}
.msg.assistant .md p {
  margin: 0 0 6px;
}
.msg.assistant .md ul,
.msg.assistant .md ol {
  margin: 0 0 6px;
  padding-left: 20px;
}
.msg.assistant .md code {
  background: #f0f1f3;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.msg-tool {
  margin-top: 6px;
}
.msg-tool summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--primary);
  background: #eef;
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
}
```

- [ ] **Step 5: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 手动验证对话框**

Run: `npm run tauri dev`，触发任意阶段（如大纲对话）：
- assistant 消息 markdown 正常渲染（加粗/列表可见，非原始 `**` 符号）。
- 工具卡片显示一行标签（如 `🗂 大纲 · 12 页`），可折叠。
- 旧消息（tool_call=null）无卡片，正常显示。

- [ ] **Step 7: Commit**
```bash
git add package.json package-lock.json src/components/ChatPanel.vue
git commit -m "feat(chat): ChatPanel markdown 渲染 + 工具调用卡片"
```

---

## Task 12: Outline.vue — 删原始 JSON 流 / 读 artifact

**Files:**
- Modify: `src/pages/Outline.vue:14`（import 去 parseOutline）、`36-47`（outlineView 只读 DB）、`123-138`（manuscript 面板读 artifact + 删原始 content `<pre>`）

**Interfaces:**
- Consumes: Task 6 `genState.artifact`。
- Produces: 大纲页生成中显示"正在生成大纲…"占位（无原始 JSON）；文案面板读 `genState.artifact`。

- [ ] **Step 1: 去 parseOutline import**

`src/pages/Outline.vue:14` 替换为：
```ts
import { type OutlineSlide } from "../lib/prompt";
```

- [ ] **Step 2: outlineView 只从 DB 渲染**

`src/pages/Outline.vue:36-47` 的 `outlineView` computed 替换为：
```ts
// 当前大纲结构化展示：从库中已存大纲渲染（生成中显示占位，落地后由 watch(running) 重载）
const outlineView = computed<OutlineSlide[]>(() =>
  slides.value
    .map((s) => (s.outline ? (JSON.parse(s.outline) as OutlineSlide) : null))
    .filter((s): s is OutlineSlide => s !== null)
);
```

- [ ] **Step 3: manuscript 面板读 artifact + 删原始 JSON `<pre>`**

`src/pages/Outline.vue:123-138`（`<details manuscript-block>` + `.stream` 块）替换为：
```vue
        <details
          v-if="project.manuscript || (isRunning && genState.phase === 'manuscript')"
          class="manuscript-block"
          open
        >
          <summary>
            完整文案（{{ (project.manuscript || genState.artifact).length }} 字）
          </summary>
          <pre>{{ project.manuscript || genState.artifact }}</pre>
        </details>
        <div v-if="isRunning && !outlineView.length" class="stream">
          <div v-if="genState.reasoning" class="block">
            <span class="label">思考 / 调研</span>
            <pre ref="reasoningEl">{{ genState.reasoning }}</pre>
          </div>
          <div class="block">
            <span class="label">
              {{ genState.phase === 'manuscript' ? '文案（生成中）' : '大纲（生成中）' }}
            </span>
            <pre>{{ genState.phase === 'manuscript' ? (project.manuscript || genState.artifact) : '正在生成大纲…' }}</pre>
          </div>
        </div>
```
注：去掉了原 `{{ genState.content }}` 原始 JSON 流；manuscript 阶段显示 artifact（文案），outline 阶段显示占位文。

- [ ] **Step 4: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: 手动验证大纲页**

Run: `npm run tauri dev`，新建项目跑到大纲：
- 文案阶段：文案面板逐字流式（artifact）；对话框显示 NL（非原始 markdown 源码）。
- 大纲阶段：主面板显示"正在生成大纲…"占位（**无原始 JSON 文本**）；完成后卡片出现。
- 大纲对话：发指令，主面板无 JSON 闪烁，卡片更新。

- [ ] **Step 6: Commit**
```bash
git add src/pages/Outline.vue
git commit -m "feat(outline): 删原始 JSON 流，文案面板读 artifact，大纲占位"
```

---

## Task 13: Editor.vue — currentHtml 读 artifact + selfcheck 纳入 runningOnCurrent

**Files:**
- Modify: `src/pages/Editor.vue:37-42`（runningOnCurrent 加 selfcheck）、`66-81`（currentHtml 读 artifact + selfcheck）

**Interfaces:**
- Consumes: Task 6 `genState.artifact`。
- Produces: 单页/对话/自检期间 iframe 读 `genState.artifact` 逐 token 预览；自检时对话框显示思考。

- [ ] **Step 1: runningOnCurrent 加 selfcheck**

`src/pages/Editor.vue:37-42` 替换为：
```ts
const runningOnCurrent = computed(
  () =>
    runningHere.value &&
    genState.slideIdx === currentIdx.value &&
    (genState.phase === "slide" || genState.phase === "chat" || genState.phase === "selfcheck")
);
```

- [ ] **Step 2: currentHtml 读 artifact + selfcheck**

`src/pages/Editor.vue:66-81` 替换为：
```ts
const currentHtml = computed(() => {
  const cur = current.value;
  if (!cur) return "";
  if (
    runningHere.value &&
    genState.slideIdx === currentIdx.value &&
    (genState.phase === "slide" || genState.phase === "chat" || genState.phase === "selfcheck")
  ) {
    // 工具参数流式提取的 html（artifact）非空才用实时流；首个 chunk 到达前回退原页
    const live = cleanHtml(genState.artifact);
    if (live) return live;
    return cur.html_content ?? "";
  }
  return cur.html_content ?? "";
});
```

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: 手动验证编辑器**

Run: `npm run tauri dev`，编辑器内：
- 单页生成：iframe 逐 token 流式（artifact）；对话框显示设计思路 + 思考。
- 自检：iframe 更新；对话框显示自检思考（不再静默）。
- 单页对话：iframe 逐 token 更新。

- [ ] **Step 5: Commit**
```bash
git add src/pages/Editor.vue
git commit -m "feat(editor): currentHtml 读 artifact + selfcheck 纳入 runningOnCurrent"
```

---

## Task 14: 清理 — 删 json_mode + parseOutline/extractFirstJsonObject

**Files:**
- Modify: `src/lib/chat.ts`（chat/chatOnce 去 jsonMode 参数 + 调用点去 `false`）
- Modify: `src-tauri/src/lib.rs`（ChatConfig 去 json_mode + OpenAI response_format 分支）
- Modify: `src/lib/prompt.ts`（删 extractFirstJsonObject + parseOutline）

**Interfaces:** 无新接口；纯删死代码。

- [ ] **Step 1: chat.ts chat() 去 jsonMode**

`src/lib/chat.ts` `chat` 函数签名去掉第 4 参 `jsonMode = false`，函数体去掉 `json_mode: jsonMode,` 配置行。签名变为：
```ts
export async function chat(
  messages: ChatMsg[],
  onChunk: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  opts?: {
    tools?: ToolDef[];
    toolChoice?: ToolChoice;
    onToolCalls?: (calls: ToolCall[]) => void;
    onToolArgs?: (e: { name: string; delta: string }) => void;
  }
): Promise<{ toolCalls: ToolCall[] | null }> {
```
config 对象去掉 `json_mode: jsonMode,` 这一行。

- [ ] **Step 2: chat.ts chatOnce() 去 jsonMode**

`chatOnce` 替换为：
```ts
export async function chatOnce(
  messages: ChatMsg[],
  onReasoning?: (delta: string) => void
): Promise<string> {
  let full = "";
  await chat(messages, (d) => (full += d), onReasoning);
  return full;
}
```

- [ ] **Step 3: 更新所有 chat() 调用点（去 `false` 实参）**

`src/lib/chat.ts` `chatAgent` 内两处 `chat(messages, ..., false, { tools, toolChoice, onToolArgs })` 与末尾 `chat(messages, ..., false, { tools, toolChoice: ..., onToolArgs })`，去掉 `false` 实参（第 4 参已删）。

`src/lib/genStore.ts` `runToolPhase` 内 `await chat(messages, ..., false, { tools, toolChoice, onToolArgs })` 去掉 `false`。

`src/lib/genStore.ts` `selfCheckSlide` 内 `await chat([...], ..., false, { tools, toolChoice, onToolArgs })` 去掉 `false`。

- [ ] **Step 4: Rust ChatConfig 去 json_mode + response_format 分支**

`src-tauri/src/lib.rs` `ChatConfig` 结构体去掉：
```rust
    #[serde(default)]
    json_mode: bool,
```
OpenAI 分支末尾的 `if config.json_mode { ... response_format ... }` 整块删除：
```rust
        if config.json_mode {
            if let Some(obj) = body.as_object_mut() {
                obj.insert("response_format".to_string(), serde_json::json!({"type":"json_object"}));
            }
        }
```

- [ ] **Step 5: prompt.ts 删 parseOutline + extractFirstJsonObject**

`src/lib/prompt.ts` 删除 `extractFirstJsonObject`（约 102-128 行）与 `parseOutline`（约 130-145 行）两个函数。**保留 `cleanHtml`**。

- [ ] **Step 6: 类型检查 + cargo check**

Run: `npx vue-tsc --noEmit`
Expected: 无错误（确认无残留 parseOutline/jsonMode 引用）。

Run（在 `src-tauri/` 下）: `cargo check`
Expected: 编译通过。

- [ ] **Step 7: 手动验证无回归**

Run: `npm run tauri dev`，快速跑一遍文案→大纲→单页，确认全流程正常（json_mode 删除不影响工具流程）。

- [ ] **Step 8: Commit**
```bash
git add src/lib/chat.ts src/lib/genStore.ts src/lib/prompt.ts src-tauri/src/lib.rs
git commit -m "chore: 删 json_mode + parseOutline/extractFirstJsonObject 死代码"
```

---

## Task 15: 最终验证矩阵

**Files:** 无改动；纯验证。

- [ ] **Step 1: 双格式全流程**

配置两个 AI（一个 OpenAI 兼容如 DeepSeek，一个 Anthropic），各跑一遍完整流程：文案（联网+离线）→大纲→大纲对话→逐页生成→自检→单页对话→导出。
确认每环节：对话框显示自然语言 NL + 工具卡片；预览实时流；DB 落库正确；导出 PPT 正常。

- [ ] **Step 2: 强制调用验证**

每个环节确认工具被调用并落库（消息有 tool_call 卡片）。

- [ ] **Step 3: 失败注入**

临时在某 validate 函数加 `return "测试失败"`，确认：重试一次后报错、不写半截数据、UI 显示错误状态。还原。

- [ ] **Step 4: 取消验证**

各阶段中途点"取消"：确认无半截数据落库；自检取消还原原页；文案取消不写 manuscript。

- [ ] **Step 5: 旧项目兼容**

打开已有项目（含 manuscript）：确认跳过文案直接拆页；旧 messages（tool_call=null）无卡片正常显示。

- [ ] **Step 6: 类型检查 + 构建**

Run: `npx vue-tsc --noEmit`
Run: `npm run build`
Expected: 均通过（vue-tsc + vite build）。

- [ ] **Step 7: 清理 sanity 脚本（可选）**

`scripts/verify-tool-utils.ts` 可保留作回归手检，或删除：
```bash
git rm scripts/verify-tool-utils.ts   # 若决定删除
```

- [ ] **Step 8: 最终 Commit（若有清理）**
```bash
git commit -m "chore: 清理验证脚本" # 仅当 Step 7 删除时
```

---

## Self-Review 结果

**1. Spec coverage**：规格 13 节均有对应任务——genState 拆分(Task 6)/四工具(Task 5)/runToolPhase+chatAgent(Task 4,6)/各阶段(Task 7-10)/Rust tool_choice+chat-tool-args+删json_mode(Task 2,3,14)/ChatPanel markdown+卡片(Task 11)/migration 007(Task 1)/删parseOutline(Task 14)/Outline+Editor(Task 12,13)/五层强制(Task 6,7-10 validate+retry)/测试矩阵(Task 15)。无遗漏。

**2. Placeholder scan**：无 TBD/TODO；每步含完整代码或精确命令。

**3. Type consistency**：`runToolPhase` 返回 `{nlText, parsedArgs, call}`（Task 6 定义，Task 7-10 消费一致）；`extractStringArg(partial): string`、`toolLabel(name, args, ctx?): string`（Task 6 定义，多处消费一致）；`ToolChoice` 类型（Task 4 定义，genStore 用 `{type:"tool",name}` 字面量，Rust 用同形 enum）；`Message.tool_call`（Task 1 定义，Task 11 消费）。已检查一致。




