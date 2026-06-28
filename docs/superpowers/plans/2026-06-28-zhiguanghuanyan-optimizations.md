# 纸光幻演 优化（第二轮）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在第一轮已落地的全局 store 流程上，叠加 7 项优化 + 取消生成 + 导出文件名：多 AI 配置与单选启用、Anthropic 格式兼容、多模态自检、调试模式点选改图、右键/devtools 安全加固、中文名「纸光幻演」、导出文件名用项目名。

**Architecture:** 新增 `ai_configs` 表（migration 004）与 typed helpers（`aiConfig.ts`）替代全局单组设置；Rust `chat_stream`/`list_models` 按 `format` 分支支持 OpenAI/Anthropic 两种格式与多模态图片（base64 dataURL）；新增 `cancel_chat` 命令用 `Abortable` 单槽中止流；`genStore` 加 `selfcheck` phase 与取消标志；`SlidePreview` 加 inspect 模式点选元素入对话栏。

**Tech Stack:** Tauri 2 (Rust + reqwest rustls + SSE)，Vue 3 `<script setup>` + TS，`@tauri-apps/plugin-sql` (SQLite)，`modern-screenshot`/`pptxgenjs`，`futures-util`（已在 Cargo.toml）。

## Global Constraints

- **无测试框架**：本项目无 test 脚本与依赖（见 CLAUDE.md）。验证靠：`npm run build`（含 `vue-tsc --noEmit` 类型检查 + vite 构建）、`src-tauri` 下 `cargo check`（Rust 编译检查）、`npm run tauri dev` 手动行为验证。每个任务的"运行测试"步骤改用这三者。
- UI 文案、提示词保持中文。
- 画布尺寸不变：`SLIDE_W=1920 / SLIDE_H=1080`（`src/lib/prompt.ts`）。
- JSON 模式仅大纲生成用；但 `response_format:json_object` 是 OpenAI 专属——Anthropic 格式忽略 json_mode，靠提示词约束 + `parseOutline` 容错。
- Rust 依赖新增项：无（`futures-util` 已在 `Cargo.toml`，提供 `future::Abortable`/`AbortHandle`/`future::FutureExt`）。
- 不引新前端依赖。
- 产品中文名固定为「**纸光幻演**」；工程代号 AutoPPT/auto-ppt 仅留于 `productName`/包名，不显示于界面。
- 迁移由 `lib.rs` `run()` 在启动时应用；当前已到 version 3，本计划新增 version 4。

---

## File Structure

**新增：**
- `src/lib/aiConfig.ts` — 多 AI 配置 typed helpers（替代 `settings.ts` 的全局单组 ApiSettings）。
- `src-tauri/migrations/004_ai_configs.sql` — `ai_configs` 表。

**修改：**
- `src-tauri/src/lib.rs` — migration v4；`chat_stream`/`list_models` 格式分支 + 多模态图片；`ChatConfig`/`ChatMessage` 加字段；`Abortable` + `cancel_chat` + managed state。
- `src/lib/chat.ts` — 读 `getActiveAi()`；消息支持 `images`；识别 `__cancelled__` 哨兵。
- `src/lib/settings.ts` — 删除全局 `ApiSettings`/`getSettings`/`saveSettings`；保留 `getSetting/setSetting`（app 级开关如 `auto_selfcheck`）与 legacy 读路径。
- `src/lib/genStore.ts` — `cancelled`/`selfcheck` phase/`selfCheckSlide`/`cancelGeneration`；startSlide/startAll 触发自检；catch 识别取消。
- `src/lib/prompt.ts` — 自检提示词 + 调试选中元素提示词。
- `src/lib/ppt.ts` — `exportPptx` 加 `title` 参数与 sanitize；`author` 中文名。
- `src/pages/Settings.vue` — 多 AI 列表 + 编辑表单（格式/多模态）。
- `src/pages/Editor.vue` — 取消按钮；调试模式开关与 pick；导出传 title。
- `src/pages/Outline.vue` — 取消按钮。
- `src/components/SlidePreview.vue` — `inspectMode` prop + 点选 emit。
- `src/components/ChatPanel.vue` — `prepend()` 暴露。
- `src/App.vue` — 品牌中文名。
- `src/main.ts` — `ensureLegacyImport()` 调用；contextmenu 禁用；PROD devtools 拦截。
- `index.html` — lang/title 中文。
- `src-tauri/tauri.conf.json` — 窗口 title 中文名。
- `src-tauri/capabilities/default.json` — 如需（预期不需要，见 Task 3 备注）。

---

### Task 1: `ai_configs` 表 + aiConfig.ts typed helpers + 旧数据导入

**Files:**
- Create: `src-tauri/migrations/004_ai_configs.sql`
- Create: `src/lib/aiConfig.ts`
- Modify: `src-tauri/src/lib.rs` (注册 migration v4)
- Modify: `src/lib/settings.ts` (保留 app 级开关读写，删除全局 ApiSettings)

**Interfaces:**
- Produces: `AiConfig` 类型与 `listAiConfigs/getActiveAi/saveAiConfig/deleteAiConfig/setActiveAi/getModelsCache/saveModelsCache/ensureLegacyImport/getSetting/setSetting`，供后续任务消费。

- [ ] **Step 1: 写 migration SQL**

Create `src-tauri/migrations/004_ai_configs.sql`:

