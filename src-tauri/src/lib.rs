use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

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

#[derive(Debug, Default, Clone)]
#[allow(dead_code)]
struct ToolAccum {
    index: usize,
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
    #[serde(default)]
    images: Vec<String>, // dataURL: "data:image/png;base64,..."
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
    format: String, // "openai" | "anthropic"，缺省 openai
    #[serde(default)]
    thinking_mode: bool,
    #[serde(default)]
    thinking_effort: String,
    #[serde(default)]
    json_mode: bool,
    #[serde(default)]
    tools: Vec<ToolDef>,
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

/// Anthropic：system 提到顶层字符串；非 system 进 messages。
/// assistant tool_use → content 块数组；role:"tool" → 作为 user 的 tool_result 块。
/// 连续多条 tool 结果合并进同一条 user 消息（多个 tool_result 块），
/// 否则会得到连续的 user 消息，违反 Anthropic「user/assistant 必须交替」要求而 400。
fn anthropic_split(messages: &[ChatMessage]) -> (String, Vec<serde_json::Value>) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut rest: Vec<serde_json::Value> = Vec::new();
    // 待合并的连续 tool 结果块；遇非 tool 消息时 flush 成一条 user 消息
    let mut pending_tool_results: Vec<serde_json::Value> = Vec::new();
    let flush_tool_results =
        |pending: &mut Vec<serde_json::Value>, rest: &mut Vec<serde_json::Value>| {
            if !pending.is_empty() {
                rest.push(serde_json::json!({
                    "role": "user",
                    "content": std::mem::take(pending),
                }));
            }
        };
    for m in messages {
        if m.role == "system" {
            flush_tool_results(&mut pending_tool_results, &mut rest);
            system_parts.push(m.content.clone());
            continue;
        }
        if m.role == "tool" {
            // 工具结果：累积为 user 消息的 tool_result 块，与相邻 tool 结果合并
            pending_tool_results.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                "content": m.content,
            }));
            continue;
        }
        flush_tool_results(&mut pending_tool_results, &mut rest);
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
    flush_tool_results(&mut pending_tool_results, &mut rest);
    (system_parts.join("\n\n"), rest)
}

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
                    let new_idx = acc.len();
                    acc.push(ToolAccum {
                        index: new_idx,
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
        .connect_timeout(std::time::Duration::from_secs(15))
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
        // 工具：Anthropic tools → [{name, description, input_schema}]
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
        // 工具：OpenAI tools → [{type:function, function:{name,description,parameters}}] + tool_choice:auto
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

    // tool_call 累积缓冲：OpenAI 按 delta.tool_calls[].index 对齐；Anthropic 按 content_block_start(tool_use) 顺序追加
    let tool_acc: std::sync::Arc<std::sync::Mutex<Vec<ToolAccum>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let tool_acc2 = tool_acc.clone();

    let streaming = async move {
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();

        if is_anthropic {
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
            emit_tool_calls(&app2, &tool_acc2);
        } else {
            // OpenAI SSE：解析 delta.content/reasoning_content/tool_calls
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
                        emit_tool_calls(&app2, &tool_acc2);
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
                        // tool_calls 增量：按 index 累积 id/name/arguments
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
                                    }
                                }
                            }
                        }
                    }
                }
            }
            emit_tool_calls(&app2, &tool_acc2);
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
        .timeout(std::time::Duration::from_secs(60))
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
            let content = if content.len() > 1500 {
                // 按字符边界安全截断（直接 byte index 切片会 panic 在多字节 UTF-8 字符中间）
                content.chars().take(1500).collect::<String>()
            } else {
                content
            };
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
        .timeout(std::time::Duration::from_secs(60))
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
            let raw = if raw.len() > 4000 {
                // 按字符边界安全截断
                raw.chars().take(4000).collect::<String>()
            } else {
                raw
            };
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
        .timeout(std::time::Duration::from_secs(30))
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
        tauri_plugin_sql::Migration {
            version: 5,
            description: "add reasoning column to messages for thinking persistence",
            sql: include_str!("../migrations/005_add_reasoning_to_messages.sql"),
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 6,
            description: "add manuscript and search_enabled to projects",
            sql: include_str!("../migrations/006_add_manuscript_and_search.sql"),
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
            chat_stream, cancel_chat, save_file, list_models, tavily_search, tavily_extract
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
