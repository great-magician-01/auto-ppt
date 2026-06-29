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
import { genState, startSlide, startAll, sendChat, cancelGeneration } from "../lib/genStore";
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
const inspectMode = ref(false);
const chatPanelRef = ref<{ prepend: (t: string) => void } | null>(null);
// 是否正在生成/修改当前页（思考流卡片只在此页显示）
const runningOnCurrent = computed(
  () =>
    runningHere.value &&
    genState.slideIdx === currentIdx.value &&
    (genState.phase === "slide" || genState.phase === "chat")
);
// 正在生成的页索引（slide/selfcheck 阶段）：在页列表显眼标记该页
const generatingIdx = computed(() => {
  if (
    genState.running &&
    genState.projectId === projectId &&
    (genState.phase === "slide" || genState.phase === "selfcheck")
  ) {
    return genState.slideIdx;
  }
  return -1;
});
// 生成中标记文案：自检阶段显示「自检中」
const genBadge = computed(() =>
  genState.phase === "selfcheck" ? "自检中…" : "生成中…"
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
    // 流式内容非空才用实时流；首个 chunk 到达前回退原页，
    // 避免发起对话修改瞬间预览变空白（slide 新页无旧内容则仍空，行为不变）
    const live = cleanHtml(genState.content);
    if (live) return live;
    return cur.html_content ?? "";
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
// 条件放宽为「本项目的生成」即可——startAll 在每页完成时推进 slideIdx，此刻 running
// 已被 startSlide 的 finally 置 false，若仍按 running/phase 闸会漏掉跨页间隙导致卡页。
// 手动翻页只写 currentIdx 不动 slideIdx，故不会误触。
watch(
  () => genState.slideIdx,
  (idx) => {
    if (genState.projectId === projectId) {
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
  // 解析调试模式选中的元素块（若存在）
  let element: { html: string; selector: string } | undefined;
  const m = text.match(/【选中元素】\n```html\n([\s\S]*?)```\n定位：(.+)/);
  if (m) {
    element = { html: m[1].trim(), selector: m[2].trim() };
  }
  await sendChat(projectId, slides.value, currentIdx.value, text, element);
  slides.value = await listSlides(projectId);
  await loadMessages();
}

function onPick(payload: { html: string; selector: string }) {
  const text = `【选中元素】\n\`\`\`html\n${payload.html}\n\`\`\`\n定位：${payload.selector}`;
  chatPanelRef.value?.prepend(text);
}

async function cancelRun() {
  await cancelGeneration();
}

async function doExport() {
  await exportPptx(slides.value, projectId, project.value?.title);
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
          <button v-if="busy" class="danger" @click="cancelRun">取消</button>
          <button v-else @click="genAll">生成全部 HTML</button>
          <button class="primary" :disabled="busy" @click="doExport">导出 PPT</button>
          <label class="toggle" :class="{ on: inspectMode }">
            <input type="checkbox" v-model="inspectMode" />
            调试模式
          </label>
        </template>
      </div>
    </div>

    <div class="e-body">
      <aside class="e-list">
        <div
          v-for="(s, i) in slides"
          :key="s.id"
          class="item"
          :class="{ active: i === currentIdx, generating: i === generatingIdx }"
          @click="currentIdx = i"
        >
          <span class="num">{{ i + 1 }}</span>
          <div class="col">
            <span class="t">{{ s.title || "(未命名)" }}</span>
            <span class="muted" :class="{ 'is-gen': i === generatingIdx }">
              <span v-if="i === generatingIdx" class="pulse" aria-hidden="true"></span>
              {{ i === generatingIdx ? genBadge : s.html_content ? "已生成" : "待生成" }}
            </span>
          </div>
          <button
            v-if="!s.html_content && i !== generatingIdx"
            class="mini"
            :disabled="busy"
            @click.stop="genOne(i)"
          >
            生成
          </button>
        </div>
      </aside>

      <section class="e-preview">
        <SlidePreview
          v-if="current"
          :html="currentHtml"
          :inspect-mode="inspectMode"
          @pick="onPick"
        />
        <div v-else class="empty muted">生成大纲后这里显示预览</div>
      </section>

      <ChatPanel
        ref="chatPanelRef"
        :messages="messages"
        :running="runningOnCurrent"
        :reasoning="runningOnCurrent ? genState.reasoning : ''"
        :locked="busy"
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
/* 正在生成的页：琥珀色高亮 + 左侧色条，与蓝色选中态区分，显眼可辨 */
.item.generating {
  background: #fff4e6;
  box-shadow: inset 3px 0 0 #f59f00;
}
.item.generating:hover {
  background: #ffeacc;
}
.muted.is-gen {
  color: #d9480f;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f59f00;
  flex: 0 0 auto;
  animation: gen-pulse 1s ease-in-out infinite;
}
@keyframes gen-pulse {
  0%,
  100% {
    opacity: 0.4;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
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
.danger {
  background: #e03131;
  color: #fff;
  border-color: #e03131;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.toggle input {
  margin: 0;
}
.toggle.on {
  border-color: var(--primary);
  color: var(--primary);
}
</style>
