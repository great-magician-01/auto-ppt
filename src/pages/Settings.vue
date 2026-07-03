<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  listAiConfigs,
  saveAiConfig,
  deleteAiConfig,
  setActiveAi,
  getModelsCache,
  saveModelsCache,
  getSetting,
  setSetting,
  type AiConfig,
} from "../lib/aiConfig";
import {
  getTavilyKey,
  setTavilyKey,
  tavilySearch,
  getTavilyUsage,
  resetTavilyUsage,
  recordTavilySearch,
  type TavilyUsage,
} from "../lib/tavily";
import Icon from "../components/Icon.vue";

const CUSTOM = "__custom__";
const configs = ref<AiConfig[]>([]);
const editing = ref<AiConfig | null>(null);
const models = ref<string[]>([]);
const modelChoice = ref<string>("");
const showKey = ref(false);
const loadingModels = ref(false);
const saved = ref(false);

// app 级开关：自动自检（多模态发图、非多模态仅发 HTML）
const autoSelfcheck = ref(true);

function emptyConfig(): AiConfig {
  return {
    name: "",
    api_base: "",
    api_key: "",
    model: "",
    format: "openai",
    multimodal: false,
    thinking_mode: false,
    thinking_effort: "high",
    enabled: false,
    models_cache: [],
  };
}

function syncChoice() {
  if (modelChoice.value === CUSTOM) return;
  modelChoice.value = editing.value?.model ? editing.value.model : CUSTOM;
}
watch(() => editing.value?.model, syncChoice);
watch(models, syncChoice);
watch(
  () => editing.value?.api_base,
  (v, old) => {
    if (editing.value && old && v !== old) {
      models.value = [];
      editing.value.models_cache = [];
    }
  }
);
watch(
  () => editing.value?.format,
  (v, old) => {
    if (editing.value && old && v !== old) {
      models.value = [];
      editing.value.models_cache = [];
    }
  }
);

onMounted(async () => {
  await load();
  autoSelfcheck.value = (await getSetting("auto_selfcheck")) !== "false";
  await loadTavily();
});

async function load() {
  configs.value = await listAiConfigs();
  if (!editing.value) editing.value = configs.value[0] ?? null;
  if (editing.value?.id) {
    models.value = await getModelsCache(editing.value.id);
  }
  syncChoice();
}

function selectConfig(c: AiConfig) {
  editing.value = { ...c };
  models.value = c.models_cache ?? [];
  syncChoice();
}

function newConfig() {
  editing.value = emptyConfig();
  models.value = [];
  modelChoice.value = CUSTOM;
}

async function fetchModels() {
  if (!editing.value) return;
  if (!editing.value.api_base || !editing.value.api_key) {
    alert("请先填写 API 地址和 Key");
    return;
  }
  loadingModels.value = true;
  try {
    const ids = await invoke<string[]>("list_models", {
      config: {
        api_base: editing.value.api_base,
        api_key: editing.value.api_key,
        format: editing.value.format,
      },
    });
    models.value = ids;
    editing.value.models_cache = ids;
    if (!ids.length) alert("未返回任何模型，可改用自定义输入");
  } catch (e: any) {
    alert("获取模型列表失败：" + e);
    models.value = [];
  } finally {
    loadingModels.value = false;
  }
}

function onChoice(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  modelChoice.value = v;
  if (editing.value && v !== CUSTOM) editing.value.model = v;
}

async function save() {
  if (!editing.value) return;
  if (!editing.value.name.trim()) editing.value.name = editing.value.model || "未命名 AI";
  const wasNew = !editing.value.id;
  const id = await saveAiConfig(editing.value);
  editing.value.id = id;
  if (editing.value.models_cache) await saveModelsCache(id, editing.value.models_cache);
  // 新建的第一个配置自动启用
  if (wasNew && configs.value.length === 0) {
    await setActiveAi(id);
    editing.value.enabled = true;
  }
  configs.value = await listAiConfigs();
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}

async function enable(c: AiConfig) {
  if (!c.id) return;
  await setActiveAi(c.id);
  configs.value = await listAiConfigs();
}

async function remove(c: AiConfig) {
  if (!c.id) return;
  if (!confirm(`删除配置「${c.name}」？`)) return;
  await deleteAiConfig(c.id);
  configs.value = await listAiConfigs();
  editing.value = configs.value[0] ?? null;
}