```sql
-- 多 AI 配置：每条一个独立的 API 配置；enabled 单选（同一时刻至多一条为 1）
CREATE TABLE IF NOT EXISTS ai_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_base TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'openai',
  multimodal INTEGER NOT NULL DEFAULT 0,
  thinking_mode INTEGER NOT NULL DEFAULT 0,
  thinking_effort TEXT NOT NULL DEFAULT 'high',
  enabled INTEGER NOT NULL DEFAULT 0,
  models_cache TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: 注册 migration v4**

Modify `src-tauri/src/lib.rs`，在 `run()` 的 `migrations` vec 末尾（version 3 之后）追加：

```rust
        tauri_plugin_sql::Migration {
            version: 4,
            description: "ai_configs table for multiple AI providers",
            sql: include_str!("../migrations/004_ai_configs.sql"),
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
```

- [ ] **Step 3: 写 aiConfig.ts**

Create `src/lib/aiConfig.ts`:

```typescript
import { db } from "./db";

export type AiFormat = "openai" | "anthropic";

export interface AiConfig {
  id?: number;
  name: string;
  api_base: string;
  api_key: string;
  model: string;
  format: AiFormat;
  multimodal: boolean;
  thinking_mode: boolean;
  thinking_effort: string; // "high" | "max"
  enabled: boolean;
  models_cache?: string[];
}

interface AiConfigRow {
  id: number;
  name: string;
  api_base: string;
  api_key: string;
  model: string;
  format: string;
  multimodal: number;
  thinking_mode: number;
  thinking_effort: string;
  enabled: number;
  models_cache: string | null;
}

function rowToConfig(r: AiConfigRow): AiConfig {
  let models_cache: string[] = [];
  if (r.models_cache) {
    try {
      models_cache = JSON.parse(r.models_cache) as string[];
    } catch {
      models_cache = [];
    }
  }
  return {
    id: r.id,
    name: r.name,
    api_base: r.api_base,
    api_key: r.api_key,
    model: r.model,
    format: (r.format === "anthropic" ? "anthropic" : "openai") as AiFormat,
    multimodal: !!r.multimodal,
    thinking_mode: !!r.thinking_mode,
    thinking_effort: r.thinking_effort || "high",
    enabled: !!r.enabled,
    models_cache,
  };
}

export async function listAiConfigs(): Promise<AiConfig[]> {
  const d = await db();
  const rows = await d.select<AiConfigRow[]>(
    "SELECT * FROM ai_configs ORDER BY id ASC"
  );
  return rows.map(rowToConfig);
}

export async function getActiveAi(): Promise<AiConfig | null> {
  const d = await db();
  const rows = await d.select<AiConfigRow[]>(
    "SELECT * FROM ai_configs WHERE enabled = 1 ORDER BY id ASC LIMIT 1"
  );
  return rows.length ? rowToConfig(rows[0]) : null;
}

export async function saveAiConfig(c: AiConfig): Promise<number> {
  const d = await db();
  const cacheJson = c.models_cache ? JSON.stringify(c.models_cache) : null;
  if (c.id) {
    await d.execute(
      `UPDATE ai_configs SET name=?, api_base=?, api_key=?, model=?, format=?, multimodal=?, thinking_mode=?, thinking_effort=?, models_cache=? WHERE id=?`,
      [
        c.name,
        c.api_base,
        c.api_key,
        c.model,
        c.format,
        c.multimodal ? 1 : 0,
        c.thinking_mode ? 1 : 0,
        c.thinking_effort,
        cacheJson,
        c.id,
      ]
    );
    return c.id;
  }
  const r = await d.execute(
    `INSERT INTO ai_configs(name, api_base, api_key, model, format, multimodal, thinking_mode, thinking_effort, models_cache) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.name,
      c.api_base,
      c.api_key,
      c.model,
      c.format,
      c.multimodal ? 1 : 0,
      c.thinking_mode ? 1 : 0,
      c.thinking_effort,
      cacheJson,
    ]
  );
  return Number(r.lastInsertId);
}

export async function deleteAiConfig(id: number): Promise<void> {
  const d = await db();
  await d.execute("DELETE FROM ai_configs WHERE id = ?", [id]);
}

export async function setActiveAi(id: number): Promise<void> {
  const d = await db();
  // 单选：先全置 0 再置目标 1（两句同一连接，近似事务）
  await d.execute("UPDATE ai_configs SET enabled = 0");
  await d.execute("UPDATE ai_configs SET enabled = 1 WHERE id = ?", [id]);
}

export async function getModelsCache(id: number): Promise<string[]> {
  const d = await db();
  const rows = await d.select<{ models_cache: string | null }[]>(
    "SELECT models_cache FROM ai_configs WHERE id = ?",
    [id]
  );
  if (!rows.length || !rows[0].models_cache) return [];
  try {
    return JSON.parse(rows[0].models_cache) as string[];
  } catch {
    return [];
  }
}

export async function saveModelsCache(id: number, ids: string[]): Promise<void> {
  const d = await db();
  await d.execute(
    "UPDATE ai_configs SET models_cache = ? WHERE id = ?",
    [JSON.stringify(ids), id]
  );
}

/**
 * 旧数据兼容：ai_configs 为空 且 settings 表存在非空 api_base 时，
 * 建一条 format=openai / enabled=1 的记录（旧数据本就按 OpenAI 格式工作）。
 * 启动时调用一次；已导入过则不再触发。
 */
export async function ensureLegacyImport(): Promise<void> {
  const d = await db();
  const cnt = await d.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM ai_configs"
  );
  if (cnt[0]?.n) return; // 表非空，已导入过
  const rows = await d.select<{ key: string; value: string }[]>(
    "SELECT key, value FROM settings"
  );
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  if (!map.api_base) return; // 无旧配置
  let models_cache: string[] = [];
  if (map.models) {
    try {
      models_cache = JSON.parse(map.models) as string[];
    } catch {
      models_cache = [];
    }
  }
  await d.execute(
    `INSERT INTO ai_configs(name, api_base, api_key, model, format, multimodal, thinking_mode, thinking_effort, enabled, models_cache)
     VALUES(?, ?, ?, ?, 'openai', 0, ?, ?, 1, ?)`,
    [
      map.model ? map.model : "默认 AI",
      map.api_base,
      map.api_key ?? "",
      map.model ?? "",
      map.thinking_mode === "true" ? 1 : 0,
      map.thinking_effort || "high",
      models_cache.length ? JSON.stringify(models_cache) : null,
    ]
  );
}

// ---- app 级纯开关（settings 表 key-value），如 auto_selfcheck ----
export async function getSetting(key: string): Promise<string | null> {
  const d = await db();
  const rows = await d.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = ?",
    [key]
  );
  return rows.length ? rows[0].value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const d = await db();
  await d.execute(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}
```

- [ ] **Step 4: 收敛 settings.ts（删除全局 ApiSettings）**

Rewrite `src/lib/settings.ts` entirely — 删除 `ApiSettings`/`getSettings`/`saveSettings`/`hasSettings`/`getModelsCache`/`saveModelsCache`，仅保留指向 aiConfig 的 re-export 占位，避免其他文件 import 断裂（chat.ts/Settings.vue 会在后续任务改 import）：

```typescript
// 设置访问已迁移至 aiConfig.ts（多 AI 配置）。
// 本文件仅保留极薄 re-export，避免历史 import 断裂；新代码请直接用 aiConfig.ts。
export {
  getSetting,
  setSetting,
  type AiConfig,
  type AiFormat,
} from "./aiConfig";
```

> 注意：`chat.ts` 仍 `import { getSettings } from "./settings"`，会在 Task 4 修。`Settings.vue` 仍 import 多个，会在 Task 7 修。Task 1 完成后 `npm run build` 会因这两处 import 失败——这是预期的，Task 4/7 修复。本任务不单独跑 build。

- [ ] **Step 5: Rust 编译检查**

Run (in `src-tauri`): `cargo check`
Expected: PASS（migration 注册正确，无 Rust 改动破坏）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/migrations/004_ai_configs.sql src/lib/aiConfig.ts src/lib/settings.ts src-tauri/src/lib.rs
git commit -m "feat: ai_configs 表与 aiConfig typed helpers + 旧数据导入"
```

---

### Task 2: Rust chat_stream/list_models 格式分支 + 多模态图片

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `ChatConfig.format`（`"openai"`|`"anthropic"`）、`ChatMessage.images`（dataURL 数组）由 `chat.ts`（Task 4）传入。
- Produces: `chat_stream` 支持 Anthropic 原生格式；`list_models` 支持 Anthropic。`cancel_chat` 在 Task 3 加。

- [ ] **Step 1: 替换 imports 与结构体定义**

Modify `src-tauri/src/lib.rs` 顶部 imports（第 1 行起），替换为：

```rust
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
```

替换 `ChatMessage` 与 `ChatConfig` 结构体（原第 5–22 行）为：

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
    #[serde(default)]
    images: Vec<String>, // dataURL: "data:image/png;base64,..."
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatConfig {
    api_base: String,
    api_key: String,
    model: String,
    #[serde(default)]
    format: String, // "openai" | "anthropic"，缺省 openai
    #[serde(default)]
    thinking_mode: bool,
    #[serde(default)]
    thinking_effort: String,
    #[serde(default)]
    json_mode: bool,
}

type AbortSlot = Mutex<Option<futures_util::future::AbortHandle>>;
```

- [ ] **Step 2: 加格式/图片辅助函数**

在 `chat_stream` 之前插入：

```rust
/// 拆分 dataURL "data:image/png;base64,XXXX" -> ("image/png", "XXXX")
fn split_data_url(s: &str) -> (String, String) {
    if let Some(rest) = s.strip_prefix("data:") {
        if let Some(idx) = rest.find(',') {
            let meta = &rest[..idx]; // "image/png;base64"
            let media = meta.split(';').next().unwrap_or("image/png").to_string();
            let data = &rest[idx + 1..];
            return (media, data.to_string());
        }
    }
    ("image/png".to_string(), s.to_string())
}

/// OpenAI 消息数组：含图片时 content 组装成 text+image_url 数组
fn openai_messages(messages: &[ChatMessage]) -> serde_json::Value {
    serde_json::Value::Array(
        messages
            .iter()
            .map(|m| {
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

/// Anthropic：system 提到顶层字符串；非 system 进 messages（assistant/user），含图片时为 text+image 块数组
fn anthropic_split(messages: &[ChatMessage]) -> (String, Vec<serde_json::Value>) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut rest: Vec<serde_json::Value> = Vec::new();
    for m in messages {
        if m.role == "system" {
            system_parts.push(m.content.clone());
            continue;
        }
        let role = if m.role == "assistant" { "assistant" } else { "user" };
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

/// 解析单条 Anthropic SSE data（按事件类型分发 chunk/reasoning/done）
fn emit_anthropic_event(app: &AppHandle, event: &str, data: &str) {
    if data == "[DONE]" {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return;
    };
    match event {
        "content_block_delta" => {
            let delta = &v["delta"];
            if let Some(t) = delta["type"].as_str() {
                match t {
                    "text_delta" => {
                        if let Some(text) = delta["text"].as_str() {
                            if !text.is_empty() {
                                let _ = app.emit("chat-chunk", text);
                            }
                        }
                    }
                    "thinking_delta" => {
                        if let Some(th) = delta["thinking"].as_str() {
                            if !th.is_empty() {
                                let _ = app.emit("chat-reasoning", th);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        "message_stop" => {
            let _ = app.emit("chat-done", ());
        }
        _ => {}
    }
}
```

- [ ] **Step 3: 重写 chat_stream（格式分支 + Abortable 预留位）**

> 本任务先实现格式分支与图片；`Abortable` 包装与 `cancel_chat` 在 Task 3 加。为减少返工，本步直接写成最终形态（含 Abortable），并在 Task 3 仅注册 managed state 与 `cancel_chat` 命令。

替换原 `chat_stream` 整个函数（原第 26–127 行）为：

```rust
/// 流式调用：按 config.format 分发 OpenAI(/chat/completions) 或 Anthropic(/v1/messages)。
/// 通过事件 chat-chunk/chat-reasoning/chat-done 推增量。Abortable 包住整个流，cancel_chat 可中止。
#[tauri::command]
async fn chat_stream(
    app: AppHandle,
    abort_slot: State<'_, AbortSlot>,
    config: ChatConfig,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let is_anthropic = config.format == "anthropic";

    // 构造 url / headers / body（按格式分支）
    let (url, req) = if is_anthropic {
        let url = format!("{}/v1/messages", config.api_base.trim_end_matches('/'));
        let (system_str, rest_msgs) = anthropic_split(&messages);
        let mut max_tokens: u64 = 8192;
        let mut body = serde_json::json!({
            "model": config.model,
            "messages": rest_msgs,
            "stream": true,
            "max_tokens": max_tokens,
        });
        if !system_str.is_empty() {
            body["system"] = serde_json::Value::String(system_str);
        }
        // thinking：Anthropic 用 {type:enabled,budget_tokens}；并按预算调高 max_tokens
        if config.thinking_mode {
            let budget: u64 = if config.thinking_effort == "max" { 32000 } else { 16000 };
            if let Some(obj) = body.as_object_mut() {
                obj.insert(
                    "thinking".to_string(),
                    serde_json::json!({ "type": "enabled", "budget_tokens": budget }),
                );
                max_tokens = budget + 8192;
                obj.insert("max_tokens".to_string(), serde_json::Value::Number(max_tokens.into()));
            }
        }
        // Anthropic 无 response_format json_object；忽略 json_mode，靠提示词约束
        (
            url,
            client
                .post(&url)
                .header("x-api-key", &config.api_key)
                .header("anthropic-version", "2023-06-01")
                .header("Content-Type", "application/json")
                .json(&body),
        )
    } else {
        let url = format!("{}/chat/completions", config.api_base.trim_end_matches('/'));
        let mut body = serde_json::json!({
            "model": config.model,
            "messages": openai_messages(&messages),
            "stream": true,
        });
        if config.thinking_mode {
            if let Some(obj) = body.as_object_mut() {
                obj.insert("thinking".to_string(), serde_json::json!({"type":"enabled"}));
                if !config.thinking_effort.is_empty() {
                    obj.insert(
                        "reasoning_effort".to_string(),
                        serde_json::Value::String(config.thinking_effort.clone()),
                    );
                }
            }
        }
        if config.json_mode {
            if let Some(obj) = body.as_object_mut() {
                obj.insert("response_format".to_string(), serde_json::json!({"type":"json_object"}));
            }
        }
        (
            url,
            client
                .post(&url)
                .header("Authorization", format!("Bearer {}", config.api_key))
                .header("Content-Type", "application/json")
                .json(&body),
        )
    };

    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }
    let _ = app.emit("chat-start", ());

    // Abortable：单槽句柄存入 managed state，cancel_chat 调 abort 立即中止
    let (handle, reg) = futures_util::future::AbortHandle::new_pair();
    {
        let mut g = abort_slot.lock().map_err(|e| format!("锁失败: {e}"))?;
        *g = Some(handle);
    }
    let app2 = app.clone();

    let streaming = async move {
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();

        if is_anthropic {
            // Anthropic SSE：跟踪 event，遇空行处理 data
            let mut cur_event = String::new();
            let mut data_buf = String::new();
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
                            emit_anthropic_event(&app2, &cur_event, &data_buf);
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
                emit_anthropic_event(&app2, &cur_event, &data_buf);
            }
        } else {
            // OpenAI SSE：原逻辑
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("读取流失败: {e}"))?;
                buf.push_str(&String::from_utf8_lossy(&chunk));
                loop {
                    let Some(idx) = buf.find('\n') else {
                        break;
                    };
                    let line = buf[..idx].trim().to_string();
                    buf = buf[idx + 1..].to_string();
                    if line.is_empty() || !line.starts_with("data:") {
                        continue;
                    }
                    let data = line[5..].trim();
                    if data == "[DONE]" {
                        let _ = app2.emit("chat-done", ());
                        return Ok(());
                    }
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
                    }
                }
            }
        }
        let _ = app2.emit("chat-done", ());
        Ok::<(), String>(())
    };

    match futures_util::future::Abortable::new(streaming, reg).await {
        Ok(res) => {
            if let Ok(mut g) = abort_slot.lock() {
                *g = None;
            }
            res
        }
        Err(_aborted) => {
            let _ = app.emit("chat-done", ());
            if let Ok(mut g) = abort_slot.lock() {
                *g = None;
            }
            Err("__cancelled__".to_string())
        }
    }
}
```

- [ ] **Step 4: 加 cancel_chat 命令**

在 `save_file` 之后插入：

```rust
/// 取消正在进行的 chat_stream（abort 当前 Abortable）。幂等：无句柄时空操作。
#[tauri::command]
fn cancel_chat(abort_slot: State<'_, AbortSlot>) -> Result<(), String> {
    let mut g = abort_slot.lock().map_err(|e| format!("锁失败: {e}"))?;
    if let Some(h) = g.take() {
        h.abort();
    }
    Ok(())
}
```

- [ ] **Step 5: 重写 list_models（格式分支）**

替换原 `ModelsConfig` 与 `list_models`（原第 135–172 行）为：

```rust
#[derive(Debug, Deserialize)]
struct ModelsConfig {
    api_base: String,
    api_key: String,
    #[serde(default)]
    format: String,
}

/// 取模型 id 列表：OpenAI 走 /models(Bearer)，Anthropic 走 /v1/models(x-api-key)。两边返回结构都取 data[].id。
#[tauri::command]
async fn list_models(config: ModelsConfig) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let is_anthropic = config.format == "anthropic";
    let url = if is_anthropic {
        format!("{}/v1/models", config.api_base.trim_end_matches('/'))
    } else {
        format!("{}/models", config.api_base.trim_end_matches('/'))
    };
    let mut req = client.get(&url);
    if is_anthropic {
        req = req
            .header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.header("Authorization", format!("Bearer {}", config.api_key));
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
    let mut ids = Vec::new();
    if let Some(arr) = v["data"].as_array() {
        for m in arr {
            if let Some(id) = m["id"].as_str() {
                ids.push(id.to_string());
            }
        }
    }
    Ok(ids)
}
```

- [ ] **Step 6: 注册 managed state 与 cancel_chat**

Modify `run()`：在 `.invoke_handler(...)` 之前加 `.manage(Mutex::new(None) as AbortSlot)`，并把 `cancel_chat` 加入 handler。替换原 builder 部分（原第 197–207 行）为：

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:auto_ppt.db", migrations)
                .build(),
        )
        .manage(Mutex::new(None) as AbortSlot)
        .invoke_handler(tauri::generate_handler![
            chat_stream, cancel_chat, save_file, list_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
```

- [ ] **Step 7: Rust 编译检查**

Run (in `src-tauri`): `cargo check`
Expected: PASS。若报 `future::Abortable` 未找到，确认 `use futures_util::{StreamExt, future::{Abortable, AbortHandle}}`——当前用全路径 `futures_util::future::Abortable`/`AbortHandle` 调用，应可解析。

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: chat_stream/list_models 支持 Anthropic 格式 + 多模态图片 + 取消中止"
```

---

### Task 3: chat.ts 读 getActiveAi + images + 取消哨兵

**Files:**
- Modify: `src/lib/chat.ts`

**Interfaces:**
- Consumes: `getActiveAi`/`AiConfig`（Task 1）；Rust `chat_stream`（Task 2，config 含 format/multimodal）。
- Produces: `ChatMsg` 含可选 `images`；`chat()` 抛带 `__cancelled` 标记的错。

- [ ] **Step 1: 重写 chat.ts**

Rewrite `src/lib/chat.ts` entirely:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getActiveAi } from "./aiConfig";
import type { ChatRole } from "./db";

export interface ChatMsg {
  role: ChatRole;
  content: string;
  /** dataURL 数组（多模态自检时附截图），OpenAI→image_url，Anthropic→image base64 */
  images?: string[];
}

/** 取消哨兵错误：取消时抛此，调用方识别 .__cancelled=true 不当硬错误。 */
export interface CancelledError extends Error {
  __cancelled: true;
}

export async function chat(
  messages: ChatMsg[],
  onChunk: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  jsonMode = false
): Promise<void> {
  const ai = await getActiveAi();
  if (!ai || !ai.api_base || !ai.api_key || !ai.model) {
    throw new Error("请先在「设置」页配置并启用一个 AI");
  }
  const config = {
    api_base: ai.api_base,
    api_key: ai.api_key,
    model: ai.model,
    format: ai.format,
    thinking_mode: ai.thinking_mode,
    thinking_effort: ai.thinking_effort,
    json_mode: jsonMode,
  };

  const onChunkUn = await listen<string>("chat-chunk", (e) => onChunk(e.payload));
  const onReasoningUn = onReasoning
    ? await listen<string>("chat-reasoning", (e) => onReasoning(e.payload))
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
    onStartUn();
  }
}

/** 便捷封装：一次性拿到完整回答文本（内部仍走流式）。 */
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

- [ ] **Step 2: 类型检查**

Run: `npm run build`
Expected: 仍可能因 `Settings.vue` 的旧 import 失败（Task 7 修）。若仅 `Settings.vue` 报错则通过本任务；`chat.ts`/`aiConfig.ts` 本身应无错。

- [ ] **Step 3: Commit**

```bash
git add src/lib/chat.ts
git commit -m "feat: chat 读 getActiveAi + 多模态 images + 取消哨兵识别"
```

---

### Task 4: genStore 取消标志 + selfcheck + 触发点

**Files:**
- Modify: `src/lib/genStore.ts`
- Modify: `src/lib/prompt.ts`（自检提示词）

**Interfaces:**
- Consumes: `renderSlideToDataUrl`（`ppt.ts`，已存在）；`chat`/`CancelledError`（Task 3）；`getActiveAi`（Task 1）。
- Produces: `genState.cancelled`、`selfcheck` phase、`selfCheckSlide`、`cancelGeneration`；`sendChat` 接受可选 elementHtml/selector。

- [ ] **Step 1: prompt.ts 加自检与调试选中提示词**

Modify `src/lib/prompt.ts`，在文件末尾追加：

```typescript
/** 多模态自检：对照截图与当前 HTML，返回改进版完整 HTML。 */
export function selfCheckPrompt(html: string): string {
  return `你是 PPT 视觉自检员。对照附图（当前页面渲染截图）与下方当前 HTML，找出视觉/排版/溢出/留白/对齐/字号可读性等问题，返回改进后的完整 HTML 文档（沿用同一 theme.css 与画布尺寸 1920×1080）。

当前 HTML：
${html}

【要求】只输出改进后的完整 HTML 文档（<!DOCTYPE html>…</html>），不要 markdown 代码块、不要解释。若当前页面已无明显问题，原样返回该 HTML。`;
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
```

- [ ] **Step 2: genStore 加 cancelled/selfcheck/cancelGeneration**

Modify `src/lib/genStore.ts`：

顶部 import 改为：

```typescript
import { chat, chatOnce, type ChatMsg, type CancelledError } from "./chat";
import {
  outlinePrompt,
  slideHtmlPrompt,
  parseOutline,
  cleanHtml,
  selfCheckPrompt,
  chatWithElementPrompt,
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
import { getActiveAi } from "./aiConfig";
import { renderSlideToDataUrl } from "./ppt";
```

`GenPhase` 加 `"selfcheck"`：

```typescript
export type GenPhase =
  | "idle"
  | "outline"
  | "outline-chat"
  | "slide"
  | "chat"
  | "selfcheck";
```

`genState` 加 `cancelled` 字段：

```typescript
export const genState = reactive({
  running: false,
  phase: "idle" as GenPhase,
  projectId: null as number | null,
  slideIdx: 0,
  reasoning: "",
  content: "",
  status: "",
  error: null as string | null,
  cancelled: false,
});
```

`resetBuffers` 清取消标志：

```typescript
function resetBuffers() {
  genState.reasoning = "";
  genState.content = "";
  genState.error = null;
  genState.cancelled = false;
}
```

加取消识别辅助与 `cancelGeneration`（放在 `resetBuffers` 之后）：

```typescript
function isCancelled(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as CancelledError).__cancelled === true;
}

/** 取消当前生成：置标志 + 调 Rust abort。 */
export async function cancelGeneration(): Promise<void> {
  if (!genState.running) return;
  genState.cancelled = true;
  try {
    await invoke("cancel_chat");
  } catch {
    /* 忽略：可能已自然结束 */
  }
}
```

顶部加 `import { invoke } from "@tauri-apps/api/core";`。

- [ ] **Step 3: 各 action 的 catch 识别取消**

修改 `startSlide` 的 `catch`（原第 248–251 行）为：

```typescript
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
      // 不写半截 HTML 进库
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "错误：" + genState.error;
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
```

`startOutline`、`sendOutlineChat`、`sendChat` 的 catch 块同样套用此 `if (isCancelled(e)) { genState.status = "已取消"; } else { ... }` 模式（各自替换原 catch 体）。`startOutline`/`sendOutlineChat` 的取消情况下同样跳过写库（它们的 `updateProject`/`upsertSlide` 在 try 内、parse 成功后，取消时 invoke 已抛、不会执行到写库，安全）。

- [ ] **Step 4: startAll 循环检查取消**

修改 `startAll`（原第 258–269 行）为：

```typescript
export async function startAll(
  projectId: number,
  slides: Slide[]
): Promise<void> {
  for (let i = 0; i < slides.length; i++) {
    if (genState.cancelled) break;
    if (slides[i].html_content) continue;
    await startSlide(projectId, slides, i);
    if (genState.cancelled || genState.error) break;
    // 多模态自检：仅当启用 AI 为多模态且 auto_selfcheck 开
    if (!genState.cancelled) await maybeSelfCheck(projectId, slides, i);
    genState.slideIdx = Math.min(i + 1, slides.length - 1);
  }
  if (!genState.error && !genState.cancelled) genState.status = "全部页面已生成";
}
```

- [ ] **Step 5: 加 maybeSelfCheck / selfCheckSlide + 触发**

在 `startAll` 之后插入：

```typescript
/** 若启用 AI 为多模态且 auto_selfcheck 开，对第 idx 页做自检。 */
async function maybeSelfCheck(
  projectId: number,
  slides: Slide[],
  idx: number
): Promise<void> {
  const ai = await getActiveAi();
  if (!ai?.multimodal) return;
  const flag = await getSetting("auto_selfcheck");
  if (flag === "false") return; // 默认开（null/其他均视为开）
  await selfCheckSlide(projectId, slides, idx);
}

/** 多模态自检：截图 → 发图+HTML 给 AI → 流式改写 → 校验后写库。 */
export async function selfCheckSlide(
  projectId: number,
  slides: Slide[],
  idx: number
): Promise<void> {
  const slide = slides[idx];
  if (!slide?.html_content) return;
  genState.projectId = projectId;
  genState.slideIdx = idx;
  genState.running = true;
  genState.phase = "selfcheck";
  resetBuffers();
  try {
    const dataUrl = await renderSlideToDataUrl(slide.html_content);
    const msgs: ChatMsg[] = [
      { role: "system", content: "你是 PPT 自检员，只输出改进后的完整 HTML。" },
      { role: "user", content: selfCheckPrompt(slide.html_content), images: [dataUrl] },
    ];
    await chat(
      msgs,
      (d) => {
        genState.content += d;
        slide.html_content = cleanHtml(genState.content);
        genState.status = `自检改写中… 已收到 ${genState.content.length} 字`;
      },
      (d) => {
        genState.reasoning += d;
        genState.status = `自检思考中… 已收到 ${genState.reasoning.length} 字思考`;
      }
    );
    const html = cleanHtml(genState.content);
    // 校验：必须是完整 HTML 文档且含 .slide 画布
    if (/<html/i.test(html) && /\.slide\b|class="slide"/.test(html)) {
      slide.html_content = html;
      await upsertSlide(slide);
      await addMessage(projectId, "assistant", `已自检并改进第 ${idx + 1} 页`, slide.id);
      genState.status = `第 ${idx + 1} 页已自检改进`;
    } else {
      await addMessage(projectId, "assistant", `第 ${idx + 1} 页自检未返回有效 HTML，已保留原页`, slide.id);
      genState.status = `第 ${idx + 1} 页自检未返回有效 HTML`;
    }
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "自检错误：" + genState.error;
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}
```

顶部 import 补 `getSetting`：

```typescript
import { getActiveAi, getSetting } from "./aiConfig";
```

- [ ] **Step 6: startSlide/genOne 触发自检**

`startSlide` 完成写库后（原第 247 行 `genState.status = ...第 idx+1 页已生成` 之前）插入：

```typescript
    // 多模态自检（单页生成入口）
    await maybeSelfCheck(projectId, slides, idx);
```

> 注意 `maybeSelfCheck` 定义在 `startSlide` 之后——TS 函数提升不适用于 `async function` 声明？实际上 `function` 声明会提升，`async function` 也是函数声明，会提升。`maybeSelfCheck` 用 `async function` 声明（非 const），可被 `startSlide` 引用。确认第 5 步用的是 `async function maybeSelfCheck(...)` 而非 `const`。

- [ ] **Step 7: sendChat 接受选中元素**

修改 `sendChat` 签名与消息构造。替换原 `sendChat`（原第 272–321 行）user 消息构造部分：

```typescript
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
    const userContent = element
      ? chatWithElementPrompt({
          html: cur.html_content,
          elementHtml: element.html,
          selector: element.selector,
          instruction,
        })
      : `这是当前页 HTML：\n${cur.html_content}\n\n用户修改指令：${instruction}`;
    const msgs: ChatMsg[] = [
      {
        role: "system",
        content:
          "你是专业前端。根据用户指令修改给定的幻灯片 HTML，只输出修改后的完整 HTML 文档，不要任何解释文字。",
      },
      { role: "user", content: userContent },
    ];
    await chat(
      msgs,
      (d) => {
        genState.content += d;
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
    await addMessage(projectId, "assistant", "已按指令更新当前页", cur.id);
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

- [ ] **Step 8: 类型检查**

Run: `npm run build`
Expected: `genStore.ts`/`prompt.ts`/`chat.ts`/`aiConfig.ts` 无错；可能仅 `Settings.vue` 报错（Task 7 修）。`ppt.ts` 的 `renderSlideToDataUrl` 已导出，应可 import。

- [ ] **Step 9: Commit**

```bash
git add src/lib/genStore.ts src/lib/prompt.ts
git commit -m "feat: genStore 取消标志 + 多模态自检 + 调试选中元素修改"
```

---

### Task 5: Settings.vue 多 AI 列表 + 编辑表单

**Files:**
- Modify: `src/pages/Settings.vue`

**Interfaces:**
- Consumes: `listAiConfigs/getActiveAi/saveAiConfig/deleteAiConfig/setActiveAi/getModelsCache/saveModelsCache/getSetting/setSetting`（Task 1）；`list_models` Rust 命令（Task 2，config 加 format）。
- Produces: 设置页可管理多个 AI 并单选启用。

- [ ] **Step 1: 重写 Settings.vue**

Rewrite `src/pages/Settings.vue` entirely:

```vue
<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  listAiConfigs,
  saveAiConfig,
  deleteAiConfig,
  setActiveAi,
  getModelsCache,
  saveModelsCache,
  getSetting,
  setSetting,
  type AiConfig,
  type AiFormat,
} from "../lib/aiConfig";
import Icon from "../components/Icon.vue";

const CUSTOM = "__custom__";
const configs = ref<AiConfig[]>([]);
const editing = ref<AiConfig | null>(null);
const models = ref<string[]>([]);
const modelChoice = ref<string>("");
const showKey = ref(false);
const loadingModels = ref(false);
const saved = ref(false);

// app 级开关：自动自检（仅多模态 AI 生效）
const autoSelfcheck = ref(true);

function emptyConfig(): AiConfig {
  return {
    name: "",
    api_base: "",
    api_key: "",
    model: "",
    format: "openai",
    multimodal: false,
    thinking_mode: false,
    thinking_effort: "high",
    enabled: false,
    models_cache: [],
  };
}

function syncChoice() {
  if (modelChoice.value === CUSTOM) return;
  modelChoice.value = editing.value?.model ? editing.value.model : CUSTOM;
}
watch(() => editing.value?.model, syncChoice);
watch(models, syncChoice);
watch(
  () => editing.value?.api_base,
  (v, old) => {
    if (editing.value && old && v !== old) {
      models.value = [];
      editing.value.models_cache = [];
    }
  }
);
watch(
  () => editing.value?.format,
  (v, old) => {
    if (editing.value && old && v !== old) {
      models.value = [];
      editing.value.models_cache = [];
    }
  }
);

onMounted(async () => {
  await load();
  autoSelfcheck.value = (await getSetting("auto_selfcheck")) !== "false";
});

async function load() {
  configs.value = await listAiConfigs();
  if (!editing.value) editing.value = configs.value[0] ?? null;
  if (editing.value?.id) {
    models.value = await getModelsCache(editing.value.id);
  }
  syncChoice();
}

function selectConfig(c: AiConfig) {
  // 切换编辑目标前先把当前 models_cache 落回（避免丢失）
  editing.value = { ...c };
  models.value = c.models_cache ?? [];
  syncChoice();
}

function newConfig() {
  editing.value = emptyConfig();
  models.value = [];
  modelChoice.value = CUSTOM;
}

async function fetchModels() {
  if (!editing.value) return;
  if (!editing.value.api_base || !editing.value.api_key) {
    alert("请先填写 API 地址和 Key");
    return;
  }
  loadingModels.value = true;
  try {
    const ids = await invoke<string[]>("list_models", {
      config: {
        api_base: editing.value.api_base,
        api_key: editing.value.api_key,
        format: editing.value.format,
      },
    });
    models.value = ids;
    editing.value.models_cache = ids;
    if (!ids.length) alert("未返回任何模型，可改用自定义输入");
  } catch (e: any) {
    alert("获取模型列表失败：" + e);
    models.value = [];
  } finally {
    loadingModels.value = false;
  }
}

function onChoice(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  modelChoice.value = v;
  if (editing.value && v !== CUSTOM) editing.value.model = v;
}

async function save() {
  if (!editing.value) return;
  if (!editing.value.name.trim()) editing.value.name = editing.value.model || "未命名 AI";
  const wasNew = !editing.value.id;
  const id = await saveAiConfig(editing.value);
  editing.value.id = id;
  if (editing.value.models_cache) await saveModelsCache(id, editing.value.models_cache);
  // 新建的第一个配置自动启用
  if (wasNew && configs.value.length === 0) {
    await setActiveAi(id);
    editing.value.enabled = true;
  }
  configs.value = await listAiConfigs();
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}

async function enable(c: AiConfig) {
  if (!c.id) return;
  await setActiveAi(c.id);
  configs.value = await listAiConfigs();
}

async function remove(c: AiConfig) {
  if (!c.id) return;
  if (!confirm(`删除配置「${c.name}」？`)) return;
  await deleteAiConfig(c.id);
  configs.value = await listAiConfigs();
  editing.value = configs.value[0] ?? null;
}

async function toggleAutoSelfcheck(v: boolean) {
  autoSelfcheck.value = v;
  await setSetting("auto_selfcheck", v ? "true" : "false");
}
</script>

<template>
  <div class="page">
    <h2>AI 配置</h2>
    <p class="muted">
      支持配置多个 AI 并单选启用。OpenAI 格式自动补 <code>/chat/completions</code>，Anthropic 格式走 <code>/v1/messages</code>。
    </p>

    <div class="list">
      <div
        v-for="c in configs"
        :key="c.id"
        class="cfg-row"
        :class="{ active: editing?.id === c.id }"
        @click="selectConfig(c)"
      >
        <div class="cfg-info">
          <span class="cfg-name">{{ c.name }}</span>
          <span class="badge" :class="c.format">{{ c.format }}</span>
          <span v-if="c.multimodal" class="badge mm">多模态</span>
          <span v-if="c.enabled" class="badge on">启用中</span>
        </div>
        <div class="cfg-actions" @click.stop>
          <button class="ghost" :class="{ primary: c.enabled }" @click="enable(c)">
            {{ c.enabled ? "已启用" : "启用" }}
          </button>
          <button class="ghost" @click="remove(c)">删除</button>
        </div>
      </div>
      <button class="ghost" @click="newConfig">+ 新建 AI 配置</button>
    </div>

    <div v-if="editing" class="col form">
      <label>
        名称
        <input v-model="editing.name" placeholder="如：DeepSeek / Claude" />
      </label>

      <div class="field">
        <span class="label">格式</span>
        <select v-model="editing.format">
          <option value="openai">openai（兼容）</option>
          <option value="anthropic">anthropic</option>
        </select>
        <span class="muted">旧配置默认 openai</span>
      </div>

      <label>
        API 地址 (api_base)
        <input v-model="editing.api_base" placeholder="https://api.deepseek.com" />
      </label>
      <label>
        API Key
        <div class="key-row">
          <input v-model="editing.api_key" :type="showKey ? 'text' : 'password'" placeholder="sk-..." />
          <button class="ghost icon-btn" type="button" @click="showKey = !showKey">
            <Icon :name="showKey ? 'eye-off' : 'eye'" :size="16" />
          </button>
        </div>
      </label>

      <div class="field">
        <span class="label">模型</span>
        <div class="model-row">
          <select :value="modelChoice" @change="onChoice">
            <option :value="CUSTOM">自定义输入</option>
            <option v-if="editing.model && !models.includes(editing.model)" :value="editing.model">
              {{ editing.model }}（已保存）
            </option>
            <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
          </select>
          <button class="ghost" @click="fetchModels" :disabled="loadingModels || !editing.api_base">
            {{ loadingModels ? "获取中…" : "获取列表" }}
          </button>
        </div>
      </div>
      <label v-if="modelChoice === CUSTOM" class="custom-model">
        <span class="lab"><Icon name="pencil" :size="14" /> 自定义模型 (model)</span>
        <input v-model="editing.model" placeholder="deepseek-chat" />
      </label>

      <div class="field">
        <span class="label">多模态</span>
        <select v-model.number="editing.multimodal">
          <option :value="false">否</option>
          <option :value="true">是</option>
        </select>
        <span class="muted">开启后生成每页自动截图自检（需模型支持图片输入）</span>
      </div>

      <div class="field">
        <span class="label">思考模式</span>
        <select v-model.number="editing.thinking_mode">
          <option :value="false">关</option>
          <option :value="true">开</option>
        </select>
      </div>
      <div class="field">
        <span class="label">思考强度</span>
        <select v-model="editing.thinking_effort" :disabled="!editing.thinking_mode">
          <option value="high">high</option>
          <option value="max">max</option>
        </select>
      </div>

      <div class="field">
        <span class="label">自动自检</span>
        <select :value="autoSelfcheck ? 'true' : 'false'" @change="toggleAutoSelfcheck(($event.target as HTMLSelectElement).value === 'true')">
          <option value="true">开</option>
          <option value="false">关</option>
        </select>
        <span class="muted">多模态 AI 每页生成后自动截图自检；关闭以节省调用</span>
      </div>

      <div class="row">
        <button class="primary" @click="save">保存</button>
        <span v-if="saved" class="muted">已保存</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 24px; max-width: 640px; }
