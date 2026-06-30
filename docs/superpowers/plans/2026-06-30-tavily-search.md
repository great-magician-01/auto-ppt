# Tavily 联网搜索 + 文案先行生成 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为「纸光幻演」新增 Tavily 联网搜索（search+extract 作为 LLM 工具可多次调用），并把大纲生成重构为「先写完整文案 → 再按文案拆页」两阶段，导出时文案写入 pptx 讲者备注。

**Architecture:** 新增 Rust `tavily_search`/`tavily_extract` 命令并扩展 `chat_stream` 流式解析双格式 tool_call；前端 `chatAgent()` 多轮 agent loop 调用工具调研后产出 markdown 文案；DB migration 006 加 `projects.manuscript`/`search_enabled`；提示词拆为 `manuscriptPrompt`+`splitOutlinePrompt`；导出讲者备注。

**Tech Stack:** Tauri 2 / Rust(reqwest+rustls-tls+serde_json+futures-util) · Vue 3 + TS (Vite) · SQLite (@tauri-apps/plugin-sql) · pptxgenjs

## Global Constraints

- 用户可见文案/Prompt 用中文；代码注释用中文（与现仓库一致）。
- Tavily API: `POST https://api.tavily.com/search` 与 `POST https://api.tavily.com/extract`，Header `Authorization: Bearer <key>`，固定 `search_depth:"basic"` / `extract_depth:"basic"`。
- 积分规则：search basic = 1/次；extract basic = ceil(成功URL/5)。优先用响应 `usage.credits`，缺失才本地估算。
- 调用上限：LLM ≤50 轮、工具 ≤20 次，触顶强制收尾。
- `reqwest` 已有 `rustls-tls`+`stream`+`json`，不新增 Rust 依赖；`Cargo.lock` 须跟踪（勿 gitignore）。
- 新命令无需改 capabilities（与 `list_models` 同级，纯命令）。
- CSP 为 `null`（幻灯片依赖内联 CSS，保持不变）。
- `SLIDE_W=1920`/`SLIDE_H=1080` 是画布单一真相源，导出/预览/截图共享，本特性不改画布。
- 现有 `chat(...)` 调用者均忽略返回值；改返回类型不破坏它们（未传 `tools` 时 `toolCalls` 恒 `null`）。
- 没有 test 框架；验证用 `npm run build`（vue-tsc 类型检查 + vite build）与手动 `npm run tauri dev` 冒烟。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src-tauri/migrations/006_add_manuscript_and_search.sql` | DB 迁移：projects 加 manuscript/search_enabled | 创建 |
| `src-tauri/src/lib.rs` | `tavily_search`/`tavily_extract` 命令 + `chat_stream` 工具调用支持 + 注册命令 + migration v6 | 修改 |
| `src/lib/db.ts` | Project 接口加字段；createProject 增参；updateProject Pick 扩展 | 修改 |
| `src/lib/tavily.ts` | Tavily 调用封装 + 用量记录（settings.tavily_usage） | 创建 |
| `src/lib/chat.ts` | ToolDef/ToolCall 类型；chat 增 tools/onToolCalls 返回 toolCalls；chatAgent() loop | 修改 |
| `src/lib/prompt.ts` | manuscriptPrompt + splitOutlinePrompt + tavily 工具定义；OutlineSlide 加 notes | 修改 |
| `src/lib/genStore.ts` | GenPhase 加 manuscript；startOutline 重构为 manuscript+outline 两阶段 + execTool | 修改 |
| `src/lib/ppt.ts` | exportPptx 每页 addNotes | 修改 |
| `src/pages/Settings.vue` | Tavily Key 输入 + 测试 + 用量显示 | 修改 |
| `src/pages/ProjectList.vue` | onMounted 读 key；新建表单联网开关 | 修改 |
| `src/pages/Outline.vue` | auto-start 传 search_enabled；阶段标签；文案面板 | 修改 |

---

### Task 1: DB migration 006 + db.ts 接口

**Files:**
- Create: `src-tauri/migrations/006_add_manuscript_and_search.sql`
- Modify: `src-tauri/src/lib.rs` (run() migrations vec)
- Modify: `src/lib/db.ts:12-86`

**Interfaces:**
- Produces: `Project.manuscript?: string | null`、`Project.search_enabled?: number`；`createProject(title, topic, style?, searchEnabled?)`；`updateProject` 接受 `manuscript`/`search_enabled`。后续 Task 4(genStore)/8(ProjectList) 依赖这些。

- [ ] **Step 1: 创建迁移文件**

Create `src-tauri/migrations/006_add_manuscript_and_search.sql`:

```sql
-- 文案先行：完整文案存 projects.manuscript；联网搜索开关存 projects.search_enabled
ALTER TABLE projects ADD COLUMN manuscript TEXT;
ALTER TABLE projects ADD COLUMN search_enabled INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: 在 lib.rs 注册 migration v6**

Modify `src-tauri/src/lib.rs` — 在 `run()` 的 `migrations` vec 末尾（version 5 之后）追加：

```rust
        tauri_plugin_sql::Migration {
            version: 6,
            description: "add manuscript and search_enabled to projects",
            sql: include_str!("../migrations/006_add_manuscript_and_search.sql"),
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
```

- [ ] **Step 3: db.ts 扩展 Project 接口**

Modify `src/lib/db.ts:12-21` — `Project` 接口加两字段：

```ts
export interface Project {
  id?: number;
  title: string;
  topic: string;
  style?: string | null;
  design_tokens?: string | null;
  theme_css?: string | null;
  manuscript?: string | null;
  search_enabled?: number;
  created_at?: string;
  updated_at?: string;
}
```

- [ ] **Step 4: db.ts createProject 增参**

Modify `src/lib/db.ts:59-70` — `createProject` 加 `searchEnabled` 参：

```ts
export async function createProject(
  title: string,
  topic: string,
  style?: string | null,
  searchEnabled?: boolean
): Promise<number> {
  const d = await db();
  const r = await d.execute(
    "INSERT INTO projects(title, topic, style, search_enabled) VALUES(?, ?, ?, ?)",
    [title, topic, style ?? null, searchEnabled ? 1 : 0]
  );
  return Number(r.lastInsertId);
}
```

- [ ] **Step 5: db.ts updateProject Pick 扩展**

Modify `src/lib/db.ts:72-75` — Pick 加 `manuscript`/`search_enabled`：

```ts
export async function updateProject(
  id: number,
  fields: Partial<Pick<Project, "title" | "design_tokens" | "theme_css" | "style" | "manuscript" | "search_enabled">>
) {
```

（函数体不变，已按字段名动态构造 SET。）

- [ ] **Step 6: 类型检查 + 提交**

Run: `npm run build`
Expected: vue-tsc 通过（无类型错误），vite build 成功。

```bash
git add src-tauri/migrations/006_add_manuscript_and_search.sql src-tauri/src/lib.rs src/lib/db.ts
git commit -m "feat(db): migration 006 加 manuscript/search_enabled，db.ts 接口扩展"
```

---

### Task 2: Rust tavily_search / tavily_extract 命令

**Files:**
- Modify: `src-tauri/src/lib.rs` (新增命令 + 注册)

**Interfaces:**
- Produces: `tavily_search { api_key, query } -> { answer, results:[{title,url,content}], credits }`；`tavily_extract { api_key, urls } -> { results:[{url,raw_content}], failed:[{url,error}], credits }`。Task 5(execTool) 经 `invoke` 调用它们。

- [ ] **Step 1: 新增结构体与命令（追加到 cancel_chat 之后）**