async function toggleAutoSelfcheck(v: boolean) {
  autoSelfcheck.value = v;
  await setSetting("auto_selfcheck", v ? "true" : "false");
}

// Tavily 联网搜索
const tavilyKey = ref("");
const testing = ref(false);
const tavilyUsage = ref<TavilyUsage>({ searchCalls: 0, extractCalls: 0, extractUrls: 0, credits: 0 });

async function loadTavily() {
  tavilyKey.value = (await getTavilyKey()) ?? "";
  tavilyUsage.value = await getTavilyUsage();
}

async function saveTavilyKey() {
  await setTavilyKey(tavilyKey.value.trim());
  await loadTavily();
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}

async function testTavily() {
  const key = tavilyKey.value.trim();
  if (!key) {
    alert("请先填写并保存 Tavily API Key");
    return;
  }
  await setTavilyKey(key);
  testing.value = true;
  try {
    const r = await tavilySearch(key, "test query");
    await recordTavilySearch(r.credits);
    await loadTavily();
    alert(`测试成功：返回 ${r.results.length} 条结果，消耗 ${r.credits} 积分`);
  } catch (e: any) {
    alert("测试失败：" + e);
  } finally {
    testing.value = false;
  }
}

async function clearUsage() {
  if (!confirm("清零 Tavily 用量统计？")) return;
  await resetTavilyUsage();
  await loadTavily();
}
</script>

