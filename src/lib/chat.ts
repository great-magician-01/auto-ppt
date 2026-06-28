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

/**
 * 流式对话。Rust 侧按 config.format 分发 OpenAI 兼容接口或 Anthropic 原生接口的 SSE 增量：
 *  - chat-start    : 连接已建立
 *  - chat-chunk    : 正式回答增量文本
 *  - chat-reasoning : 思考模式下的思考过程增量（思考阶段只有它，没有 chunk）
 *  - chat-done     : 流结束
 *
 * @param jsonMode 为 true 时强制 JSON 输出（OpenAI 的 response_format=json_object），
 *                 仅用于大纲等需要 JSON 的场景；Anthropic 忽略此项靠提示词约束。HTML 生成不可开。
 */
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
    // invoke 返回即代表流结束
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
