<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import type { Message } from "../lib/db";
import { marked } from "marked";
import DOMPurify from "dompurify";

const props = defineProps<{
  messages: Message[];
  running: boolean;
  reasoning?: string;
  disabled?: boolean;
  locked?: boolean;
  placeholder?: string;
}>();
const emit = defineEmits<{ send: [text: string] }>();

/** assistant 消息 markdown 渲染为安全 HTML（防注入）。 */
function renderMd(s: string): string {
  if (!s) return "";
  return DOMPurify.sanitize(marked.parse(s) as string);
}
/** 工具调用卡片的一行标签（从 messages.tool_call JSON 取 label）。 */
function toolLabelOf(m: Message): string | null {
  if (!m.tool_call) return null;
  try {
    return (JSON.parse(m.tool_call) as { label?: string }).label ?? null;
  } catch {
    return null;
  }
}

const input = ref("");
const listEl = ref<HTMLElement | null>(null);
// 实时思考卡片 <pre>：长思考需自动滚到底，外层列表滚动管不到它内部
const reasoningEl = ref<HTMLElement | null>(null);

async function scrollBottom() {
  await nextTick();
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
}
async function scrollReasoningBottom() {
  await nextTick();
  if (reasoningEl.value) reasoningEl.value.scrollTop = reasoningEl.value.scrollHeight;
}
watch(() => [props.messages.length, props.reasoning], scrollBottom);
// 思考内容增长 → 实时思考卡片内部自动滚到底
watch(() => props.reasoning, scrollReasoningBottom);

function onSend() {
  const text = input.value.trim();
  if (!text || props.running || props.disabled || props.locked) return;
  emit("send", text);
  input.value = "";
}

/** 把文本插入输入框开头（调试模式点选元素后调用）。 */
function prepend(text: string) {
  input.value = text + "\n" + input.value;
}
defineExpose({ prepend });
</script>

<template>
  <aside class="chat-panel">
    <div class="chat-list" ref="listEl">
      <div v-for="m in messages" :key="m.id ?? m.content" class="msg" :class="m.role">
        <span class="role">{{ m.role }}</span>
        <div v-if="m.role === 'assistant'" class="md" v-html="renderMd(m.content)"></div>
        <div v-else>{{ m.content }}</div>
        <!-- 工具调用卡片：工具调用产物阶段回填的 {name,label} -->
        <details v-if="m.role === 'assistant' && toolLabelOf(m)" class="msg-tool">
          <summary>{{ toolLabelOf(m) }}</summary>
        </details>
        <!-- 持久化思考：完成时回填到助手消息上，默认收起，可点开 -->
        <details v-if="m.role === 'assistant' && m.reasoning" class="msg-reasoning">
          <summary>思考 · {{ m.reasoning.length }} 字</summary>
          <pre>{{ m.reasoning }}</pre>
        </details>
      </div>
      <div v-if="running && reasoning" class="msg thinking">
        <span class="role">思考中</span>
        <pre ref="reasoningEl" class="reasoning">{{ reasoning }}</pre>
      </div>
      <div v-if="!messages.length && !running" class="muted">
        {{ placeholder ?? "输入修改指令…" }}
      </div>
    </div>
    <div class="chat-input">
      <textarea
        v-model="input"
        rows="3"
        :placeholder="locked ? '生成中，暂不能发送…' : (placeholder ?? '修改指令…（Ctrl/⌘+Enter 发送）')"
        :disabled="running || disabled || locked"
        @keydown.enter.ctrl="onSend"
        @keydown.enter.meta="onSend"
      ></textarea>
      <button class="primary" :disabled="running || disabled || locked || !input.trim()" @click="onSend">
        发送
      </button>
    </div>
  </aside>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-left: 1px solid var(--border);
}
.chat-list {
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.msg {
  font-size: 13px;
}
.msg .role {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  display: block;
  margin-bottom: 2px;
}
.msg.assistant .role {
  color: var(--primary);
}
.msg.thinking .role {
  color: var(--primary);
}
.reasoning {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  font-family: inherit;
  font-size: 12px;
  color: var(--muted);
  max-height: 240px;
  overflow: auto;
}
/* 持久化思考卡片：默认收起，展开时复用实时思考样式 */
.msg-reasoning {
  margin-top: 6px;
  font-size: 12px;
}
.msg-reasoning summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 11px;
}
.msg-reasoning pre {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 6px 0 0;
  font-family: inherit;
  font-size: 12px;
  color: var(--muted);
  max-height: 240px;
  overflow: auto;
}
.chat-input {
  border-top: 1px solid var(--border);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.msg.assistant .md {
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}
.msg.assistant .md :first-child {
  margin-top: 0;
}
.msg.assistant .md :last-child {
  margin-bottom: 0;
}
.msg.assistant .md p {
  margin: 0 0 6px;
}
.msg.assistant .md ul,
.msg.assistant .md ol {
  margin: 0 0 6px;
  padding-left: 20px;
}
.msg.assistant .md code {
  background: #f0f1f3;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.msg-tool {
  margin-top: 6px;
}
.msg-tool summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--primary);
  background: #eef;
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
}
</style>
