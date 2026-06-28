# 纸光幻演 (AutoPPT)

基于 Tauri 2 的桌面应用，接入多个 AI 配置（OpenAI 兼容：DeepSeek / OpenAI 等；或 Anthropic 原生：Claude），单选启用其一，自动生成可编辑、可导出的精美 PPT。

输入一个主题，AI 先产出大纲与统一设计系统，再逐页生成 1920×1080 的完整 HTML 幻灯片；你可以在大纲工作台和单页编辑器里用自然语言反复修改，最后导出为 `.pptx`。

## 特性

- **多 AI 配置**：同时配置多个 AI，按 `openai`（兼容）或 `anthropic`（原生）格式接入，单选启用一条；多模态模型还可自动截图自检。
- **两阶段生成**：先生成「大纲 + 设计系统（配色/字体/CSS）」，再逐页生成完整 HTML，保证全册风格统一。
- **12 种内置风格预设**：科技风、商务汇报、中国风水墨、暗夜霓虹等；可指定风格，也可让 AI 自动挑选。
- **大纲工作台**：用自然语言修改大纲（如「把第 3 页拆成两页」「加一页讲应用场景」），AI 返回完整修订后的大纲。
- **逐页对话编辑**：对任意单页下修改指令，流式实时预览修订结果；每页独立会话。
- **调试模式**：在预览里点选任意元素，把它的 HTML 送入对话栏，AI 仅改这一处、返回整页。
- **多模态自检**：启用多模态 AI 时，每页生成后自动截图回看，仅修正溢出/错位/字号过小，并校验不破坏主题配色（否则保留原页）。
- **思考模式**：支持 `thinking` + `reasoning_effort`（high/max），思考过程实时可见（OpenAI 的 `reasoning_content` / Anthropic 的 `thinking_delta`）；思考完成后持久化，可折叠回看。
- **随时取消**：生成/对话进行中可一键中止，不写半截数据。
- **导出 PPTX**：每页截图为高清图片，组装成 16:9 的 PowerPoint 文件。

## 技术栈

- **前端**：Vue 3 + TypeScript + Vite，`vue-router`，`@tauri-apps/plugin-sql`（前端直驱 SQLite）
- **后端**：Rust（`reqwest` + rustls + SSE 流式），按 `format` 分发 OpenAI 兼容接口或 Anthropic 原生接口，支持多模态图片、可中止；仅做浏览器沙箱外的事：代理 LLM、拉取模型列表、写导出文件
- **截图/导出**：`modern-screenshot` + `pptxgenjs`
- **数据**：SQLite（`auto_ppt.db`）

## 环境要求