Modify `src-tauri/src/lib.rs` — 在 `cancel_chat` 函数之后、`save_file` 之前插入：

```rust
#[derive(Debug, Deserialize)]
struct TavilyConfig {
    api_key: String,
}

#[derive(Debug, Serialize)]
struct TavilySearchItem {
    title: String,
    url: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct TavilySearchResult {
    answer: String,
    results: Vec<TavilySearchItem>,
    credits: i64,
}

/// 联网搜索：POST https://api.tavily.com/search（Bearer）。固定 basic depth（1 积分/次）。
#[tauri::command]
async fn tavily_search(
    config: TavilyConfig,
    query: String,
) -> Result<TavilySearchResult, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let body = serde_json::json!({
        "query": query,
        "search_depth": "basic",
        "topic": "general",
        "include_answer": true,
        "max_results": 5,
        "include_usage": true,
    });
    let resp = client
        .post("https://api.tavily.com/search")
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
    let answer = v["answer"].as_str().unwrap_or("").to_string();
    let mut results = Vec::new();
    if let Some(arr) = v["results"].as_array() {
        for r in arr {
            let content = r["content"].as_str().unwrap_or("").to_string();
            let content = if content.len() > 1500 { content[..1500].to_string() } else { content };
            results.push(TavilySearchItem {
                title: r["title"].as_str().unwrap_or("").to_string(),
                url: r["url"].as_str().unwrap_or("").to_string(),
                content,
            });
        }
    }
    let credits = v["usage"]["credits"].as_i64().unwrap_or(1);
    Ok(TavilySearchResult { answer, results, credits })
}

#[derive(Debug, Serialize)]
struct TavilyExtractItem {
    url: String,
    raw_content: String,
}

#[derive(Debug, Serialize)]
struct TavilyExtractResult {
    results: Vec<TavilyExtractItem>,
    failed: Vec<TavilyExtractItem>,
    credits: i64,
}

/// 提取网页全文：POST https://api.tavily.com/extract（Bearer）。固定 basic depth（每 5 成功 URL = 1 积分）。
#[tauri::command]
async fn tavily_extract(
    config: TavilyConfig,
    urls: Vec<String>,
) -> Result<TavilyExtractResult, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let body = serde_json::json!({
        "urls": urls,
        "format": "markdown",
        "extract_depth": "basic",
        "include_usage": true,
    });
    let resp = client
        .post("https://api.tavily.com/extract")
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
    let mut results = Vec::new();
    if let Some(arr) = v["results"].as_array() {
        for r in arr {
            let raw = r["raw_content"].as_str().unwrap_or("").to_string();
            let raw = if raw.len() > 4000 { raw[..4000].to_string() } else { raw };
            results.push(TavilyExtractItem {
                url: r["url"].as_str().unwrap_or("").to_string(),
                raw_content: raw,
            });
        }
    }
    // failed_results 只有 url + error，这里归一为 {url, raw_content:"<failed: error>"} 便于前端展示
    let mut failed = Vec::new();
    if let Some(arr) = v["failed_results"].as_array() {
        for r in arr {
            let err = r["error"].as_str().unwrap_or("unknown");
            failed.push(TavilyExtractItem {
                url: r["url"].as_str().unwrap_or("").to_string(),
                raw_content: format!("<failed: {}>", err),
            });
        }
    }
    let success = results.len() as i64;
    let credits = v["usage"]["credits"]
        .as_i64()
        .unwrap_or_else(|| ((success + 4) / 5).max(0));
    Ok(TavilyExtractResult { results, failed, credits })
}
```

- [ ] **Step 2: 注册到 invoke_handler**

Modify `src-tauri/src/lib.rs` — `invoke_handler!` 宏内加两命令：

```rust
        .invoke_handler(tauri::generate_handler![
            chat_stream, cancel_chat, save_file, list_models, tavily_search, tavily_extract
        ])
```

- [ ] **Step 3: Rust 编译检查 + 提交**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，无错误。

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(rust): tavily_search / tavily_extract 命令"
```

---

### Task 3: Rust chat_stream 工具调用支持

**Files:**
- Modify: `src-tauri/src/lib.rs` (ChatConfig/ChatMessage 结构 + body 构造 + 流式 tool_call 解析 + chat-tool-calls 事件)

**Interfaces:**
- Produces: `chat_stream` 接受可选 `tools: Vec<ToolDef>`，回合结束发 `chat-tool-calls` 事件(payload `Vec<ToolCall>`，`{id,name,arguments:string}`)；`ChatMessage` 带 `tool_calls`/`tool_call_id`。Task 4(chat.ts)订阅该事件。

- [ ] **Step 1: 扩展 ChatConfig / ChatMessage 结构**

Modify `src-tauri/src/lib.rs:6-27` — `ChatMessage` 加 `tool_calls`/`tool_call_id`，新增 `ToolDef`/`ToolCall`，`ChatConfig` 加 `tools`：

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String, // JSON 字符串
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ToolDef {
    name: String,
    description: String,
    parameters: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCall>,
    #[serde(default)]
    tool_call_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatConfig {
    api_base: String,
    api_key: String,
    model: String,
    #[serde(default)]
    format: String,
    #[serde(default)]
    thinking_mode: bool,
    #[serde(default)]
    thinking_effort: String,
    #[serde(default)]
    json_mode: bool,
    #[serde(default)]
    tools: Vec<ToolDef>,
}
```

- [ ] **Step 2: openai_messages 支持 tool / tool_call 角色**

Modify `src-tauri/src/lib.rs` — 替换整个 `openai_messages` 函数为：

```rust
/// OpenAI 消息数组：含图片时 content 组装成 text+image_url 数组；tool_calls / tool 结果按角色翻译
fn openai_messages(messages: &[ChatMessage]) -> serde_json::Value {
    serde_json::Value::Array(
        messages
            .iter()
            .map(|m| {
                if m.role == "tool" {
                    return serde_json::json!({
                        "role": "tool",
                        "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
                        "content": m.content,
                    });
                }
                if !m.tool_calls.is_empty() {
                    let calls: Vec<serde_json::Value> = m
                        .tool_calls
                        .iter()
                        .map(|c| {
                            serde_json::json!({
                                "id": c.id,
                                "type": "function",
                                "function": { "name": c.name, "arguments": c.arguments },
                            })
                        })
                        .collect();
                    return serde_json::json!({
                        "role": m.role,
                        "content": if m.content.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(m.content.clone()) },
                        "tool_calls": calls,
                    });
                }
                if m.images.is_empty() {
                    serde_json::json!({ "role": m.role, "content": m.content })
                } else {
                    let mut parts = vec![serde_json::json!({ "type": "text", "text": m.content })];
                    for img in &m.images {
                        parts.push(serde_json::json!({ "type": "image_url", "image_url": { "url": img } }));
                    }
                    serde_json::json!({ "role": m.role, "content": parts })
                }
            })
            .collect(),
    )
}
```

- [ ] **Step 3: anthropic_split 支持 tool / tool_call 角色**

Modify `src-tauri/src/lib.rs` — 替换整个 `anthropic_split` 函数为：

