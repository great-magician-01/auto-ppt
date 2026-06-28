# 对话/思考/调试 交互优化设计

- 日期：2026-06-29
- 状态：待评审
- 范围：在现有全局 store 流程基础上，新增 7 项交互优化（4 项原有需求 + 3 项新增需求）。
- 依赖与不变量：生成流程由模块单例 `src/lib/genStore.ts`（`genState` reactive）编排，是生成的唯一真相源；`genState.running` 全程 gate、单例。画布 `SLIDE_W=1920 / SLIDE_H=1080`。UI 文案/提示词保持中文。不引新前端依赖，无 Rust 命令变更（仅 migration 注册）。

## 0. 需求总览

| # | 需求 | 性质 | 主要文件 |
|---|------|------|---------|
| 1 | 全局生成锁（生成中禁新建/禁发新对话） | 增强 | ProjectList / ChatPanel / Editor / Outline |
| 2 | 思考区自动滚到底 | 增强 | ChatPanel / Outline |
| 3 | 思考持久化 + 完成后默认收起 | 增强（含 migration） | migration / db / genStore / ChatPanel |
| 4 | 调试模式点选元素失效 | bug | SlidePreview |
| 5 | 「生成全部」自动翻页失效 | bug | Editor |
| 6 | 生成时预览闪烁、黑背景刺眼 | bug | SlidePreview |
| 7 | 发起对话修改时预览立刻空白 | bug | Editor |

## 1. 共享地基 — migration 005：`messages.reasoning`

### 新 migration `src-tauri/migrations/005_add_reasoning_to_messages.sql`

```sql
ALTER TABLE messages ADD COLUMN reasoning TEXT;
```

可空列；旧行 `reasoning` 为 NULL。

### Rust

`lib.rs` `run()` 的 migrations vec 追加 version 5（其余不变）。

### `src/lib/db.ts`

- `Message` 接口加 `reasoning?: string | null;`
- `addMessage(projectId, role, content, slideId?, reasoning?)`：写 `reasoning` 列（`reasoning ?? null`）。保持向后兼容（第 5 参可选）。

## 2. 需求 1 — 全局生成锁（禁用 + 提示）

`genState.running` 是全局单例真相源，两页已 import。当前 ChatPanel 的 `running` prop 是「本页运行」（`runningOnCurrent`），在别页生成时为 false，仍能误发对话。新增全局 `locked` 补此缺口。

### `ChatPanel.vue`

- 新增 prop `locked?: boolean`。
- textarea 与发送按钮在 `running || disabled || locked` 时 `disabled`。
- `locked` 为真时，textarea placeholder 改为「生成中，暂不能发送…」。
- `onSend`：开头加 `if (props.locked) return;` 兜底。

### `Editor.vue`

- 已有 `busy = computed(() => genState.running)`；给 ChatPanel 传 `:locked="busy"`。

### `Outline.vue`

- 给 ChatPanel 传 `:locked="genState.running"`。

### `ProjectList.vue`

- import `genState`；`busy = computed(() => genState.running)`。
- 「新建项目」按钮在 `busy` 时 `disabled`；「创建并生成大纲」按钮在 `busy` 时 `disabled`；`create()` 开头 `if (genState.running) return;` 兜底。
- 生成中在某处显示 muted 提示「生成中，请等待…」（如新建面板内或列表上方一行）。
- 查看/切换已有项目仍允许（可观察实时进度）。

## 3. 需求 2 — 思考区自动滚到底

### `ChatPanel.vue`

- 给实时思考 `<pre class="reasoning">` 加 `reasoningEl` ref（`ref<HTMLElement | null>`）。
- 新增 `watch(() => props.reasoning, async () => { await nextTick(); if (reasoningEl.value) reasoningEl.value.scrollTop = reasoningEl.value.scrollHeight; })`。
- 保留现有 `.chat-list` 的 `scrollBottom` watch（外层列表仍随消息/思考增长滚到底）。

### `Outline.vue`

- 给 `.o-main .stream` 内思考 `<pre>` 加 `reasoningEl` ref。
- 新增 `watch(() => genState.reasoning, async () => { await nextTick(); if (reasoningEl.value) reasoningEl.value.scrollTop = reasoningEl.value.scrollHeight; })`。
- 保留现有 `.chat-list` 滚动。

纯自动滚到底，不做「用户上滑则暂停」的额外复杂度（YAGNI）。

## 4. 需求 3 — 思考持久化 + 完成后默认收起

### 持久化（`genStore.ts`）

仅在**成功完成**时存思考（与现有 `addMessage` 时机一致；取消/出错不存）。每次完成时的 `addMessage` 调用追加第 5 参 `genState.reasoning`：

