import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getActiveAi } from "./aiConfig";
import type { ChatRole } from "./db";

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

/**
 * 多轮 agent loop：模型可用工具调研，每轮执行工具并把结果回填，直到无工具调用的最终回复。
 * - 每轮开始调 onRoundStart（调用方在此清空 genState.content，避免中间文本污染最终文案）。
 * - chatAgent 内部也累加 finalText 用于 return，同时通过 onChunk 把最终轮 token 推给 UI 实时显示。
 * - 调用上限：默认 LLM ≤50 轮、工具 ≤20 次，触顶追加 system 指令强制收尾。
 * - isCancelled：调用方传入取消检查回调，轮间/工具执行后检测到取消即中断（避免取消失效继续消耗额度）。
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
  isCancelled?: () => boolean
): Promise<string> {
  const messages: ChatMsg[] = [...initMessages];
  let toolCount = 0;
  let finalText = "";
  for (let round = 0; round < limits.maxLlmRounds; round++) {
    if (isCancelled?.()) return finalText;
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
    // 只执行剩余配额内的工具调用，助手消息仅回填已执行的 calls
    // （API 要求每个 tool_call_id 都必须有对应 tool 结果，否则 400）
    const remaining = limits.maxToolCalls - toolCount;
    const callsToExec = toolCalls.slice(0, Math.max(0, remaining));
    const dropped = toolCalls.length - callsToExec.length;
    const assistantMsg: ChatMsg = { role: "assistant", content: finalText };
    if (callsToExec.length > 0) {
      assistantMsg.tool_calls = callsToExec;
    }
    messages.push(assistantMsg);
    for (const call of callsToExec) {
      if (isCancelled?.()) return finalText;
      const result = await execTool(call);
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
      toolCount++;
    }
    // 工具执行后再次检查取消（工具 HTTP 调用不可中止，取消后不应进入下一轮）
    if (isCancelled?.()) return finalText;
    // 达到/超过工具上限：追加 system 指令强制收尾，并跳出循环走末尾的无工具请求
    // （不能继续传 tools 跑剩余轮数：模型若不服从仍会发 tool_calls，callsToExec 为空，
    //  既不执行也不增加 toolCount，循环会空转到 maxLlmRounds，白费大量调用）
    if (toolCount >= limits.maxToolCalls) {
      let msg =
        "已达到工具调用上限，请停止调用工具，直接基于已有信息产出最终文案。";
      if (dropped > 0) {
        const names = toolCalls.slice(callsToExec.length).map((c) => c.name).join("、");
        msg += ` 本轮有 ${dropped} 个调用因配额不足被跳过：${names}`;
      }
      messages.push({ role: "system", content: msg });
      break;
    }
  }
  // 触顶 LLM 轮数：最后一轮强制无工具请求
  if (isCancelled?.()) return finalText;
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