```rust
/// Anthropic：system 提到顶层字符串；非 system 进 messages。
/// assistant tool_use → content 块数组；role:"tool" → 作为 user 的 tool_result 块（紧随对应 tool_use）。
fn anthropic_split(messages: &[ChatMessage]) -> (String, Vec<serde_json::Value>) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut rest: Vec<serde_json::Value> = Vec::new();
    for m in messages {
        if m.role == "system" {
            system_parts.push(m.content.clone());
            continue;
        }
        if m.role == "tool" {
            // 工具结果：Anthropic 要求作为 user 消息的 tool_result 块
            rest.push(serde_json::json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                    "content": m.content,
                }],
            }));
            continue;
        }
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        if !m.tool_calls.is_empty() {
            let mut blocks: Vec<serde_json::Value> = Vec::new();
            if !m.content.is_empty() {
                blocks.push(serde_json::json!({ "type": "text", "text": m.content }));
            }
            for c in &m.tool_calls {
                let input: serde_json::Value =
                    serde_json::from_str(&c.arguments).unwrap_or(serde_json::json!({}));
                blocks.push(serde_json::json!({
                    "type": "tool_use",
                    "id": c.id,
                    "name": c.name,
                    "input": input,
                }));
            }
            rest.push(serde_json::json!({ "role": role, "content": blocks }));
            continue;
        }
        if m.images.is_empty() {
            rest.push(serde_json::json!({ "role": role, "content": m.content }));
        } else {
            let mut parts = vec![serde_json::json!({ "type": "text", "text": m.content })];
            for img in &m.images {
                let (media, data) = split_data_url(img);
                parts.push(serde_json::json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": media, "data": data }
                }));
            }
            rest.push(serde_json::json!({ "role": role, "content": parts }));
        }
    }
    (system_parts.join("\n\n"), rest)
}
```

- [ ] **Step 4: body 构造注入 tools**

Modify `src-tauri/src/lib.rs` — 在 `chat_stream` 中 OpenAI 分支（`else` 块，构造 body 之后、`if config.thinking_mode` 之前）注入 tools；Anthropic 分支（thinking 注入之后）注入 tools。

OpenAI 分支，在 `let mut body = serde_json::json!({...});` 之后追加：

```rust
        if !config.tools.is_empty() {
            let tools: Vec<serde_json::Value> = config.tools.iter().map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            }).collect();
            if let Some(obj) = body.as_object_mut() {
                obj.insert("tools".to_string(), serde_json::Value::Array(tools));
                obj.insert("tool_choice".to_string(), serde_json::json!("auto"));
            }
        }
```

Anthropic 分支，在 thinking 注入块之后追加：

```rust
        if !config.tools.is_empty() {
            let tools: Vec<serde_json::Value> = config.tools.iter().map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                })
            }).collect();
            if let Some(obj) = body.as_object_mut() {
                obj.insert("tools".to_string(), serde_json::Value::Array(tools));
            }
        }
```

- [ ] **Step 5: 流式 tool_call 解析 — OpenAI 分支**

Modify `src-tauri/src/lib.rs` — OpenAI SSE 解析 `else` 块（`if data == "[DONE]"` 之上、`if let Ok(v) = serde_json::from_str` 之内）增加 tool_calls 增量累积。在 streaming 闭包之前声明累积缓冲，并扩展解析。

先在 `let app2 = app.clone();` 之后、`let streaming = async move {` 之前插入累积缓冲声明：

```rust
    // tool_call 累积缓冲：按 OpenAI delta.tool_calls[].index 对齐
    let tool_acc: std::sync::Arc<std::sync::Mutex<Vec<ToolAccum>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let tool_acc2 = tool_acc.clone();
```

在 `ToolCall` 结构体定义之后（ChatMessage 附近）新增 `ToolAccum`：

```rust
#[derive(Debug, Default, Clone)]
struct ToolAccum {
    index: usize,
    id: String,
    name: String,
    arguments: String,
}
```

OpenAI 解析分支改为（替换原 `if let Ok(v) = serde_json::from_str...` 整块）：

```rust
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                        let delta = &v["choices"][0]["delta"];
                        if let Some(content) = delta["content"].as_str() {
                            if !content.is_empty() {
                                let _ = app2.emit("chat-chunk", content);
                            }
                        }
                        if let Some(reasoning) = delta["reasoning_content"].as_str() {
                            if !reasoning.is_empty() {
                                let _ = app2.emit("chat-reasoning", reasoning);
                            }
                        }
                        // tool_calls 增量：按 index 累积 id/name/arguments
                        if let Some(calls) = delta["tool_calls"].as_array() {
                            if let Ok(mut acc) = tool_acc2.lock() {
                                for c in calls {
                                    let idx = c["index"].as_u64().unwrap_or(0) as usize;
                                    while acc.len() <= idx {
                                        acc.push(ToolAccum { index: acc.len(), ..Default::default() });
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
                                    }
                                }
                            }
                        }
                    }
```

- [ ] **Step 6: 流式 tool_call 解析 — Anthropic 分支 + 回合结束发送 chat-tool-calls**

Modify `src-tauri/src/lib.rs` — Anthropic 分支用 `ToolAccum` 累积 tool_use，用 `last_tool_slot`（最近一次 tool_use 块对应的累积槽位，-1 表示无）追踪，避免 text 块干扰槽位对齐；OpenAI `[DONE]` 与两格式流末尾统一发送 `chat-tool-calls`。

先把**原两参** `emit_anthropic_event(app, event, data)` 函数整体替换为下面的五参版（签名变了，旧调用点会在下一步同步更新）：

```rust
/// 解析单条 Anthropic SSE：text/thinking → 事件；tool_use 起止累积到 tool_acc。
/// last_tool_slot 指向"最近一次 content_block_start(tool_use) 创建的累积槽"，input_json_delta 追加到它。
fn emit_anthropic_event(
    app: &AppHandle,
    event: &str,
    data: &str,
    tool_acc: &std::sync::Arc<std::sync::Mutex<Vec<ToolAccum>>>,
    last_tool_slot: &mut i64,
) {
    if data == "[DONE]" {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return;
    };
    match event {
        "content_block_start" => {
            let b = &v["content_block"];
            if b["type"].as_str() == Some("tool_use") {
                if let Ok(mut acc) = tool_acc.lock() {
                    acc.push(ToolAccum {
                        index: acc.len(),
                        id: b["id"].as_str().unwrap_or("").to_string(),
                        name: b["name"].as_str().unwrap_or("").to_string(),
                        arguments: String::new(),
                    });
                    *last_tool_slot = (acc.len() as i64) - 1;
                }
            }
            // text/thinking 块不占累积槽，last_tool_slot 不变
        }
        "content_block_delta" => {
            let delta = &v["delta"];
            match delta["type"].as_str() {
                Some("text_delta") => {
                    if let Some(text) = delta["text"].as_str() {
                        if !text.is_empty() {
                            let _ = app.emit("chat-chunk", text);
                        }
                    }
                }
                Some("thinking_delta") => {
                    if let Some(th) = delta["thinking"].as_str() {
                        if !th.is_empty() {
                            let _ = app.emit("chat-reasoning", th);
                        }
                    }
                }
                Some("input_json_delta") => {
                    if let Some(pj) = delta["partial_json"].as_str() {
                        if let Ok(mut acc) = tool_acc.lock() {
                            let i = *last_tool_slot as usize;
                            if i < acc.len() {
                                acc[i].arguments.push_str(pj);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        "content_block_stop" => {
            // 不动 last_tool_slot：下个 tool_use 的 start 会覆盖它；text 块 stop 也无害
        }
        "message_stop" => {
            let _ = app.emit("chat-done", ());
        }
        _ => {}
    }
}
```

把 Anthropic 分支的 `while let Some(chunk) = ...` 循环替换为（注意 `last_tool_slot` 声明 + 调用新签名）：