- `startOutline` 成功：`addMessage(projectId, "assistant", \`已生成大纲（N 页）…\`, null, genState.reasoning)`。
- `sendOutlineChat` 成功：`addMessage(projectId, "assistant", \`已按指令更新大纲（N 页）。\`, null, genState.reasoning)`。
- `startSlide` 成功：`addMessage(projectId, "assistant", \`第 N 页已生成…\`, slide.id, genState.reasoning)`。
- `selfCheckSlide` 成功：`addMessage(projectId, "assistant", \`已自检并改进第 N 页\`, slide.id, genState.reasoning)`；失败保留原页那条消息不附思考（或可附，见下「待定」）。
- `sendChat` 成功：`addMessage(projectId, "assistant", "已按指令更新当前页", cur.id, genState.reasoning)`。

> 自检失败/取消/出错路径：按「成功才存思考」原则不附 reasoning；与现有「取消/出错不写半截数据」约定一致。

### 展示（`ChatPanel.vue`）

两类卡片：

1. **实时思考卡片**（运行中，不变）：`v-if="running && reasoning"`，展开 + 自动滚到底（需求 2）。
2. **持久化思考卡片**（新）：对每条有 `m.reasoning` 的助手消息，在其消息内容下方渲染：
   ```html
   <details v-if="m.role === 'assistant' && m.reasoning" class="msg-reasoning">
     <summary>思考 · {{ m.reasoning.length }} 字</summary>
     <pre>{{ m.reasoning }}</pre>
   </details>
   ```
   - 默认收起（`<details>` 原生行为）——即「思考完后默认收缩」。
   - 点 summary 展开，再点收起。
   - `<pre>` 复用 `.reasoning` 样式（`white-space: pre-wrap; word-break: break-word` 等）。

### 衔接

运行中显示实时卡片（展开）；运行结束 → 实时卡片隐藏（`running=false`）→ `loadMessages` 重载 → 新助手消息带 `reasoning` → 收起的 `<details>` 出现。

## 5. 需求 4 — 调试模式点选元素失效（bug）

### 期望行为

调试模式开 → 点幻灯片元素 → 把选中元素的 fenced HTML 块 `prepend` 进对话输入框（沿用现有设计：`SlidePreview` emit `pick {html, selector}` → `Editor.onPick` → `ChatPanel.prepend`）。

### 根因假设（待 systematic-debugging 实测确认）

`SlidePreview.attachInspector()` 在 `nextTick` 后挂监听，但 iframe `srcdoc` 是异步加载的 → 监听可能挂到一个即将被替换的 document 上，真正加载完的 document 没有监听。原 spec 写的是「iframe `load` 后挂监听」，但现代码缺 `@load` 处理。

### 修复

- iframe 加 `@load="attachInspector"`：srcdoc 载入完成、document 就绪后再挂监听。
- `watch(() => props.html, reloadIframe)` 中 `reloadIframe` 的 `nextTick` + `attachInspector` 保留作为兜底；以 `@load` 为主路径。
- 保留 capture 阶段监听与 `if (!props.inspectMode) return;` 判断。
- 实现 phase 用 systematic-debugging 先验证根因（如确认加载完 document 上确无监听）再定稿。

## 6. 需求 5 — 「生成全部」自动翻页失效（bug）

### 根因

- `startAll`（`genStore.ts`）在每页 `startSlide` **完成后**才 `genState.slideIdx = i+1`。此刻 `startSlide` 的 `finally` 已把 `running=false / phase=idle`。
- `Editor.vue:101-111` 的 watch 条件 `runningHere && phase∈{slide,chat}` → 此刻 `runningHere` 为 false → 不更新 `currentIdx`。
- 下一轮 `startSlide(i+1)` 又把 `slideIdx` 设成同一个值（如 1→1）→ watch 不再触发 → `currentIdx` 卡在上一页。

### 修复（`Editor.vue`）

watch `genState.slideIdx` 的条件由 `runningHere && (phase slide/chat)` 放宽为 `genState.projectId === projectId`：

```js
watch(() => genState.slideIdx, (idx) => {
  if (genState.projectId === projectId) {
    currentIdx.value = Math.min(idx, Math.max(0, slides.value.length - 1));
  }
});
```

安全性论证：手动翻页是直接写 `currentIdx`、不动 `slideIdx`，不会误触；`slideIdx` 只被 genStore 写，写时必属本项目生成。这样跨页间隙（running=false 那一瞬）也能跟上。

## 7. 需求 6 — 生成时预览闪烁、黑背景刺眼（bug）

### 根因

`SlidePreview.vue` `:srcdoc="html"` 直接绑定，`html` 每个 token 变 → srcdoc 每 token 全量重载 iframe → 白→黑反复闪。

