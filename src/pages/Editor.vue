<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import SlidePreview from "../components/SlidePreview.vue";
import ChatPanel from "../components/ChatPanel.vue";
import {
  getProject,
  listSlides,
  listSlideMessages,
  type Project,
  type Slide,
  type Message,
} from "../lib/db";
import { genState, startSlide, startAll, sendChat } from "../lib/genStore";
import { cleanHtml } from "../lib/prompt";
import { exportPptx } from "../lib/ppt";

const props = defineProps<{ id: string }>();
const router = useRouter();
const projectId = Number(props.id);

const project = ref<Project | null>(null);
const slides = ref<Slide[]>([]);
const messages = ref<Message[]>([]);
const currentIdx = ref(0);
const busy = computed(() => genState.running);
const status = computed(() => genState.status);
const runningHere = computed(
  () => genState.running && genState.projectId === projectId
);

const current = computed(() => slides.value[currentIdx.value] ?? null);
const currentSlideId = computed(() => current.value?.id ?? null);
// 是否正在生成/修改当前页（思考流卡片只在此页显示）
const runningOnCurrent = computed(
  () =>
    runningHere.value &&
    genState.slideIdx === currentIdx.value &&
    (genState.phase === "slide" || genState.phase === "chat")
);

async function loadMessages() {
  const sid = currentSlideId.value;
  messages.value = sid != null ? await listSlideMessages(sid) : [];
}

// 当前页 HTML：生成/修改中读 store 实时缓冲，否则读库
// （切走再回来时 slides 是新数组、不再持有旧引用，故必须读 genState.content 才能见实时流）
const currentHtml = computed(() => {
  const cur = current.value;
  if (!cur) return "";
  if (
    runningHere.value &&
    genState.slideIdx === currentIdx.value &&
    (genState.phase === "slide" || genState.phase === "chat")
  ) {
    return cleanHtml(genState.content);
  }
  return cur.html_content ?? "";
});

onMounted(load);

// 后台生成完成时（含切走再回来、genAll 在前一个组件实例里跑完），重载库最终态
watch(
  () => genState.running,
  async (running, wasRunning) => {
    if (wasRunning && !running && genState.projectId === projectId) {
      slides.value = await listSlides(projectId);
      await loadMessages();
    }
  }
);

async function load() {
  project.value = await getProject(projectId);
  slides.value = await listSlides(projectId);
  // 若生成已在进行（切走再回来），跟随 store 当前进度
  if (
    runningHere.value &&
    (genState.phase === "slide" || genState.phase === "chat")
  ) {
    currentIdx.value = Math.min(
      genState.slideIdx,
      Math.max(0, slides.value.length - 1)
    );
  } else {
    currentIdx.value = 0;
  }
  await loadMessages();
}

// 切换当前页（手动点击 / genAll 自动翻页）时，加载该页的会话
watch(currentIdx, () => {
  loadMessages();
});

// 生成全部时自动翻页：跟随 store 推进的 slideIdx
watch(
  () => genState.slideIdx,
  (idx) => {
    if (
      runningHere.value &&
      (genState.phase === "slide" || genState.phase === "chat")
    ) {
      currentIdx.value = Math.min(idx, Math.max(0, slides.value.length - 1));
    }
  }
);

function goOutline() {
  router.push(`/outline/${projectId}`);
}

async function genOne(idx: number) {
  await startSlide(projectId, slides.value, idx);
  slides.value = await listSlides(projectId);
  await loadMessages();
}

async function genAll() {
  await startAll(projectId, slides.value);
  slides.value = await listSlides(projectId);
  await loadMessages();
}

async function onChat(text: string) {
  // 立即回显用户消息（不等流结束），与原 Editor 行为一致
  const sid = currentSlideId.value;
  messages.value.push({
    project_id: projectId,
    slide_id: sid ?? null,
    role: "user",
    content: text,
  });
  await sendChat(projectId, slides.value, currentIdx.value, text);
  slides.value = await listSlides(projectId);
  await loadMessages();
}

async function doExport() {
  await exportPptx(slides.value, projectId);
}
</script>

<template>
  <div class="editor" v-if="project">
    <div class="e-header">
      <div class="col">
        <div class="row">
          <h3>{{ project.title }}</h3>
          <span class="muted">{{ status }}</span>
        </div>
        <span class="muted">主题：{{ project.topic }}</span>
      </div>
      <div class="row">
        <button v-if="!slides.length" class="primary" :disabled="busy" @click="goOutline">
          生成大纲
        </button>
        <template v-else>
          <button :disabled="busy" @click="genAll">生成全部 HTML</button>
          <button class="primary" :disabled="busy" @click="doExport">导出 PPT</button>
        </template>
      </div>
    </div>

    <div class="e-body">
      <aside class="e-list">
        <div
          v-for="(s, i) in slides"
          :key="s.id"
          class="item"
          :class="{ active: i === currentIdx }"
          @click="currentIdx = i"
        >
          <span class="num">{{ i + 1 }}</span>
          <div class="col">
            <span class="t">{{ s.title || "(未命名)" }}</span>
            <span class="muted">{{ s.html_content ? "已生成" : "待生成" }}</span>
          </div>
          <button
            v-if="!s.html_content"
            class="mini"
            :disabled="busy"
            @click.stop="genOne(i)"
          >
            生成
          </button>
        </div>
      </aside>

      <section class="e-preview">
        <SlidePreview v-if="current" :html="currentHtml" />
        <div v-else class="empty muted">生成大纲后这里显示预览</div>
      </section>

      <ChatPanel
        :messages="messages"
        :running="runningOnCurrent"
        :reasoning="runningOnCurrent ? genState.reasoning : ''"
        :disabled="!current?.html_content"
        placeholder="对当前页的修改指令…（Ctrl/⌘+Enter 发送）"
        @send="onChat"
      />
    </div>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.e-header {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.e-body {
  flex: 1;
  display: grid;
  grid-template-columns: 220px 1fr 360px;
  overflow: hidden;
}
.e-list {
  border-right: 1px solid var(--border);
  overflow: auto;
  padding: 8px;
}
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
}
.item:hover {
  background: #f0f1f3;
}
.item.active {
  background: #e8edff;
}
.num {
  font-weight: 700;
  color: var(--muted);
  width: 18px;
}
.item .t {
  font-size: 13px;
}
.mini {
  font-size: 12px;
  padding: 2px 8px;
  margin-left: auto;
}
.e-preview {
  padding: 20px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty {
  color: var(--muted);
  padding: 40px;
}
</style>