```rust
            // Anthropic SSE：跟踪 event，遇空行处理 data；累积 tool_use 块
            let mut cur_event = String::new();
            let mut data_buf = String::new();
            let mut last_tool_slot: i64 = -1;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("读取流失败: {e}"))?;
                buf.push_str(&String::from_utf8_lossy(&chunk));
                loop {
                    let Some(idx) = buf.find('\n') else {
                        break;
                    };
                    let line = buf[..idx].trim_end().to_string();
                    buf = buf[idx + 1..].to_string();
                    if line.is_empty() {
                        if !data_buf.is_empty() {
                            emit_anthropic_event(&app2, &cur_event, &data_buf, &tool_acc2, &mut last_tool_slot);
                        }
                        cur_event.clear();
                        data_buf.clear();
                        continue;
                    }
                    if let Some(ev) = line.strip_prefix("event:") {
                        cur_event = ev.trim().to_string();
                    } else if let Some(d) = line.strip_prefix("data:") {
                        if !data_buf.is_empty() {
                            data_buf.push('\n');
                        }
                        data_buf.push_str(d.trim());
                    }
                }
            }
            if !data_buf.is_empty() {
                emit_anthropic_event(&app2, &cur_event, &data_buf, &tool_acc2, &mut last_tool_slot);
            }
```

新增辅助函数 `emit_tool_calls`（放在 `emit_anthropic_event` 之后）：

```rust
/// 回合结束：若有累积的 tool_call，发 chat-tool-calls 事件（payload Vec<ToolCall>）。
fn emit_tool_calls(app: &AppHandle, tool_acc: &std::sync::Arc<std::sync::Mutex<Vec<ToolAccum>>>) {
    let calls: Vec<ToolCall> = if let Ok(acc) = tool_acc.lock() {
        acc.iter()
            .filter(|a| !a.name.is_empty())
            .map(|a| ToolCall {
                id: a.id.clone(),
                name: a.name.clone(),
                arguments: a.arguments.clone(),
            })
            .collect()
    } else {
        Vec::new()
    };
    if !calls.is_empty() {
        let _ = app.emit("chat-tool-calls", calls);
    }
}
```

OpenAI 分支的 `if data == "[DONE]"` 块改为：

```rust
                    if data == "[DONE]" {
                        emit_tool_calls(&app2, &tool_acc2);
                        let _ = app2.emit("chat-done", ());
                        return Ok(());
                    }
```

两格式流末尾兜底 `let _ = app2.emit("chat-done", ());` 之前都插入 `emit_tool_calls(&app2, &tool_acc2);`（OpenAI 与 Anthropic 分支循环之后、兜底 `chat-done` 之前各一处）。

- [ ] **Step 7: Rust 编译检查 + 提交**

