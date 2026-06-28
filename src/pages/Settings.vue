<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  getSettings,
  saveSettings,
  getModelsCache,
  saveModelsCache,
  type ApiSettings,
} from "../lib/settings";
import Icon from "../components/Icon.vue";

const CUSTOM = "__custom__";
const form = ref<ApiSettings>({
  api_base: "",
  api_key: "",
  model: "",
  thinking_mode: false,
  thinking_effort: "high",
});
const models = ref<string[]>([]);
const modelChoice = ref<string>("");
const showKey = ref(false);
const loadingModels = ref(false);
const saved = ref(false);

function syncChoice() {
  // 用户正在「自定义输入」时不打断；否则跟随已保存模型
  // （不在列表时由下拉兜底 option 显示）
  if (modelChoice.value === CUSTOM) return;
  modelChoice.value = form.value.model ? form.value.model : CUSTOM;
}
watch(() => form.value.model, syncChoice);
watch(models, syncChoice);
watch(
  () => form.value.api_base,
  (v, old) => {
    if (old && v !== old) {
      models.value = [];
      saveModelsCache([]);
    }
  }
);

onMounted(async () => {
  form.value = await getSettings();
  models.value = await getModelsCache();
  syncChoice();
});

async function fetchModels() {
  if (!form.value.api_base || !form.value.api_key) {
    alert("请先填写 API 地址和 Key");
    return;
  }
  loadingModels.value = true;
  try {
    const ids = await invoke<string[]>("list_models", {
      config: { api_base: form.value.api_base, api_key: form.value.api_key },
    });
    models.value = ids;
    await saveModelsCache(ids);
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
  if (v !== CUSTOM) form.value.model = v;
}

async function save() {
  await saveSettings(form.value);
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}
</script>

<template>
  <div class="page">
    <h2>API 设置</h2>
    <p class="muted">
      OpenAI 兼容格式。程序自动在 API 地址后补 <code>/chat/completions</code>。<br />
      DeepSeek 填 <code>https://api.deepseek.com</code>；OpenAI 官方填
      <code>https://api.openai.com/v1</code>。
    </p>
    <div class="col form">
      <label>
        API 地址 (api_base)
        <input v-model="form.api_base" placeholder="https://api.deepseek.com" />
      </label>
      <label>
        API Key
        <div class="key-row">
          <input
            v-model="form.api_key"
            :type="showKey ? 'text' : 'password'"
            placeholder="sk-..."
          />
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
            <option
              v-if="form.model && !models.includes(form.model)"
              :value="form.model"
            >
              {{ form.model }}（已保存）
            </option>
            <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
          </select>
          <button
            class="ghost"
            @click="fetchModels"
            :disabled="loadingModels || !form.api_base"
          >
            {{ loadingModels ? "获取中…" : "获取列表" }}
          </button>
        </div>
        <span class="muted">填好地址和 Key 后点「获取列表」拉取下拉</span>
      </div>
      <label v-if="modelChoice === CUSTOM" class="custom-model">
        <span class="lab">
          <Icon name="pencil" :size="14" /> 自定义模型 (model)
        </span>
        <input v-model="form.model" placeholder="deepseek-v4-flash" />
      </label>

      <div class="field">
        <span class="label">思考模式</span>
        <select v-model="form.thinking_mode">
          <option :value="false">关</option>
          <option :value="true">开</option>
        </select>
        <span class="muted">开启后发送 thinking(enabled) 与 reasoning_effort</span>
      </div>
      <div class="field">
        <span class="label">思考强度</span>
        <select v-model="form.thinking_effort" :disabled="!form.thinking_mode">
          <option value="high">high</option>
          <option value="max">max</option>
        </select>
        <span class="muted">仅在思考模式开启时发送</span>
      </div>

      <div class="row">
        <button class="primary" @click="save">保存</button>
        <span v-if="saved" class="muted">已保存</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 24px;
  max-width: 640px;
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
</style>