<template>
  <div class="page">
    <h2>AI 配置</h2>
    <p class="muted">
      支持配置多个 AI 并单选启用。OpenAI 格式自动补 <code>/chat/completions</code>，Anthropic 格式走 <code>/v1/messages</code>。
    </p>

    <div class="list">
      <div
        v-for="c in configs"
        :key="c.id"
        class="cfg-row"
        :class="{ active: editing?.id === c.id }"
        @click="selectConfig(c)"
      >
        <div class="cfg-info">
          <span class="cfg-name">{{ c.name }}</span>
          <span class="badge" :class="c.format">{{ c.format }}</span>
          <span v-if="c.multimodal" class="badge mm">多模态</span>
          <span v-if="c.enabled" class="badge on">启用中</span>
        </div>
        <div class="cfg-actions" @click.stop>
          <button class="ghost" :class="{ primary: c.enabled }" @click="enable(c)">
            {{ c.enabled ? "已启用" : "启用" }}
          </button>
          <button class="ghost" @click="remove(c)">删除</button>
        </div>
      </div>
      <button class="ghost" @click="newConfig">+ 新建 AI 配置</button>
    </div>

    <div v-if="editing" class="col form">
      <label>
        名称
        <input v-model="editing.name" placeholder="如：DeepSeek / Claude" />
      </label>

      <div class="field">
        <span class="label">格式</span>
        <select v-model="editing.format">
          <option value="openai">openai（兼容）</option>
          <option value="anthropic">anthropic</option>
        </select>
        <span class="muted">旧配置默认 openai</span>
      </div>

      <label>
        API 地址 (api_base)
        <input v-model="editing.api_base" placeholder="https://api.deepseek.com" />
      </label>
      <label>
        API Key
        <div class="key-row">
          <input v-model="editing.api_key" :type="showKey ? 'text' : 'password'" placeholder="sk-..." />
          <button class="ghost icon-btn" type="button" @click="showKey = !showKey">
            <Icon :name="showKey ? 'eye-off' : 'eye'" :size="16" />
          </button>
        </div>
      </label>

      <div class="field">
        <span class="label">模型</span>
        <div class="model-row">
          <select :value="modelChoice" @change="onChoice">
            <option :value="CUSTOM">自定义输入</option>
            <option v-if="editing.model && !models.includes(editing.model)" :value="editing.model">
              {{ editing.model }}（已保存）
            </option>
            <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
          </select>
          <button class="ghost" @click="fetchModels" :disabled="loadingModels || !editing.api_base">
            {{ loadingModels ? "获取中…" : "获取列表" }}
          </button>
        </div>
      </div>
      <label v-if="modelChoice === CUSTOM" class="custom-model">
        <span class="lab"><Icon name="pencil" :size="14" /> 自定义模型 (model)</span>
        <input v-model="editing.model" placeholder="deepseek-v4-flash" />
      </label>

      <div class="field">
        <span class="label">多模态</span>
        <select v-model="editing.multimodal">
          <option :value="false">否</option>
          <option :value="true">是</option>
        </select>
        <span class="muted">自检时附当前页截图（需模型支持图片输入）；关闭则仅发 HTML 自检</span>
      </div>

      <div class="field">
        <span class="label">思考模式</span>
        <select v-model="editing.thinking_mode">
          <option :value="false">关</option>
          <option :value="true">开</option>
        </select>
      </div>
      <div class="field">
        <span class="label">思考强度</span>
        <select v-model="editing.thinking_effort" :disabled="!editing.thinking_mode">
          <option value="high">high</option>
          <option value="max">max</option>
        </select>
      </div>

      <div class="field">
        <span class="label">自动自检</span>
        <select
          :value="autoSelfcheck ? 'true' : 'false'"
          @change="toggleAutoSelfcheck(($event.target as HTMLSelectElement).value === 'true')"
        >
          <option value="true">开</option>
          <option value="false">关</option>
        </select>
        <span class="muted">每页生成后自动自检（多模态附截图、非多模态仅发 HTML）；关闭以节省调用</span>
      </div>

      <div class="row">
        <button class="primary" @click="save">保存</button>
        <span v-if="saved" class="muted">已保存</span>
      </div>
    </div>

    <h3 style="margin-top: 24px">联网搜索 (Tavily)</h3>
    <p class="muted">配置 Tavily API Key 后，新建项目时可选「联网搜索」，生成文案时由 AI 自主多轮联网调研。</p>
    <label>
      Tavily API Key
      <div class="key-row">
        <input v-model="tavilyKey" :type="showKey ? 'text' : 'password'" placeholder="tvly-..." />
        <button class="ghost icon-btn" type="button" @click="showKey = !showKey">
          <Icon :name="showKey ? 'eye-off' : 'eye'" :size="16" />
        </button>
      </div>
    </label>
    <div class="row">
      <button class="primary" @click="saveTavilyKey">保存 Key</button>
      <button class="ghost" :disabled="testing || !tavilyKey.trim()" @click="testTavily">
        {{ testing ? "测试中…" : "测试连接" }}
      </button>
      <span v-if="saved" class="muted">已保存</span>
    </div>
    <div class="field">
      <span class="label">用量</span>
      <div class="muted">
        搜索 {{ tavilyUsage.searchCalls }} 次 · 提取 {{ tavilyUsage.extractCalls }} 次（{{ tavilyUsage.extractUrls }} URL）· 已用 {{ tavilyUsage.credits }} 积分
        <button class="ghost" style="margin-left: 8px" @click="clearUsage">清零</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 24px;
  max-width: 640px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px 0;
}
.cfg-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  gap: 8px;
}
.cfg-row.active {
  border-color: var(--primary);
  background: #eef;
}
.cfg-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.cfg-name {
  font-weight: 600;
}
.badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #eee;
}
.badge.anthropic {
  background: #f3e8ff;
  color: #7c3aed;
}
.badge.mm {
  background: #dcfce7;
  color: #15803d;
}
.badge.on {
  background: var(--primary);
  color: #fff;
}
.cfg-actions {
  display: flex;
  gap: 6px;
}
.form {
  gap: 16px;
  margin-top: 16px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-weight: 600;
}
.custom-model .lab {
  display: flex;
  align-items: center;
  gap: 5px;
}
.field {
  display: grid;
  grid-template-columns: 90px 1fr;
  align-items: center;
  gap: 10px;
}
.field .muted {
  grid-column: 2;
  font-weight: 400;
}
.field .label {
  font-weight: 600;
}
.field select {
  width: 100%;
}
.model-row {
  display: flex;
  gap: 8px;
}
.model-row select {
  flex: 1;
}
button.ghost {
  padding: 6px 12px;
  white-space: nowrap;
}
code {
  background: #eee;
  padding: 1px 5px;
  border-radius: 4px;
}
.key-row {
  display: flex;
  gap: 8px;
}
.key-row input {
  flex: 1;
}
.icon-btn {
  padding: 6px 10px;
  display: flex;
  align-items: center;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
