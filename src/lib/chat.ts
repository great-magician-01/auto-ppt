import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSettings } from "./settings";
import type { ChatRole } from "./db";

export interface ChatMsg {
  role: ChatRole;
  content: string;
}

/**
 * 流式对话。Rust 侧把 OpenAI 兼容接口的 SSE 增量通过事件推回：
 *  - chat-start    : 连接已建立
 *  - chat-chunk    : 正式回答增量文本
 *  - chat-reasoning : 思考模式下的思考过程增量（思考阶段只有它，没有 chunk）
 *  - chat-done     : 流结束
 *
 * @param jsonMode 为 true 时强制 JSON 输出（response_format=json_object），
 *                 仅用于大纲等需要 JSON 的场景；HTML 生成不可开。
 */
export async function chat(
  messages: ChatMsg[],
  onChunk: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  jsonMode = false
): Promise<void> {
  const settings = await getSettings();
  if (!settings.api_base || !settings.api_key || !settings.model) {
    throw new Error("请先在「设置」页配置 API 地址、密钥和模型");
  }
  const config = { ...settings, json_mode: jsonMode };

  const onChunkUn = await listen<string>("chat-chunk", (e) => onChunk(e.payload));
  const onReasoningUn = onReasoning
    ? await listen<string>("chat-reasoning", (e) => onReasoning(e.payload))
    : null;
  const onStartUn = await listen("chat-start", () =>
    console.log("[chat] 连接已建立，开始接收流")
  );
  try {
    // invoke 返回即代表流结束
    await invoke("chat_stream", { config, messages });
  } catch (e) {
    console.error("[chat] 调用失败：", e);
    throw e;
  } finally {
    onChunkUn();
    onReasoningUn?.();
    onStartUn();
  }
}

/**
 * 便捷封装：一次性拿到完整回答文本（内部仍走流式）。
 */
export async function chatOnce(
  messages: ChatMsg[],
  onReasoning?: (delta: string) => void,
  jsonMode = false
): Promise<string> {
  let full = "";
  await chat(messages, (d) => (full += d), onReasoning, jsonMode);
  return full;
}
