use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatConfig {
    api_base: String,
    api_key: String,
    model: String,
    #[serde(default)]
    thinking_mode: bool,
    #[serde(default)]
    thinking_effort: String,
    #[serde(default)]
    json_mode: bool,
}

/// 流式调用 OpenAI 兼容接口（/v1/chat/completions）。
/// 通过 tauri 事件 `chat-chunk`(String) 推增量文本，结束时推 `chat-done`(())。
#[tauri::command]
async fn chat_stream(
    app: AppHandle,
    config: ChatConfig,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let url = format!(
        "{}/chat/completions",
        config.api_base.trim_end_matches('/')
    );
    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
    });
    // 思考模式：开启时传 thinking(enabled)；思考强度仅在此模式下发送
    if config.thinking_mode {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("thinking".to_string(), serde_json::json!({"type": "enabled"}));
            if !config.thinking_effort.is_empty() {
                obj.insert(
                    "reasoning_effort".to_string(),
                    serde_json::Value::String(config.thinking_effort.clone()),
                );
            }
        }
    }
    // JSON 模式：强制模型返回合法 JSON（仅大纲生成用；HTML 生成不开）
    if config.json_mode {
        if let Some(obj) = body.as_object_mut() {
            obj.insert(
                "response_format".to_string(),
                serde_json::json!({"type": "json_object"}),
            );
        }
    }

    let resp = client
        .post(&url)
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

    // 连接已建立（200），通知前端请求已发出
    let _ = app.emit("chat-start", ());

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取流失败: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // SSE 按行解析
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
                let _ = app.emit("chat-done", ());
                return Ok(());
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                let delta = &v["choices"][0]["delta"];
                // 正式回答内容
                if let Some(content) = delta["content"].as_str() {
                    if !content.is_empty() {
                        let _ = app.emit("chat-chunk", content);
                    }
                }
                // 思考内容（思考模式开启时，思考阶段只有这个字段）
                if let Some(reasoning) = delta["reasoning_content"].as_str() {
                    if !reasoning.is_empty() {
                        let _ = app.emit("chat-reasoning", reasoning);
                    }
                }
            }
        }
    }

    let _ = app.emit("chat-done", ());
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
}

/// 调用 {api_base}/models 获取可用模型 id 列表（OpenAI 兼容，各家基本都支持）。
#[tauri::command]
async fn list_models(config: ModelsConfig) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let url = format!("{}/models", config.api_base.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析失败: {e}"))?;
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
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:auto_ppt.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![chat_stream, save_file, list_models])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