- [Node.js](https://nodejs.org/)（建议 18+）
- [Rust](https://www.rust-lang.org/)（stable）
- [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)（Windows 需要 WebView2，通常已预装）

## 快速开始

```bash
# 安装依赖
npm install

# 启动完整桌面应用（Rust + Vite，端口 1420）
npm run tauri dev

# 仅启动前端（浏览器预览，无 Tauri 命令，仅可用于调 UI）
npm run dev
```

首次启动后在「设置」页配置并启用一个 AI（可配多条，单选启用一条）：

| 字段 | 说明 | DeepSeek 示例 | Anthropic 示例 |
|---|---|---|---|
| 格式 | 接入协议 | `openai` | `anthropic` |
| API 地址 | 提供商 base，程序按格式自动补路径 | `https://api.deepseek.com` | `https://api.anthropic.com` |
| API Key | 你的密钥 | `sk-...` | `sk-ant-...` |
| 模型 | 可点「获取列表」从对应 `/models` 拉取，或自定义输入 | `deepseek-v4-flash` | `claude-...` |
| 多模态 | 开启后每页生成自动截图自检（需模型支持图片输入） | 视模型 | 视模型 |
| 思考模式 | 开关 + 强度（high/max） | 可选 | 可选 |

> OpenAI 格式自动补 `/chat/completions`、`/models`；Anthropic 格式走 `/v1/messages`、`/v1/models`。OpenAI 官方填 `https://api.openai.com/v1`。首个新建的配置会自动启用。

## 使用流程

1. **启用 AI**：在「设置」页新建并启用一条 AI 配置（至少要有一条处于「启用中」）。
2. **新建项目**：填写主题，可选风格（或「自动」），点「创建并生成大纲」。
3. **大纲工作台**（`/outline/:id`）：AI 自动生成大纲与设计系统；可用对话框修改大纲，满意后「进入编辑器」。
4. **编辑器**（`/editor/:id`）：逐页或一键生成全部 HTML；选中任意页可在右侧对话框里下修改指令，实时预览。开启「调试模式」可点选元素，仅改该部分。多模态 AI 每页生成后会自动自检。
5. **导出**：点「导出 PPT」，选择保存路径即得到 `.pptx`。

> 生成中可在任意页观察实时进度；同一时刻全局只允许一个生成任务，此时新建项目与发送对话会被禁用，可点「取消」中止。

## 打包构建

```bash
npm run tauri build   # 产物在 src-tauri/target/release/bundle/
```

## 项目结构

```
auto-ppt/
├── src/                      # 前端（Vue 3 + TS）
│   ├── pages/
│   │   ├── ProjectList.vue   # 项目列表 / 新建（选风格）
│   │   ├── Settings.vue      # 多 AI 配置 + 模型列表拉取 + 自动自检开关
│   │   ├── Outline.vue       # 大纲工作台
│   │   └── Editor.vue        # 逐页生成 + 对话编辑 + 调试模式
│   ├── components/
│   │   ├── SlidePreview.vue  # iframe 1920×1080 缩放预览（防闪烁 + 调试点选）
│   │   ├── ChatPanel.vue     # 对话面板（大纲/单页共用，思考卡片可折叠）
│   │   └── Icon.vue
│   ├── lib/
│   │   ├── db.ts             # SQLite 查询封装
│   │   ├── aiConfig.ts       # 多 AI 配置（ai_configs 表，真相源）
│   │   ├── settings.ts       # 薄 re-export 兼容旧 import（新代码用 aiConfig.ts）
│   │   ├── genStore.ts       # 生成编排（全局 genState，跨页面存活 + 取消 + 自检）
│   │   ├── prompt.ts         # 提示词 + SLIDE_W/H + JSON 容错解析 + 自检/元素改写
│   │   ├── styles.ts         # 风格预设库
│   │   ├── chat.ts           # 流式对话封装（取消哨兵 CancelledError）
│   │   └── ppt.ts            # 截图 + 导出 pptx（renderSlideToDataUrl 共用）
│   ├── router.ts             # /projects /settings /outline/:id /editor/:id
│   ├── App.vue · main.ts（启动迁移 + 右键/devtools 处理）· styles.css
├── src-tauri/                # Rust 后端
│   ├── src/lib.rs            # chat_stream(openai/anthropic) / cancel_chat / save_file / list_models + 迁移注册
│   ├── migrations/           # 001_init · 002_add_style · 003_add_slide_id · 004_ai_configs · 005_add_reasoning
│   ├── capabilities/default.json
│   └── tauri.conf.json
├── scripts/render-icon.mjs   # 从 SVG 生成 1024 PNG，再 `tauri icon` 出全套图标
└── package.json
```

## 说明

- 幻灯片画布固定 **1920×1080（16:9）**，是提示词、预览缩放、导出截图三处共享的单一真相来源。
- 所有幻灯片样式**全部内联**（不引用外部图片/字体/资源），`tauri.conf.json` 的 CSP 为 `null` 即为此设计。
- 多模态自检仅在启用 AI 标记为「多模态」且「自动自检」开启时触发；自检改写若动了主题配色会被丢弃并保留原页。
- 思考过程在生成/对话成功完成时持久化到 `messages.reasoning`，可在对话面板里折叠展开回看。
- SQLite 数据库位于系统应用数据目录（Windows：`%APPDATA%\com.autoppt.app\auto_ppt.db`），不在仓库内。
- 界面与提示词均为中文。项目未配置测试框架。

> 面向开发者的架构细节与约定见 [`CLAUDE.md`](./CLAUDE.md)。
