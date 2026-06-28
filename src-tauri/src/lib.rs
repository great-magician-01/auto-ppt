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
    let body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
    });

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
                if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                    let _ = app.emit("chat-chunk", delta);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![tauri_plugin_sql::Migration {
        version: 1,
        description: "init tables",
        sql: include_str!("../migrations/001_init.sql"),
        kind: tauri_plugin_sql::MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:auto_ppt.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![chat_stream, save_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
