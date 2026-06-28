import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import "./styles.css";
import { ensureLegacyImport } from "./lib/aiConfig";

async function bootstrap() {
  // 旧数据兼容：表空且 settings 有旧配置时导入一条 openai/enabled
  await ensureLegacyImport();

  // 右键菜单：始终禁用（dev 仍可用 F12）
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  // devtools：仅生产构建拦截快捷键；dev 构建不拦截，保证开发期可用
  if (import.meta.env.PROD) {
    window.addEventListener("keydown", (e) => {
      const k = (e.key ?? "").toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      // F12 / Ctrl+Shift+I,J,C / Cmd+Opt+I
      if (k === "f12") {
        e.preventDefault();
      } else if (ctrl && shift && ["i", "j", "c"].includes(k)) {
        e.preventDefault();
      }
    });
  }

  createApp(App).use(router).mount("#app");
}

bootstrap();
