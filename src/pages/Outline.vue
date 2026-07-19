<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { useRouter } from "vue-router";
import ChatPanel from "../components/ChatPanel.vue";
import { genState, startOutline, sendOutlineChat, cancelGeneration } from "../lib/genStore";
import {
  getProject,
  listSlides,
  listProjectMessages,
  type Project,
  type Slide,
  type Message,
} from "../lib/db";
import { type OutlineSlide } from "../lib/prompt";

const props = defineProps<{ id: string }>();
const router = useRouter();
const projectId = Number(props.id);

const project = ref<Project | null>(null);
const slides = ref<Slide[]>([]);
const messages = ref<Message[]>([]);
// 大纲流式思考 <pre>：长思考自动滚到底
const reasoningEl = ref<HTMLElement | null>(null);

async function scrollReasoningBottom() {
  await nextTick();
  if (reasoningEl.value) reasoningEl.value.scrollTop = reasoningEl.value.scrollHeight;
}
watch(() => genState.reasoning, scrollReasoningBottom);

const isRunning = computed(
  () => genState.running && genState.projectId === projectId
);
// 当前大纲结构化展示：从库中已存大纲渲染（生成中显示占位，落地后由 watch(running) 重载）
const outlineView = computed<OutlineSlide[]>(() =>
  slides.value
    .map((s) => (s.outline ? (JSON.parse(s.outline) as OutlineSlide) : null))
    .filter((s): s is OutlineSlide => s !== null)
);

onMounted(load);

// 生成/对话修改在后台完成时（含 startOutline 的 fire-and-forget），重载库内容
watch(
  () => genState.running,
  async (running, wasRunning) => {
    if (wasRunning && !running && genState.projectId === projectId) {
      project.value = await getProject(projectId);
      slides.value = await listSlides(projectId);
      messages.value = await listProjectMessages(projectId);
    }
  }
);

async function load() {
  project.value = await getProject(projectId);
  slides.value = await listSlides(projectId);
  messages.value = await listProjectMessages(projectId);
  // 若没有大纲且未在生成中，自动开始
  if (
    !slides.value.length &&
    !(genState.running && genState.projectId === projectId)
  ) {
    if (project.value) {
      startOutline(
        projectId,
        project.value.topic,
        project.value.style ?? null,
        !!project.value.search_enabled
      );
    }
  }
}

async function onSend(text: string) {
  if (!project.value) return;
  const currentSlides: OutlineSlide[] = slides.value
    .map((s) => (s.outline ? (JSON.parse(s.outline) as OutlineSlide) : null))
    .filter((s): s is OutlineSlide => s !== null);
  await sendOutlineChat(
    projectId,
    project.value.topic,
    project.value.style ?? null,
    currentSlides,
    text,
    project.value.manuscript
  );
  // 完成后重载
  slides.value = await listSlides(projectId);
  messages.value = await listProjectMessages(projectId);
}

function goEditor() {
  router.push(`/editor/${projectId}`);
}
</script>

<template>
  <div class="outline-page" v-if="project">
    <div class="o-header">
      <div class="header-left">
        <h3>大纲工作台 · {{ project.title }}</h3>
        <span class="muted topic-text" :title="project.topic">主题：{{ project.topic }}</span>
      </div>
      <div class="row">
        <span class="muted">{{ genState.status }}</span>
        <button v-if="isRunning" class="danger" @click="cancelGeneration">取消</button>
        <button class="primary" :disabled="!slides.length" @click="goEditor">
          进入编辑器 →
        </button>
      </div>
    </div>
    <div class="o-body">
      <section class="o-main">
        <details
          v-if="project.manuscript || (isRunning && genState.phase === 'manuscript')"
          class="manuscript-block"
          open
        >
          <summary>
            完整文案（{{ (project.manuscript || genState.artifact).length }} 字）
          </summary>
          <pre>{{ project.manuscript || genState.artifact }}</pre>
        </details>
        <div v-if="isRunning && !outlineView.length" class="stream">
          <div v-if="genState.reasoning" class="block">
            <span class="label">思考 / 调研</span>
            <pre ref="reasoningEl">{{ genState.reasoning }}</pre>
          </div>
          <div class="block">
            <span class="label">
              {{ genState.phase === 'manuscript' ? '文案（生成中）' : '大纲（生成中）' }}
            </span>
            <pre>{{ genState.phase === 'manuscript' ? (project.manuscript || genState.artifact) : '正在生成大纲…' }}</pre>
          </div>
        </div>
        <div v-else class="outline-cards">
          <div v-for="(s, i) in outlineView" :key="i" class="ocard">
            <div class="row">
              <span class="num">{{ i + 1 }}</span>
              <span class="kind">{{ s.kind }}</span>
            </div>
            <div class="otitle">{{ s.title }}</div>
            <ul v-if="s.bullets?.length">
              <li v-for="(b, j) in s.bullets" :key="j">{{ b }}</li>
            </ul>
          </div>
          <div v-if="!outlineView.length" class="muted">等待生成…</div>
        </div>
      </section>
      <ChatPanel
        :messages="messages"
        :running="isRunning"
        :reasoning="isRunning ? genState.reasoning : ''"
        :locked="genState.running"
        :disabled="!slides.length && !isRunning"
        placeholder="修改大纲，如：把第3页拆成两页 / 加一页讲应用场景…"
        @send="onSend"
      />
    </div>
  </div>
</template>

<style scoped>
.outline-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.o-header {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.o-body {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 360px;
  overflow: hidden;
}
.o-main {
  padding: 20px;
  overflow: auto;
}
.stream .block {
  margin-bottom: 16px;
}
.stream .label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  display: block;
  margin-bottom: 6px;
}
.stream pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  padding: 12px;
  border-radius: 10px;
  margin: 0;
  max-height: 360px;
  overflow: auto;
}
.outline-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ocard {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
  background: var(--panel);
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.15s ease;
}
.ocard:hover {
  box-shadow: var(--shadow-md);
}
.ocard .num {
  font-weight: 700;
  font-size: 12px;
  color: var(--primary);
  background: var(--primary-soft);
  border-radius: 7px;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ocard .kind {
  font-size: 11px;
  font-weight: 600;
  background: var(--primary-soft);
  color: var(--primary);
  padding: 2px 9px;
  border-radius: 999px;
}
.ocard .otitle {
  font-weight: 600;
  font-size: 15px;
  margin: 8px 0 6px;
}
.ocard ul {
  margin: 0;
  padding-left: 20px;
}
.ocard li {
  font-size: 13px;
  line-height: 1.7;
}
.ocard li::marker {
  color: var(--primary);
}
.danger {
  background: #e03131;
  color: #fff;
  border-color: #e03131;
  box-shadow: 0 1px 3px rgba(224, 49, 49, 0.35);
}
.danger:hover:not(:disabled) {
  background: #c92a2a;
  border-color: #c92a2a;
  color: #fff;
}
.manuscript-block {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--panel);
  box-shadow: var(--shadow-sm);
  margin-bottom: 14px;
}
.manuscript-block summary {
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s ease;
}
.manuscript-block summary:hover {
  color: var(--primary);
}
.manuscript-block pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  margin: 8px 0 0;
  max-height: 320px;
  overflow: auto;
}
</style>