Run: `cd src-tauri && cargo check`
Expected: 编译通过（有 unused 警告可忽略，后续 Task 消除）。

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(rust): chat_stream 支持 LLM 工具调用（双格式 tool_call 流式解析 + chat-tool-calls 事件）"
```

---

### Task 4: 前端 chat.ts — ToolDef/ToolCall 类型 + chat 返回 toolCalls + chatAgent loop

**Files:**
- Modify: `src/lib/chat.ts`

**Interfaces:**
- Produces: `ToolDef`、`ToolCall` 类型；`ChatMsg.tool_calls?`/`tool_call_id?`；`chat(messages, onChunk, onReasoning?, jsonMode?, opts?: {tools?, onToolCalls?}) -> Promise<{toolCalls}>`；`chatAgent(initMessages, tools, execTool, onChunk, onReasoning?, onRoundStart?, limits?) -> Promise<string>`（返回最终文案文本）。Task 7(genStore) 调用 `chatAgent`。

- [ ] **Step 1: 扩展 ChatMsg 类型 + 新增 ToolDef/ToolCall**

Modify `src/lib/chat.ts:6-11` — `ChatMsg` 加可选字段，并在其后新增类型：

```ts
export interface ChatMsg {
  role: ChatRole | "tool";
  content: string;
  /** dataURL 数组（多模态自检时附截图），OpenAI→image_url，Anthropic→image base64 */
  images?: string[];
  /** assistant 消息携带的工具调用（OpenAI/Anthropic 双格式由 Rust 翻译） */
  tool_calls?: ToolCall[];
  /** role:"tool" 时携带，对应 assistant 的 tool_call_id */
  tool_call_id?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: object; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串
}
```

- [ ] **Step 2: chat() 增 opts 参数 + 返回 toolCalls**

Modify `src/lib/chat.ts` — 替换整个 `chat` 函数为：

```ts
export async function chat(
  messages: ChatMsg[],
  onChunk: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  jsonMode = false,
  opts?: {
    tools?: ToolDef[];
    onToolCalls?: (calls: ToolCall[]) => void;
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
  if (opts?.tools?.length) config.tools = opts.tools;

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
    onStartUn();
  }
  return { toolCalls: collected };
}
```

- [ ] **Step 3: chatOnce 适配新签名**

Modify `src/lib/chat.ts` — 替换 `chatOnce` 函数为：

```ts
export async function chatOnce(
  messages: ChatMsg[],
  onReasoning?: (delta: string) => void,
  jsonMode = false
): Promise<string> {
  let full = "";
  await chat(messages, (d) => (full += d), onReasoning, jsonMode);
  return full;
}
```

- [ ] **Step 4: 新增 chatAgent loop**

Modify `src/lib/chat.ts` — 文件末尾追加：

```ts
/**
 * 多轮 agent loop：模型可用工具调研，每轮执行工具并把结果回填，直到无工具调用的最终回复。
 * - 每轮开始调 onRoundStart（调用方在此清空 genState.content，避免中间文本污染最终文案）。
 * - chatAgent 内部也累加 finalText 用于 return，同时通过 onChunk 把最终轮 token 推给 UI 实时显示。
 * - 调用上限：默认 LLM ≤50 轮、工具 ≤20 次，触顶追加 system 指令强制收尾。
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
  }
): Promise<string> {
  const messages: ChatMsg[] = [...initMessages];
  let toolCount = 0;
  let finalText = "";
  for (let round = 0; round < limits.maxLlmRounds; round++) {
    onRoundStart?.(); // 调用方清空 genState.content
    finalText = "";
    const { toolCalls } = await chat(
      messages,
      (d) => {
        finalText += d;
        onChunk(d);
      },
      onReasoning,
      false,
      { tools }
    );
    if (!toolCalls || !toolCalls.length) {
      return finalText; // 无工具调用 = 最终回复
    }
    // assistant 工具调用消息回填
    messages.push({ role: "assistant", content: finalText, tool_calls: toolCalls });
    const remaining = limits.maxToolCalls - toolCount;
    const callsToExec = toolCalls.slice(0, Math.max(0, remaining));
    for (const call of callsToExec) {
      const result = await execTool(call);
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
      toolCount++;
    }
    // 超过工具上限：强制收尾
    if (toolCount >= limits.maxToolCalls) {
      messages.push({
        role: "system",
        content:
          "已达到工具调用上限，请停止调用工具，直接基于已有信息产出最终文案。",
      });
    }
  }
  // 触顶 LLM 轮数：最后一轮强制无工具请求
  onRoundStart?.();
  finalText = "";
  await chat(
    messages,
    (d) => {
      finalText += d;
      onChunk(d);
    },
    onReasoning,
    false
  );
  return finalText;
}
```

注：`execTool`（在 genStore 中定义）自行往 `genState.reasoning` 追加详细审计行（含积分），故本函数不再单独设 `onToolActivity` 回调。

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run build`
Expected: vue-tsc 通过。

```bash
git add src/lib/chat.ts
git commit -m "feat(chat): chat 返回 toolCalls + chatAgent 多轮工具 loop"
```

---

### Task 5: 前端 tavily.ts — 调用封装 + 用量记录

**Files:**
- Create: `src/lib/tavily.ts`

**Interfaces:**
- Produces: `tavilySearch(query)`/`tavilyExtract(urls)`（内部 invoke Rust）、`getTavilyKey()`/`setTavilyKey(v)`、`getTavilyUsage()`/`recordTavilySearch(credits)`/`recordTavilyExtract(credits,urls)`/`resetTavilyUsage()`。Task 6(genStore execTool) 与 Task 8(Settings) 依赖。

- [ ] **Step 1: 创建 tavily.ts**

Create `src/lib/tavily.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "./aiConfig";

export interface TavilyResult {
  answer: string;
  results: { title: string; url: string; content: string }[];
  credits: number;
}

export interface TavilyExtract {
  results: { url: string; raw_content: string }[];
  failed: { url: string; raw_content: string }[];
  credits: number;
}

export async function getTavilyKey(): Promise<string | null> {
  return getSetting("tavily_api_key");
}

export async function setTavilyKey(v: string): Promise<void> {
  await setSetting("tavily_api_key", v);
}

export async function tavilySearch(apiKey: string, query: string): Promise<TavilyResult> {
  return invoke<TavilyResult>("tavily_search", {
    config: { api_key: apiKey },
    query,
  });
}

export async function tavilyExtract(
  apiKey: string,
  urls: string[]
): Promise<TavilyExtract> {
  return invoke<TavilyExtract>("tavily_extract", {
    config: { api_key: apiKey },
    urls: urls.slice(0, 3), // 上限 3/次
  });
}

// ---- 用量记录（settings.tavily_usage，JSON 字符串）----
export interface TavilyUsage {
  searchCalls: number;
  extractCalls: number;
  extractUrls: number;
  credits: number;
}

const EMPTY: TavilyUsage = { searchCalls: 0, extractCalls: 0, extractUrls: 0, credits: 0 };

export async function getTavilyUsage(): Promise<TavilyUsage> {
  const raw = await getSetting("tavily_usage");
  if (!raw) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<TavilyUsage>) };
  } catch {
    return { ...EMPTY };
  }
}

async function saveUsage(u: TavilyUsage): Promise<void> {
  await setSetting("tavily_usage", JSON.stringify(u));
}

export async function recordTavilySearch(credits: number): Promise<TavilyUsage> {
  const u = await getTavilyUsage();
  u.searchCalls += 1;
  u.credits += credits;
  await saveUsage(u);
  return u;
}

export async function recordTavilyExtract(
  credits: number,
  urls: number
): Promise<TavilyUsage> {
  const u = await getTavilyUsage();
  u.extractCalls += 1;
  u.extractUrls += urls;
  u.credits += credits;
  await saveUsage(u);
  return u;
}

export async function resetTavilyUsage(): Promise<void> {
  await saveUsage({ ...EMPTY });
}
```

- [ ] **Step 2: 类型检查 + 提交**

Run: `npm run build`
Expected: vue-tsc 通过。

```bash
git add src/lib/tavily.ts
git commit -m "feat(tavily): 前端调用封装 + 用量记录"
```

---

### Task 6: 前端 prompt.ts — manuscriptPrompt + splitOutlinePrompt + 工具定义

**Files:**
- Modify: `src/lib/prompt.ts`

**Interfaces:**
- Produces: `manuscriptPrompt(topic)`、`splitOutlinePrompt(topic, manuscript, style)`、`tavilyTools: ToolDef[]`、`OutlineSlide.notes?`。Task 7(genStore) 调用。

- [ ] **Step 1: OutlineSlide 加 notes**

Modify `src/lib/prompt.ts:49-53` — 接口加 notes：

```ts
export interface OutlineSlide {
  title: string;
  kind: string;
  bullets: string[];
  notes?: string;
}
```

- [ ] **Step 2: 把 outlinePrompt 改造为 splitOutlinePrompt**

Modify `src/lib/prompt.ts` — 把 `outlinePrompt` 函数整体替换为 `splitOutlinePrompt`（注入 manuscript，每页带 notes）：

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
    styleReturnClause = `\n4. style：你在上面挑选的风格 id（字符串）。`;
  }

  return `你是一位专业的 PPT 设计师与信息架构师。下面是已经撰写好的完整文案，请据此为主题「${topic}」设计一份精美的 PPT：先确定统一的设计系统，再把文案拆分为各页大纲。${styleSection}

【完整文案（作为内容源，拆页时必须覆盖其要点）】
${manuscript}

【页数】由你根据文案内容的丰富程度自行判断决定：内容丰富的主题可多到 20 页以上，简单的主题可少至 6 页左右，以“每页都有实质信息、不空洞、不冗余”为原则。不要固定页数，也不要为了凑数而堆砌页或拆得过碎。

【输出要求】
1. design_tokens：专业协调的配色与字体方案，字段为 primary / accent / background / surface / text / textMuted / fonts / titleSize / bodySize（颜色用 #hex；titleSize 72–96px、bodySize 32–44px，必须保证投影可读，禁止偏小）。字体用系统通用字体族（如 "Microsoft YaHei"/"PingFang SC"/sans-serif 或 monospace），不要依赖需联网加载的字体。
2. theme_css：基于上述 tokens 的完整 CSS，包含 :root 中的 CSS 变量，以及通用类 .slide、.slide-title、.slide-body、.accent-bar 等。所有页面共享它。theme_css 必须遵守以下弹性铁律以防止内容溢出：
   - .slide 固定为 ${SLIDE_W}px × ${SLIDE_H}px（16:9），overflow:hidden，box-sizing:border-box，且必须 display:flex; flex-direction:column;
   - 必须包含 body,html { margin:0; padding:0; } 重置，消除默认 8px 边距导致的整体下移
   - :root 中的字号变量必须使用 clamp() 实现弹性，如 --titleSize: clamp(56px, 5vw, 96px); --bodySize: clamp(24px, 2vw, 40px); 确保内容多时自动缩小，但正文最小不低于 20px
   - 所有直接子内容容器（如 .content、.grid、.columns、.cards）必须允许弹性收缩：使用 min-height:0; flex-shrink:1; overflow:visible（不要加 overflow:hidden，否则截图时隐藏内容会丢失）
   - 文本容器必须设置合理的 max-height（如 calc(100% - 标题高度)）配合 overflow:visible，确保所有文本在截图时完整可见
3. slides：数组，第一页 kind=cover（封面），最后一页 kind=ending（致谢），中间用 cover/bullets/two-column/quote/section 等版式。每页含 title（标题）、kind（版式）、bullets（要点字符串数组）、notes（该页讲稿片段，从对应文案摘取，演讲用，1–3 句或对应要点）。中间内容页 bullets 至少 4 条，每条应是一个有信息量的完整要点（可含简短支撑说明、数据或案例），内容充实专业、紧扣主题展开；封面/致谢可短。${styleReturnClause}

内容要专业、充实、紧扣主题，避免空洞。

【严格】只返回一个 JSON 对象，不要 markdown 代码块、不要解释文字。结构如下：
{"design_tokens":{...},"theme_css":"/* css string */","slides":[{"title":"","kind":"cover","bullets":[],"notes":""}...],"style":"<风格id，仅自动模式需要>"}`;
}
```

- [ ] **Step 3: 新增 manuscriptPrompt + tavilyTools**

Modify `src/lib/prompt.ts` — 文件末尾（`chatWithElementPrompt` 之后）追加：

```ts
import type { ToolDef } from "./chat";