### 修复（方案 A：节流 + 匹配底色）

- SlidePreview 内部加 `displayHtml` ref，对 `props.html` 节流（约 150ms，带 trailing 收尾确保最终态正确）；`:srcdoc` 绑 `displayHtml` 而非 `props.html`。重载频率从每 token 降到约 5 次/秒。
- 从流式 html 里 regex 探测 `.slide`/`body` 的 `background` 色，设到 iframe 元素自身 `style.background`——重载间隙显示该色而非白色，黑底不再刺眼。
- 节流实现用简单的「timeout + last value」模式，不引新依赖。
- 兜底：若探测不到底色，回落白色（现状）。

## 8. 需求 7 — 发起对话修改时预览立刻空白（bug）

### 根因

`sendChat` 进入 `phase=chat`、`resetBuffers()` 把 `genState.content=""`。`Editor.vue:51-62` currentHtml 命中 `runningHere && phase=chat` 分支 → 返回 `cleanHtml("")` = `""` → 预览空。直到首个 chunk 才有内容。

### 修复（`Editor.vue`）

currentHtml 在 chat/slide 分支里，`genState.content` 为空时回退 `cur.html_content ?? ""`：

```js
const currentHtml = computed(() => {
  const cur = current.value;
  if (!cur) return "";
  if (runningHere.value && genState.slideIdx === currentIdx.value &&
      (genState.phase === "slide" || genState.phase === "chat")) {
    const live = cleanHtml(genState.content);
    if (live) return live;          // 有流式内容 → 用流式
    return cur.html_content ?? "";   // 首个 chunk 到达前 → 显示原页（chat）/ 空（slide 新页无旧内容）
  }
  return cur.html_content ?? "";
});
```

对 slide 阶段（新页无旧内容）回退仍是空，行为不变；对 chat 阶段，发起后到首个 chunk 前继续显示原页，AI 开始返回后才切到流式内容。

## 9. 文件改动清单

**新增：**
- `src-tauri/migrations/005_add_reasoning_to_messages.sql` — `messages.reasoning` 列。

**修改：**
- `src-tauri/src/lib.rs` — migrations vec 追加 version 5。
- `src/lib/db.ts` — `Message` 加 `reasoning?`；`addMessage` 加第 5 参。
- `src/lib/genStore.ts` — 5 处完成时 `addMessage` 调用追加 `genState.reasoning`。
- `src/components/ChatPanel.vue` — `locked` prop + 禁用态；思考 `<pre>` ref + watch 滚底；持久化思考 `<details>` 默认收起。
- `src/components/SlidePreview.vue` — iframe `@load="attachInspector"`；`displayHtml` 节流 + 匹配底色。
- `src/pages/Editor.vue` — ChatPanel `:locked="busy"`；slideIdx watch 条件放宽；currentHtml content 空时回退。
- `src/pages/Outline.vue` — ChatPanel `:locked="genState.running"`；思考 `<pre>` ref + watch 滚底。
- `src/pages/ProjectList.vue` — import genState；`busy`；新建/创建按钮禁用 + 兜底 + muted 提示。

## 10. 风险与回退

- **migration 005 加列**：`ALTER TABLE ADD COLUMN` 加可空列，旧数据兼容（NULL）。失败时 status 报错、不写库。
- **思考持久化只在成功完成时**：取消/出错不存，与「不写半截数据」一致。自检失败保留原页那条消息不附思考。
- **全局锁禁用而非拦截**：按钮直接 disabled，用户即知不可为；查看/切换已有项目仍允许，可观察进度。
- **自动翻页 watch 放宽**：`slideIdx` 仅由 genStore 在本项目生成时写，手动翻页不写 slideIdx，故不会误触。
- **节流 + 匹配底色（方案 A）**：trailing 收尾保证最终态正确；探测不到底色回落白色。如完全不缓存可改方案 B（就地更新），但 A 风险更低。
- **currentHtml 回退旧页**：仅在 chat 阶段、content 空时生效；slide 阶段新页无旧内容仍空，行为不变。
- **需求 4/5/7 属 bug**：实现 phase 用 systematic-debugging 先复核根因（尤其需求 4 的 srcdoc 异步加载假设）再定稿，避免盲改。

## 11. 不做（YAGNI）

- 思考「用户上滑则暂停自动滚」——纯滚到底即可。
- 思考持久化的独立 `reasonings` 表 / 独立消息行——`messages` 加列已够。
- 全局锁的「锁定当前项目、禁止跳转」严格模式——禁用新建/发送 + 仍可观察已足够。
- 方案 B（就地更新零闪烁）——方案 A 已消除刺眼且更稳。
- 调试点选的「仅替换元素」分支——已选整页方案。