.list { display: flex; flex-direction: column; gap: 8px; margin: 16px 0; }
.cfg-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
  cursor: pointer; gap: 8px;
}
.cfg-row.active { border-color: var(--primary); background: #eef; }
.cfg-info { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cfg-name { font-weight: 600; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #eee; }
.badge.anthropic { background: #f3e8ff; color: #7c3aed; }
.badge.mm { background: #dcfce7; color: #15803d; }
.badge.on { background: var(--primary); color: #fff; }
.cfg-actions { display: flex; gap: 6px; }
.form { gap: 16px; margin-top: 16px; }
label { display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
.custom-model .lab { display: flex; align-items: center; gap: 5px; }
.field { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 10px; }
.field .muted { grid-column: 2; font-weight: 400; }
.field .label { font-weight: 600; }
.field select { width: 100%; }
.model-row { display: flex; gap: 8px; }
.model-row select { flex: 1; }
button.ghost { padding: 6px 12px; white-space: nowrap; }
code { background: #eee; padding: 1px 5px; border-radius: 4px; }
.key-row { display: flex; gap: 8px; }
.key-row input { flex: 1; }
.icon-btn { padding: 6px 10px; display: flex; align-items: center; }
.row { display: flex; align-items: center; gap: 12px; }
</style>
```

> 注意：`editing.value.thinking_mode`/`multimodal` 用 `v-model.number` 绑 boolean（option 值为 `false`/`true`，number 修饰符把 `"true"`→1? 实际 select option 的 `:value="true"` 是布尔，无需 number。改用普通 `v-model` 即可，TS 上 `editing.thinking_mode` 是 boolean，select 的 `:value="false"`/`:value="true"` 绑定布尔原生支持）。**修正：把两个 `v-model.number` 改为 `v-model`**（`editing.thinking_mode` 和 `editing.multimodal`）。

- [ ] **Step 2: 修正 boolean 绑定**

把模板中两处 `v-model.number="editing.thinking_mode"` 和 `v-model.number="editing.multimodal"` 改为 `v-model="editing.thinking_mode"` 与 `v-model="editing.multimodal"`（option 用 `:value="false"`/`:value="true"` 布尔值）。

- [ ] **Step 3: 类型检查 + 手动验证**

Run: `npm run build`
Expected: PASS（全部 TS 错误应清零）。

Run: `npm run tauri dev`
手动验证：
1. 设置页显示旧配置（若有）已导入为一条 openai/启用。
2. 新建一条 Anthropic 配置，填 Claude 的 base/key/model，启用它。
3. 「获取列表」能拉到模型（验证 Anthropic 分支）。
4. 切换启用单选生效。

- [ ] **Step 4: Commit**

```bash
git add src/pages/Settings.vue
git commit -m "feat: 设置页多 AI 列表 + 格式/多模态配置"
```

---

### Task 6: SlidePreview inspectMode + ChatPanel prepend

**Files:**
- Modify: `src/components/SlidePreview.vue`
- Modify: `src/components/ChatPanel.vue`

**Interfaces:**
- Consumes: `SlidePreview` 由 `Editor`（Task 7）传 `inspectMode`。
- Produces: `SlidePreview` emit `pick {html, selector}`；`ChatPanel` 暴露 `prepend(text)`。

- [ ] **Step 1: SlidePreview 加 inspectMode + 点选**

Rewrite `src/components/SlidePreview.vue` `<script setup>` 部分（保留 template 与 style，仅改 script 与给 iframe 加 ref）：

```vue
<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { SLIDE_W, SLIDE_H } from "../lib/prompt";

const props = defineProps<{
  html: string;
  inspectMode?: boolean;
}>();
const emit = defineEmits<{ pick: [payload: { html: string; selector: string }] }>();

const wrap = ref<HTMLElement | null>(null);
const iframeEl = ref<HTMLIFrameElement | null>(null);
const scale = ref(0);
let ro: ResizeObserver | null = null;

function update() {
  if (!wrap.value) return;
  const w = wrap.value.clientWidth;
  const h = wrap.value.clientHeight;
  scale.value = Math.min(w / SLIDE_W, h / SLIDE_H);
}

function cssSelectorPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== node.ownerDocument!.body) {
    let sel = node.tagName.toLowerCase();
    if (node.id) {
      sel += `#${node.id}`;
      parts.unshift(sel);
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sibs.length > 1) {
        const idx = sibs.indexOf(node) + 1;
        sel += `:nth-child(${idx})`;
      }
    }
    parts.unshift(sel);
    node = parent;
  }
  return parts.join(" > ");
}

function attachInspector() {
  const doc = iframeEl.value?.contentDocument;
  if (!doc) return;
  doc.addEventListener("click", (e: MouseEvent) => {
    if (!props.inspectMode) return;
    e.preventDefault();
    const target = e.target as Element | null;
    if (!target) return;
    // 高亮
    doc.querySelectorAll("[data-inspect-hl]").forEach((n) => {
      n.removeAttribute("data-inspect-hl");
      (n as HTMLElement).style.outline = "";
    });
    (target as HTMLElement).style.outline = "2px solid #e03131";
    target.setAttribute("data-inspect-hl", "1");
    emit("pick", {
      html: (target as HTMLElement).outerHTML,
      selector: cssSelectorPath(target),
    });
  }, true);
}

async function reloadIframe() {
  await nextTick();
  attachInspector();
}

onMounted(() => {
  update();
  if (wrap.value) {
    ro = new ResizeObserver(update);
    ro.observe(wrap.value);
  }
  reloadIframe();
});
onBeforeUnmount(() => ro?.disconnect());
watch(() => props.html, reloadIframe);
watch(() => props.inspectMode, () => {
  const doc = iframeEl.value?.contentDocument;
  if (doc && !props.inspectMode) {
    doc.querySelectorAll("[data-inspect-hl]").forEach((n) => {
      n.removeAttribute("data-inspect-hl");
      (n as HTMLElement).style.outline = "";
    });
  }
});
</script>

<template>
  <div class="preview-wrap" ref="wrap">
    <div
      class="preview-stage"
      :style="{ width: SLIDE_W + 'px', height: SLIDE_H + 'px', transform: `scale(${scale})` }"
    >
      <iframe v-if="html" ref="iframeEl" :srcdoc="html" />
      <div v-else class="empty">尚未生成 HTML</div>
      <div v-if="inspectMode" class="inspect-hint">调试模式：点击元素送入对话栏</div>
    </div>
  </div>
</template>
```

在 `<style scoped>` 末尾追加：

```css
.inspect-hint {
  position: absolute;
  top: 8px;
  left: 8px;
  background: #e03131;
  color: #fff;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  z-index: 10;
}
```

> srcdoc iframe 同源，`contentDocument` 可读且可挂监听。高亮通过 outline 临时标记。

- [ ] **Step 2: ChatPanel 暴露 prepend**

Modify `src/components/ChatPanel.vue` `<script setup>`：在 `function onSend()` 之后、`</script>` 之前插入并暴露：

```typescript
function prepend(text: string) {
  input.value = text + "\n" + input.value;
}
defineExpose({ prepend });
```

（`input` ref 已存在。）

- [ ] **Step 3: 类型检查**

Run: `npm run build`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/components/SlidePreview.vue src/components/ChatPanel.vue
git commit -m "feat: SlidePreview 调试点选 + ChatPanel prepend"
```

---

### Task 7: Editor.vue 取消按钮 + 调试模式 + 导出标题

**Files:**
- Modify: `src/pages/Editor.vue`

**Interfaces:**
- Consumes: `cancelGeneration`/`selfCheckSlide`（Task 4）；`SlidePreview` inspectMode + `pick`（Task 6）；`ChatPanel` prepend（Task 6）；`exportPptx` 新签名（Task 9）。
- Produces: Editor 取消按钮、调试模式点选入对话、导出用项目名。

- [ ] **Step 1: 改 imports 与调试状态**

Modify `src/pages/Editor.vue` script 顶部 imports，把 genStore 导入改为：

```typescript
import { genState, startSlide, startAll, sendChat, cancelGeneration } from "../lib/genStore";
```

在 `const status = computed(...)` 之后加调试状态：

```typescript
const inspectMode = ref(false);
const chatPanelRef = ref<{ prepend: (t: string) => void } | null>(null);
```

- [ ] **Step 2: pick 处理**

在 `onChat` 之前加：

```typescript
function onPick(payload: { html: string; selector: string }) {
  const text = `【选中元素】\n\`\`\`html\n${payload.html}\n\`\`\`\n定位：${payload.selector}`;
  chatPanelRef.value?.prepend(text);
}

async function cancelRun() {
  await cancelGeneration();
}
```

- [ ] **Step 3: sendChat 传选中元素**

把 `onChat` 改为解析输入框前缀的选中元素块：

```typescript
async function onChat(text: string) {
  const sid = currentSlideId.value;
  messages.value.push({ project_id: projectId, slide_id: sid ?? null, role: "user", content: text });
  // 解析调试模式选中的元素块（若存在）
  let element: { html: string; selector: string } | undefined;
  const m = text.match(/【选中元素】\n```html\n([\s\S]*?)```\n定位：(.+)/);
  if (m) {
    element = { html: m[1].trim(), selector: m[2].trim() };
  }
  await sendChat(projectId, slides.value, currentIdx.value, text, element);
  slides.value = await listSlides(projectId);
  await loadMessages();
}
```

- [ ] **Step 4: 导出传 title**

`doExport` 改为：

```typescript
async function doExport() {
  await exportPptx(slides.value, projectId, project.value?.title);
}
```

- [ ] **Step 5: 模板加取消按钮 + 调试开关 + ref**

把 `.e-header` 里的按钮区（`<template v-else>...`）与 `<SlidePreview>`、`<ChatPanel>` 改造。替换整个 `<template>` 内容为：

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
        <button v-if="!slides.length" class="primary" :disabled="busy" @click="goOutline">生成大纲</button>
        <template v-else>
          <button v-if="busy" class="danger" @click="cancelRun">取消</button>
          <button v-else @click="genAll">生成全部 HTML</button>
          <button class="primary" :disabled="busy" @click="doExport">导出 PPT</button>
          <label class="toggle" :class="{ on: inspectMode }">
            <input type="checkbox" v-model="inspectMode" />
            调试模式
          </label>
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
          <button v-if="!s.html_content" class="mini" :disabled="busy" @click.stop="genOne(i)">生成</button>
        </div>
      </aside>

      <section class="e-preview">
        <SlidePreview v-if="current" :html="currentHtml" :inspect-mode="inspectMode" @pick="onPick" />
        <div v-else class="empty muted">生成大纲后这里显示预览</div>
      </section>

      <ChatPanel
        ref="chatPanelRef"
        :messages="messages"
        :running="runningOnCurrent"
        :reasoning="runningOnCurrent ? genState.reasoning : ''"
        :disabled="!current?.html_content"
        placeholder="对当前页的修改指令…（Ctrl/⌘+Enter 发送）"
        @send="onChat"
      />
    </div>
  </div>
</template>
```

在 `<style scoped>` 末尾追加：

```css
.danger { background: #e03131; color: #fff; border-color: #e03131; }
.toggle {
  display: flex; align-items: center; gap: 4px;
  font-size: 13px; padding: 4px 10px;
  border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
}
.toggle input { margin: 0; }
.toggle.on { border-color: var(--primary); color: var(--primary); }
```

- [ ] **Step 6: 类型检查 + 手动验证**

Run: `npm run build`
Expected: PASS。

Run: `npm run tauri dev`
手动验证：
1. 生成全部时出现"取消"按钮，点击后流程停止、status 显示"已取消"、库未写半截 HTML。
2. 勾"调试模式"，点击预览中元素 → 对话栏出现【选中元素】块，补写指令发送 → 该元素被精确修改（返回整页新 HTML）。
3. 导出 → 保存对话框默认文件名为项目标题。

- [ ] **Step 7: Commit**

```bash
git add src/pages/Editor.vue
git commit -m "feat: Editor 取消按钮 + 调试模式点选 + 导出标题"
```

---

### Task 8: Outline.vue 取消按钮

**Files:**
- Modify: `src/pages/Outline.vue`

- [ ] **Step 1: 加取消按钮**

Modify `src/pages/Outline.vue` script imports：

```typescript
import { genState, startOutline, sendOutlineChat, cancelGeneration } from "../lib/genStore";
```

模板 `.o-header` 按钮区，在「进入编辑器」之前加：

```vue
<button v-if="isRunning" class="danger" @click="cancelGeneration">取消</button>
```

`<style scoped>` 末尾追加：

```css
.danger { background: #e03131; color: #fff; border-color: #e03131; }
```

- [ ] **Step 2: 类型检查**

Run: `npm run build`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/pages/Outline.vue
git commit -m "feat: 大纲页取消按钮"
```

---

### Task 9: main.ts 旧数据导入 + 右键禁用 + devtools 拦截

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: 重写 main.ts**

Rewrite `src/main.ts` entirely:

```typescript
import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import "./styles.css";
import { ensureLegacyImport } from "./lib/aiConfig";

async function bootstrap() {
  // 旧数据兼容：表空且 settings 有旧配置时导入一条 openai/enabled
  await ensureLegacyImport();

  // 右键菜单：始终禁用（dev 仍可用 F12）
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  // devtools：仅生产构建拦截快捷键；dev 构建不拦截，保证开发期可用
  if (import.meta.env.PROD) {
    window.addEventListener("keydown", (e) => {
      const k = e.key?.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      // F12 / Ctrl+Shift+I,J,C / Cmd+Opt+I
      if (k === "f12") e.preventDefault();
      else if (ctrl && shift && ["i", "j", "c"].includes(k ?? "")) e.preventDefault();
    });
  }

  createApp(App).use(router).mount("#app");
}

bootstrap();
```

- [ ] **Step 2: 类型检查 + 手动验证**

Run: `npm run build`
Expected: PASS。

Run: `npm run tauri dev`
手动验证：
1. 右键页面无菜单。
2. dev 构建 F12 仍可打开 devtools（`import.meta.env.PROD` 为 false）。

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: 启动旧数据导入 + 右键禁用 + 生产 devtools 拦截"
```

---

### Task 10: 中文名 + 导出文件名

**Files:**
- Modify: `index.html`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src/App.vue`
- Modify: `src/lib/ppt.ts`

- [ ] **Step 1: index.html**

Modify `index.html`：

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>纸光幻演</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: tauri.conf.json 窗口 title**

Modify `src-tauri/tauri.conf.json`，window 的 `"title": "AutoPPT"` 改为 `"title": "纸光幻演"`（`productName` 保留 AutoPPT）。

- [ ] **Step 3: App.vue 品牌名**

Modify `src/App.vue` 模板，把品牌 `<span>AutoPPT</span>` 改为 `<span>纸光幻演</span>`。

- [ ] **Step 4: ppt.ts author + 导出文件名**

Modify `src/lib/ppt.ts`：`pptx.author = "AutoPPT"` 改为 `pptx.author = "纸光幻演"`。

`exportPptx` 签名与 `defaultPath`：替换原函数签名行与 `save({...})` 调用：

```typescript
export async function exportPptx(
  slides: Slide[],
  projectId: number,
  title?: string
): Promise<string> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "纸光幻演";

  for (const slide of slides) {
    if (!slide.html_content) continue;
    const dataUrl = await renderSlideToDataUrl(slide.html_content);
    const s = pptx.addSlide();
    s.addImage({ data: dataUrl, x: 0, y: 0, w: 13.333, h: 7.5 });
  }

  const result = (await pptx.write({ outputType: "blob" })) as Blob;
  const buf = new Uint8Array(await result.arrayBuffer());

  const safeName = (title ?? "").replace(/[\\/:*?"<>|]/g, "").trim();
  const defaultPath = (safeName ? safeName : "presentation") + ".pptx";

  const path = await save({
    title: "保存 PPT",
    defaultPath,
    filters: [{ name: "PowerPoint", extensions: ["pptx"] }],
  });
  if (!path) throw new Error("已取消导出");

  await invoke("save_file", { path, data: Array.from(buf) });
  await addExport(projectId, path);
  return path;
}
```

- [ ] **Step 5: 类型检查 + 手动验证**

Run: `npm run build`
Expected: PASS。

Run: `npm run tauri dev`
手动验证：
1. 窗口标题、品牌、`<title>` 均为「纸光幻演」。
2. 导出 → 默认文件名为项目标题（如项目名含非法字符则被剔除）。

- [ ] **Step 6: Commit**

```bash
git add index.html src-tauri/tauri.conf.json src/App.vue src/lib/ppt.ts
git commit -m "feat: 中文名纸光幻演 + 导出文件名用项目名"
```

---

## Self-Review 结果

**1. Spec 覆盖：**
- 需求 1（多模态配置）→ Task 1（multimodal 字段）+ Task 5（设置页开关）。✓
- 需求 2（多AI 单选启用）→ Task 1（setActiveAi 单选）+ Task 5（列表）。✓
- 需求 3（Anthropic 兼容 + 旧数据空=openai）→ Task 1（ensureLegacyImport）+ Task 2（Anthropic 分支）+ Task 5（格式下拉）。✓
- 需求 4a（多模态自检）→ Task 4（selfCheckSlide + base64 dataURL）。✓
- 需求 4b（右键禁 + devtools dev/prod）→ Task 9。✓
- 需求 5（中文名）→ Task 10。✓
- 需求 6（调试点选入对话）→ Task 6 + Task 7。✓
- 需求 7（导出文件名）→ Task 10。✓
- 新增：取消生成 → Task 2（cancel_chat/Abortable）+ Task 3（哨兵）+ Task 4（cancelGeneration）+ Task 7/8（按钮）。✓

**2. 类型一致性：**
- `AiConfig`/`AiFormat` 定义于 Task 1，Task 2 Rust 的 `format` 字符串与之一致（"openai"|"anthropic"）。✓
- `ChatMsg.images` Task 3 定义，Task 4 自检时传 `[dataUrl]`。✓
- `CancelledError` Task 3 定义，Task 4 `isCancelled` 识别 `.__cancelled`。✓
- `sendChat` 第 5 参数 `element?: {html, selector}` Task 4 定义，Task 7 传入。✓
- `exportPptx` 第三参 `title?` Task 10 定义，Task 7 Step 4 传入。✓
- `SlidePreview` props 加 `inspectMode` + emit `pick`，Task 7 模板用 `:inspect-mode` + `@pick`。✓
- `ChatPanel.prepend` Task 6 暴露，Task 7 通过 `chatPanelRef` 调用。✓

**3. 已修正项：** Task 5 Step 2 明确 `v-model.number` → `v-model`（布尔绑定）；Task 4 Step 6 注明 `maybeSelfCheck` 用函数声明以便提升。

无遗漏。计划完整。