/** 文案阶段提示词：先调研再撰写，最终消息只输出完整 markdown 文案。 */
export function manuscriptPrompt(topic: string): string {
  return `你是一位专业的 PPT 文案策划与演讲撰稿人。请为主题「${topic}」撰写一份完整的 PPT 演讲文案。

【工作方式】
- 你可以调用工具联网调研：先用 tavily_search 查证关键事实、数据、最新进展；对某个想看全文的网页再用 tavily_extract 提取。
- 调研充分后再撰写。不要每次都调用工具，也不要只搜一次就停——根据主题需要决定调用次数。
- 引用工具查到的信息时，在文案中以 [来源: 标题] 标注；不确定或查不到的不要编造。

【文案要求】
- 最终消息只输出一份完整的 markdown 文案，不要输出调研过程、工具调用摘要或任何解释。
- 按 8–20 页分章节，每章节有：章节标题 + 该页要讲的内容（要点/数据/案例/过渡语）。
- 内容专业、充实、紧扣主题、适合宣讲；语言自然流畅，可作为演讲稿。
- 用 markdown 的二级标题（##）分页，标题下写该页讲什么。

现在开始，必要时调用工具调研，最后输出完整文案。`;
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
```

- [ ] **Step 4: 类型检查 + 提交**

Run: `npm run build`
Expected: vue-tsc 通过。

```bash
git add src/lib/prompt.ts
git commit -m "feat(prompt): manuscriptPrompt + splitOutlinePrompt(带 notes) + tavilyTools"
```

---

### Task 7: 前端 genStore.ts — startOutline 重构为 manuscript+outline 两阶段

**Files:**
- Modify: `src/lib/genStore.ts`

**Interfaces:**
- Consumes: `chatOnce`、`chatAgent`、`manuscriptPrompt`/`splitOutlinePrompt`/`tavilyTools`、`tavilySearch`/`tavilyExtract`/`getTavilyKey`/`recordTavilySearch`/`recordTavilyExtract`。
- Produces: `startOutline(projectId, topic, style?, searchEnabled?)` 重构；新 phase `manuscript`。

- [ ] **Step 1: 修改 import**

Modify `src/lib/genStore.ts:1-23` — import 加 chatAgent、新提示词、tavily：

```ts
import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { chat, chatOnce, chatAgent, type ChatMsg, type CancelledError, type ToolCall } from "./chat";
import {
  manuscriptPrompt,
  splitOutlinePrompt,
  parseOutline,
  cleanHtml,
  selfCheckPrompt,
  chatWithElementPrompt,
  tavilyTools,
  type OutlineSlide,
} from "./prompt";
import {
  getProject,
  updateProject,
  listSlides,
  upsertSlide,
  addMessage,
  deleteSlide,
  type Slide,
} from "./db";
import { getActiveAi, getSetting } from "./aiConfig";
import {
  getTavilyKey,
  tavilySearch,
  tavilyExtract,
  recordTavilySearch,
  recordTavilyExtract,
} from "./tavily";
import { renderSlideToDataUrl } from "./ppt";
```

- [ ] **Step 2: GenPhase 加 manuscript**

Modify `src/lib/genStore.ts:28-34` — type 加 `manuscript`：

```ts
export type GenPhase =
  | "idle"
  | "manuscript"
  | "outline"
  | "outline-chat"
  | "slide"
  | "chat"
  | "selfcheck";
```

- [ ] **Step 3: 新增 execTool 辅助函数**

Modify `src/lib/genStore.ts` — 在 `startOutline` 之前插入：

```ts
/**
 * 执行 Tavily 工具调用并记录用量。返回工具结果文本（供回填给模型）。
 * 异常时返回 [工具错误] 文本，不中断 agent loop。
 */
async function execTavilyTool(call: ToolCall, apiKey: string): Promise<string> {
  let args: { query?: string; urls?: string[] } = {};
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return "[工具错误] 参数解析失败";
  }
  try {
    if (call.name === "tavily_search") {
      const q = args.query ?? "";
      if (!q) return "[工具错误] 缺少 query";
      const r = await tavilySearch(apiKey, q);
      await recordTavilySearch(r.credits);
      genState.reasoning += `\n[🔍 搜索] ${q} · +${r.credits} 积分 → ${r.results.length} 条`;
      const lines = r.results.map(
        (x) => `## ${x.title}\nURL: ${x.url}\n${x.content}`
      );
      return `摘要答案：${r.answer}\n\n${lines.join("\n\n")}\n\n[本次消耗 ${r.credits} 积分]`;
    }
    if (call.name === "tavily_extract") {
      const urls = args.urls ?? [];
      if (!urls.length) return "[工具错误] 缺少 urls";
      const r = await tavilyExtract(apiKey, urls);
      await recordTavilyExtract(r.credits, r.results.length);
      genState.reasoning += `\n[📄 提取] ${urls.join(", ")} · +${r.credits} 积分`;
      const lines = r.results.map(
        (x) => `## ${x.url}\n${x.raw_content}`
      );
      return `${lines.join("\n\n")}\n\n[本次消耗 ${r.credits} 积分]`;
    }
    return `[工具错误] 未知工具 ${call.name}`;
  } catch (e) {
    return `[工具错误] ${e instanceof Error ? e.message : String(e)}`;
  }
}
```

- [ ] **Step 4: 重构 startOutline 为两阶段**

Modify `src/lib/genStore.ts` — 替换整个 `startOutline` 函数为：

```ts
// 阶段1a：生成完整文案（联网时用工具调研）；阶段1b：按文案拆页（JSON 模式）。
export async function startOutline(
  projectId: number,
  topic: string,
  style?: string | null,
  searchEnabled = false
): Promise<void> {
  genState.projectId = projectId;
  genState.running = true;
  genState.phase = "manuscript";
  resetBuffers();
  let manuscript = "";
  try {
    // —— 文案阶段 ——
    let useSearch = searchEnabled;
    let apiKey: string | null = null;
    if (useSearch) {
      apiKey = await getTavilyKey();
      if (!apiKey) {
        useSearch = false;
        genState.status = "未配置 Tavily Key，离线生成文案…";
      }
    }
    const msgs: ChatMsg[] = [
      { role: "system", content: "你是专业 PPT 文案策划，严格按要求输出。" },
      { role: "user", content: manuscriptPrompt(topic) },
    ];
    if (useSearch && apiKey) {
      genState.status = "联网调研并撰写文案…";
      try {
        manuscript = await chatAgent(
          msgs,
          tavilyTools,
          (call) => execTavilyTool(call, apiKey!),
          (d) => {
            genState.content += d;
            genState.status = `撰写文案中… 已收到 ${genState.content.length} 字`;
          },
          (d) => {
            genState.reasoning += d;
          },
          () => {
            // 每轮开始清空 content（只留最终轮文案）
            genState.content = "";
          }
        );
      } catch (e) {
        if (isCancelled(e)) throw e;
        // 模型不支持工具/格式不支持 → 降级离线写文案（用 chat 让 UI 见实时流）
        genState.status = "联网搜索不可用，改为离线生成文案…";
        genState.content = "";
        manuscript = "";
        await chat(
          msgs,
          (d) => {
            manuscript += d;
            genState.content += d;
            genState.status = `撰写文案中… 已收到 ${genState.content.length} 字`;
          },
          (d) => {
            genState.reasoning += d;
          }
        );
      }
    } else {
      genState.status = "撰写文案中…";
      manuscript = "";
      await chat(
        msgs,
        (d) => {
          manuscript += d;
          genState.content += d;
          genState.status = `撰写文案中… 已收到 ${genState.content.length} 字`;
        },
        (d) => {
          genState.reasoning += d;
        }
      );
    }
    if (genState.cancelled) {
      genState.status = "已取消";
      return;
    }
    manuscript = manuscript || genState.content;
    await updateProject(projectId, { manuscript });
    await addMessage(
      projectId,
      "assistant",
      `已生成完整文案（${manuscript.length} 字）。`,
      null,
      genState.reasoning
    );

    // —— 拆页阶段 ——
    if (genState.cancelled) {
      genState.status = "已取消";
      return;
    }
    genState.phase = "outline";
    resetBuffers();
    let parsed: ReturnType<typeof parseOutline> | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (genState.cancelled) break;
      genState.status = `按文案拆分大纲（第 ${attempt} 次）…`;
      const raw = await chatOnce(
        [
          { role: "system", content: "你是专业 PPT 设计师，严格按要求返回 JSON。" },
          { role: "user", content: splitOutlinePrompt(topic, manuscript, style) },
        ],
        (d) => {
          genState.reasoning += d;
          genState.status = `思考中… 已收到 ${genState.reasoning.length} 字思考`;
        },
        true // jsonMode
      );
      if (genState.cancelled) break;
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
    if (genState.cancelled) {
      genState.status = "已取消";
      return;
    }
    if (!parsed) throw new Error("大纲解析失败：" + (lastErr instanceof Error ? lastErr.message : String(lastErr)));

    const tokensJson = JSON.stringify(parsed.design_tokens, null, 2);
    const resolvedStyle = (parsed as { style?: string }).style ?? style ?? null;
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
    await addMessage(
      projectId,
      "assistant",
      `已生成大纲（${parsed.slides.length} 页）与设计系统。`,
      null,
      genState.reasoning
    );
    genState.status = "大纲已生成，可进入编辑器逐页生成 HTML";
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

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run build`
Expected: vue-tsc 通过。

```bash
git add src/lib/genStore.ts
git commit -m "feat(genStore): startOutline 重构为 manuscript+outline 两阶段（联网工具调研）"
```

---

### Task 8: 前端 ppt.ts — 导出讲者备注

**Files:**
- Modify: `src/lib/ppt.ts:58-63`

**Interfaces:**
- Consumes: `slide.outline` JSON 含 `notes`。

- [ ] **Step 1: addImage 后写 notes**

Modify `src/lib/ppt.ts` — 替换导出循环为：

```ts
  for (const slide of slides) {
    if (!slide.html_content) continue;
    const dataUrl = await renderSlideToDataUrl(slide.html_content);
    const s = pptx.addSlide();
    s.addImage({ data: dataUrl, x: 0, y: 0, w: 13.333, h: 7.5 });
    // 讲者备注：解析 outline JSON 取 notes（文案先行流程才有）
    if (slide.outline) {
      try {
        const ol = JSON.parse(slide.outline) as { notes?: string };
        if (ol.notes && ol.notes.trim()) {
          s.addNotes(ol.notes);
        }
      } catch {
        /* outline 非合法 JSON 时忽略备注 */
      }
    }
  }
```

- [ ] **Step 2: 类型检查 + 提交**

Run: `npm run build`
Expected: vue-tsc 通过。

```bash
git add src/lib/ppt.ts
git commit -m "feat(ppt): 导出 pptx 时把每页 notes 写入讲者备注"
```

---

### Task 9: Settings.vue — Tavily Key + 测试 + 用量

**Files:**
- Modify: `src/pages/Settings.vue`

**Interfaces:**
- Consumes: `getTavilyKey`/`setTavilyKey`/`tavilySearch`/`getTavilyUsage`/`resetTavilyUsage`。

- [ ] **Step 1: script 加 Tavily 状态与函数**

Modify `src/pages/Settings.vue:1-162` — 在 import 块追加 tavily，并在 `toggleAutoSelfcheck` 之后加 Tavily 逻辑。

import 块（在 `} from "../lib/aiConfig";` 之前追加一行 import）：

```ts
import {
  getTavilyKey,
  setTavilyKey,
  tavilySearch,
  getTavilyUsage,
  resetTavilyUsage,
  type TavilyUsage,
} from "../lib/tavily";
```

在 `toggleAutoSelfcheck` 函数之后追加：

```ts
// Tavily 联网搜索
const tavilyKey = ref("");
const testing = ref(false);
const tavilyUsage = ref<TavilyUsage>({ searchCalls: 0, extractCalls: 0, extractUrls: 0, credits: 0 });

async function loadTavily() {
  tavilyKey.value = (await getTavilyKey()) ?? "";
  tavilyUsage.value = await getTavilyUsage();
}

async function saveTavilyKey() {
  await setTavilyKey(tavilyKey.value.trim());
  await loadTavily();
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}

async function testTavily() {
  const key = tavilyKey.value.trim();
  if (!key) {
    alert("请先填写并保存 Tavily API Key");
    return;
  }
  await setTavilyKey(key);
  testing.value = true;
  try {
    const r = await tavilySearch(key, "test query");
    await recordTavilySearch(r.credits);
    await loadTavily();
    alert(`测试成功：返回 ${r.results.length} 条结果，消耗 ${r.credits} 积分`);
  } catch (e: any) {
    alert("测试失败：" + e);
  } finally {
    testing.value = false;
  }
}

async function clearUsage() {
  if (!confirm("清零 Tavily 用量统计？")) return;
  await resetTavilyUsage();
  await loadTavily();
}
```

`recordTavilySearch` 需从 tavily.ts 引入，补到 import：

```ts
import {
  getTavilyKey,
  setTavilyKey,
  tavilySearch,
  getTavilyUsage,
  resetTavilyUsage,
  recordTavilySearch,
  type TavilyUsage,
} from "../lib/tavily";
```

并在 `onMounted` 内追加调用：

```ts
onMounted(async () => {
  await load();
  autoSelfcheck.value = (await getSetting("auto_selfcheck")) !== "false";
  await loadTavily();
});
```

- [ ] **Step 2: template 加 Tavily 区块**

Modify `src/pages/Settings.vue` — 在「自动自检」`.field` 之后、`<div class="row">` 保存按钮之前插入：

```html
    <h3 style="margin-top: 24px">联网搜索 (Tavily)</h3>
    <p class="muted">配置 Tavily API Key 后，新建项目时可选「联网搜索」，生成文案时由 AI 自主多轮联网调研。</p>
    <label>
      Tavily API Key
      <div class="key-row">
        <input v-model="tavilyKey" :type="showKey ? 'text' : 'password'" placeholder="tvly-..." />
        <button class="ghost icon-btn" type="button" @click="showKey = !showKey">
          <Icon :name="showKey ? 'eye-off' : 'eye'" :size="16" />
        </button>
      </div>
    </label>
    <div class="row">
      <button class="primary" @click="saveTavilyKey">保存 Key</button>
      <button class="ghost" :disabled="testing || !tavilyKey.trim()" @click="testTavily">
        {{ testing ? "测试中…" : "测试连接" }}
      </button>
      <span v-if="saved" class="muted">已保存</span>
    </div>
    <div class="field">
      <span class="label">用量</span>
      <div class="muted">
        搜索 {{ tavilyUsage.searchCalls }} 次 · 提取 {{ tavilyUsage.extractCalls }} 次（{{ tavilyUsage.extractUrls }} URL）· 已用 {{ tavilyUsage.credits }} 积分
        <button class="ghost" style="margin-left: 8px" @click="clearUsage">清零</button>
      </div>
    </div>
```

- [ ] **Step 3: 类型检查 + 提交**

Run: `npm run build`
Expected: vue-tsc 通过。

```bash
git add src/pages/Settings.vue
git commit -m "feat(settings): Tavily API Key 配置 + 测试连接 + 用量统计"
```

---

### Task 10: ProjectList.vue — 新建项目联网开关

**Files:**
- Modify: `src/pages/ProjectList.vue`

**Interfaces:**
- Consumes: `getTavilyKey`、`createProject(..., searchEnabled)`。

- [ ] **Step 1: script 加 tavilyReady + searchEnabled**

Modify `src/pages/ProjectList.vue:1-9` — import 加 tavily：

```ts
import { getTavilyKey } from "../lib/tavily";
```

Modify `src/pages/ProjectList.vue:14-19` — 在 `selectedStyle` 之后加：

```ts
const selectedStyle = ref<string | null>(null);
const tavilyReady = ref(false);
const searchEnabled = ref(true);
```

Modify `src/pages/ProjectList.vue:21` — `onMounted(load)` 改为：

```ts
onMounted(async () => {
  await load();
  tavilyReady.value = !!(await getTavilyKey());
});
```

Modify `src/pages/ProjectList.vue:35-41` — `create()` 传 searchEnabled：

```ts
async function create() {
  if (genState.running) return;
  if (!topic.value.trim()) return;
  const t = title.value.trim() || topic.value.slice(0, 20);
  const id = await createProject(
    t,
    topic.value.trim(),
    selectedStyle.value,
    tavilyReady.value && searchEnabled.value
  );
  router.push(`/outline/${id}`);
}
```

- [ ] **Step 2: template 加联网开关**

Modify `src/pages/ProjectList.vue` — 在「风格」`.field` 之后、`创建并生成大纲` 按钮之前插入：

```html
        <div v-if="tavilyReady" class="field">
          <label class="toggle">
            <input type="checkbox" v-model="searchEnabled" />
            联网搜索（生成文案时由 AI 自主联网调研）
          </label>
        </div>
```

- [ ] **Step 3: style 加 .toggle（若不存在）**

Modify `src/pages/ProjectList.vue` `<style scoped>` — 追加（复用 Editor 的 toggle 样式）：

```css
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.toggle input {
  margin: 0;
}
```

- [ ] **Step 4: 类型检查 + 提交**

Run: `npm run build`
Expected: vue-tsc 通过。

```bash
git add src/pages/ProjectList.vue
git commit -m "feat(projectlist): 新建项目可选联网搜索开关（仅已配置 Tavily 时显示）"
```

---

### Task 11: Outline.vue — 阶段标签 + 文案面板 + auto-start 传参

**Files:**
- Modify: `src/pages/Outline.vue`

**Interfaces:**
- Consumes: `startOutline(projectId, topic, style, searchEnabled)`、`project.manuscript`。

- [ ] **Step 1: auto-start 传 search_enabled**

Modify `src/pages/Outline.vue:72-75` — `load()` 内 auto-start 调用改为：

```ts
    if (project.value) {
      startOutline(
        projectId,
        project.value.topic,
        project.value.style ?? null,
        !!project.value.search_enabled
      );
    }
```

- [ ] **Step 2: 流式区标签按 phase 切换 + 文案面板**

Modify `src/pages/Outline.vue` — 替换 `.o-main` 内的 `<section>` 内容为：

```html
      <section class="o-main">
        <details v-if="project.manuscript" class="manuscript-block" open>
          <summary>完整文案（{{ project.manuscript.length }} 字）</summary>
          <pre>{{ project.manuscript }}</pre>
        </details>
        <div v-if="isRunning && !outlineView.length" class="stream">
          <div v-if="genState.reasoning" class="block">
            <span class="label">思考 / 调研</span>
            <pre ref="reasoningEl">{{ genState.reasoning }}</pre>
          </div>
          <div class="block">
            <span class="label">
              {{ genState.phase === 'manuscript' ? '文案（生成中）' : '正文（JSON 流式）' }}
            </span>
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
```

- [ ] **Step 3: style 加 manuscript-block**

Modify `src/pages/Outline.vue` `<style scoped>` — 追加：

```css
.manuscript-block {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--panel);
  margin-bottom: 12px;
}
.manuscript-block summary {
  font-weight: 600;
  cursor: pointer;
}
.manuscript-block pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  margin: 8px 0 0;
  max-height: 320px;
  overflow: auto;
}
```

- [ ] **Step 4: 类型检查 + 提交**

Run: `npm run build`
Expected: vue-tsc 通过。

```bash
git add src/pages/Outline.vue
git commit -m "feat(outline): manuscript 阶段标签 + 完整文案面板 + auto-start 传 search_enabled"
```

---

### Task 12: 端到端冒烟 + 收尾

**Files:**
- 无新文件；全量验证

- [ ] **Step 1: 全量类型检查 + 构建**

Run: `npm run build`
Expected: vue-tsc 与 vite build 均通过。

- [ ] **Step 2: Rust 完整编译**

Run: `cd src-tauri && cargo check`
Expected: 编译通过（允许 unused 警告——确认无实质错误）。

- [ ] **Step 3: 手动冒烟（联网路径）**

Run: `npm run tauri dev`（用户在设置页配置 Tavily Key 并测试连接成功后）
验证清单：
- 设置页填 Tavily Key → 保存 → 测试连接弹"测试成功：返回 N 条结果，消耗 1 积分"。
- 设置页用量行显示"搜索 1 次 · … · 已用 1 积分"。
- 新建项目表单出现「联网搜索」开关（因已配 Key）。
- 新建项目 → 大纲页：先显示「文案（生成中）」+「思考/调研」区出现 `[工具] tavily_search ...` 行 → 完成后出现「完整文案」面板 → 再显示「正文（JSON 流式）」→ 最终大纲卡片。
- 进编辑器 → 生成全部 → 导出 PPT → 用 PowerPoint 打开，每页讲者备注有对应文案片段。

- [ ] **Step 4: 手动冒烟（离线路径）**

验证清单：
- 不配 Tavily Key → 新建项目表单无「联网搜索」开关。
- 大纲页直接显示「文案（生成中）」（无调研行）→ 拆页 → 大纲。
- 旧项目（迁移前）打开：无文案面板、无讲者备注，不报错。

- [ ] **Step 5: 更新 CLAUDE.md（如必要）**

若实现与 spec 偏离导致 CLAUDE.md 的架构描述需更新（如生成管线新增 manuscript phase、新增 tavily.ts），在 `CLAUDE.md` 「Architecture」相关段落补一句说明。否则跳过。

- [ ] **Step 6: 最终提交**

```bash
git add -A
git commit -m "chore: Tavily 联网搜索 + 文案先行 完整实现"
```

---

## 自检清单

**Spec 覆盖**：§1 目标 → 全任务；§3 DB → Task1；§4 Rust → Task2/3；§5.1 tavily.ts → Task5；§5.2 chat.ts → Task4；§5.3 genStore → Task7；§5.4 prompt.ts → Task6；§5.5 ppt.ts → Task8；§6 设置 → Task9；§7 UI → Task10/11；§8 边界 → 各任务降级/上限逻辑；§9 积分 → Task2 credits + Task5 用量 + Task7 execTool 记录；§10 非目标 → 未实现。

**类型一致性**：`ToolCall{id,name,arguments:string}`（Rust+前端一致）；`TavilyUsage`（Task5 定义，Task9 用）；`OutlineSlide.notes`（Task6 加，Task8 读取）；`startOutline(projectId, topic, style?, searchEnabled=false)`（Task7 定义，Task11 调用）。
