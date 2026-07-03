<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { listProjects, createProject, getFirstSlide } from "../lib/db";
import { STYLE_PRESETS } from "../lib/styles";
import { genState } from "../lib/genStore";
import { getTavilyKey } from "../lib/tavily";
import type { Project } from "../lib/db";
import Icon from "../components/Icon.vue";
import SlidePreview from "../components/SlidePreview.vue";

const router = useRouter();
const projects = ref<Project[]>([]);
const thumbs = ref<Record<number, string>>({});
const showNew = ref(false);
const title = ref("");
const topic = ref("");
const selectedStyle = ref<string | null>(null);
const tavilyReady = ref(false);
const searchEnabled = ref(true);
// 全局生成锁：genState 单例 running 时禁止新建项目（避免并发破坏单例状态）
const busy = computed(() => genState.running);

onMounted(async () => {
  await load();
  tavilyReady.value = !!(await getTavilyKey());
});

async function load() {
  projects.value = await listProjects();
  thumbs.value = {};
  await Promise.all(
    projects.value.map(async (p) => {
      if (p.id == null) return;
      const first = await getFirstSlide(p.id);
      if (first?.html_content) thumbs.value[p.id] = first.html_content;
    })
  );
}

async function create() {
  if (genState.running) return; // 兜底：生成中不新建
  if (!topic.value.trim()) return;
  const t = title.value.trim() || topic.value.slice(0, 20);
  const id = await createProject(
    t,
    topic.value.trim(),
    selectedStyle.value,
    tavilyReady.value && searchEnabled.value
  );
  router.push(`/outline/${id}`);
}

function open(p: Project) {
  if (p.id == null) return;
  router.push(`/editor/${p.id}`);
}
</script>

<template>
  <div class="page">
    <div class="row" style="justify-content: space-between">
      <h2>项目</h2>
      <button class="primary" :disabled="busy" @click="showNew = !showNew">
        <Icon name="plus" :size="14" />
        {{ showNew ? "取消" : "新建项目" }}
      </button>
    </div>
    <div v-if="busy" class="muted lock-hint">生成中，请等待当前任务完成后再新建项目…</div>

    <div v-if="showNew" class="panel new">
      <div class="col">
        <label>
          主题（必填）
          <textarea
            v-model="topic"
            rows="3"
            placeholder="例如：介绍 Rust 编程语言的核心特性"
          ></textarea>
        </label>
        <label>
          标题（可选）
          <input v-model="title" placeholder="留空则取主题前 20 字" />
        </label>
        <div class="field">
          <span class="label">风格</span>
          <div class="style-chips">
            <button
              class="chip"
              :class="{ active: selectedStyle === null }"
              @click="selectedStyle = null"
            >
              自动（AI 选）
            </button>
            <button
              v-for="s in STYLE_PRESETS"
              :key="s.id"
              class="chip"
              :class="{ active: selectedStyle === s.id }"
              :title="s.desc"
              @click="selectedStyle = s.id"
            >
              {{ s.name }}
            </button>
          </div>
        </div>
        <div v-if="tavilyReady" class="field">
          <label class="toggle">
            <input type="checkbox" v-model="searchEnabled" />
            联网搜索（生成文案时由 AI 自主联网调研）
          </label>
        </div>
        <button class="primary" :disabled="busy || !topic.trim()" @click="create">
          创建并生成大纲
        </button>
      </div>
    </div>

    <div v-if="!showNew && !projects.length" class="empty muted">
      还没有项目，点击右上角新建。
    </div>
    <div v-else-if="!showNew" class="grid">
      <div v-for="p in projects" :key="p.id" class="card" @click="open(p)">
        <div class="card-thumb">
          <SlidePreview v-if="p.id != null && thumbs[p.id]" :html="thumbs[p.id]" />
          <div v-else class="thumb-empty muted">无预览</div>
        </div>
        <div class="card-title">{{ p.title }}</div>
        <div class="card-topic muted">{{ p.topic }}</div>
        <div class="card-time muted">{{ p.updated_at }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 24px;
}
.lock-hint {
  margin: 8px 0 0;
  font-size: 13px;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin: 16px 0;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-weight: 600;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
  margin-top: 16px;
}
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  cursor: pointer;
  transition: all 0.15s;
}
.card:hover {
  border-color: var(--primary);
}
.card-title {
  font-weight: 600;
}
.card-topic {
  margin-top: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-time {
  margin-top: 8px;
  font-size: 11px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-weight: 600;
}
.field .label {
  font-weight: 600;
}
.style-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  font-size: 13px;
  padding: 4px 10px;
  white-space: nowrap;
}
.chip.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.card-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  margin-bottom: 8px;
  border-radius: 6px;
  overflow: hidden;
  background: #f7f8fa;
}
.thumb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.card-thumb :deep(.preview-wrap) {
  border: none;
  border-radius: 6px;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.toggle input {
  margin: 0;
}
</style>
