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
  /** OpenAI strict 模式（强 Schema 校验）；Anthropic 忽略（input_schema 原生强校验） */
  strict?: boolean;
}

/** 中性工具选择策略，由 Rust 按格式翻译。 */
export type ToolChoice =
  | { type: "auto" }
  | { type: "required" }
  | { type: "tool"; name: string };

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
