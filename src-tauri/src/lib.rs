use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

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

    // 构造 url / headers / body（按格式分支）。url 仅在各自分支内用于 .post(&url)。
    let req = if is_anthropic {
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
        client
            .post(&url)
            .header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body)
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
        client
            .post(&url)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
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

/// 取消正在进行的 chat_stream（abort 当前 Abortable）。幂等：无句柄时空操作。
#[tauri::command]
fn cancel_chat(abort_slot: State<'_, AbortSlot>) -> Result<(), String> {
    let mut g = abort_slot.lock().map_err(|e| format!("锁失败: {e}"))?;
    if let Some(h) = g.take() {
        h.abort();
    }
    Ok(())
}

/// 将二进制数据写入指定路径（导出 pptx 用，绕开 fs scope 限制）。
#[tauri::command]
fn save_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| format!("写入文件失败: {e}"))
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        tauri_plugin_sql::Migration {
            version: 3,
            description: "add slide_id to messages for per-page chat",
            sql: include_str!("../migrations/003_add_slide_id_to_messages.sql"),
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 4,
            description: "ai_configs table for multiple AI providers",
            sql: include_str!("../migrations/004_ai_configs.sql"),
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
    ];

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
}
