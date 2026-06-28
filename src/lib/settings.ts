// 设置访问已迁移至 aiConfig.ts（多 AI 配置）。
// 本文件仅保留极薄 re-export，避免历史 import 断裂；新代码请直接用 aiConfig.ts。
export {
  getSetting,
  setSetting,
  type AiConfig,
  type AiFormat,
} from "./aiConfig";
