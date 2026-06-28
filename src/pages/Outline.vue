<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import ChatPanel from "../components/ChatPanel.vue";
import { genState, startOutline, sendOutlineChat } from "../lib/genStore";
import {
  getProject,
  listSlides,
  listProjectMessages,
  type Project,
  type Slide,
  type Message,
} from "../lib/db";
import { parseOutline, type OutlineSlide } from "../lib/prompt";

const props = defineProps<{ id: string }>();
const router = useRouter();
const projectId = Number(props.id);

const project = ref<Project | null>(null);
const slides = ref<Slide[]>([]);
const messages = ref<Message[]>([]);

const isRunning = computed(
  () => genState.running && genState.projectId === projectId
);
// 当前大纲结构化展示：生成中尝试解析实时 content；否则从库中已存大纲渲染
const outlineView = computed<OutlineSlide[]>(() => {
  if (isRunning.value && genState.content) {
    try {
      return parseOutline(genState.content).slides;
    } catch {
      return [];
    }
  }
  return slides.value
    .map((s) => (s.outline ? (JSON.parse(s.outline) as OutlineSlide) : null))
    .filter((s): s is OutlineSlide => s !== null);
});

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
      startOutline(projectId, project.value.topic, project.value.style ?? null);
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
    text
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
      <div>
        <h3>大纲工作台 · {{ project.title }}</h3>
        <span class="muted">主题：{{ project.topic }}</span>
      </div>
      <div class="row">
        <span class="muted">{{ genState.status }}</span>
        <button class="primary" :disabled="!slides.length" @click="goEditor">
          进入编辑器 →
        </button>
      </div>
    </div>
    <div class="o-body">
      <section class="o-main">
        <div v-if="isRunning && !outlineView.length" class="stream">
          <div v-if="genState.reasoning" class="block">
            <span class="label">思考</span>
            <pre>{{ genState.reasoning }}</pre>
          </div>
          <div class="block">
            <span class="label">正文（JSON 流式）</span>
            <pre>{{ genState.content }}</pre>
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
  color: var(--muted);
  display: block;
  margin-bottom: 4px;
}
.stream pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  background: #f7f8fa;
  padding: 10px;
  border-radius: 6px;
  margin: 0;
  max-height: 360px;
  overflow: auto;
}
.outline-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ocard {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: var(--panel);
}
.ocard .num {
  font-weight: 700;
  color: var(--muted);
}
.ocard .kind {
  font-size: 11px;
  background: #eef;
  color: var(--primary);
  padding: 1px 6px;
  border-radius: 4px;
}
.ocard .otitle {
  font-weight: 600;
  margin: 6px 0;
}
.ocard ul {
  margin: 0;
  padding-left: 20px;
}
.ocard li {
  font-size: 13px;
}
</style>
