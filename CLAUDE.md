# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

纸光幻演 (AutoPPT) — a Tauri 2 desktop app that generates PowerPoint decks from an LLM. It supports **multiple AI configurations**, each either OpenAI-compatible (DeepSeek, OpenAI, …) or Anthropic-native (Claude), with exactly one enabled at a time. Vue 3 + TypeScript (Vite) frontend, Rust backend. The app UI and all LLM prompts are in Chinese; keep user-facing strings/prompts in Chinese when editing.

Generation is **manuscript-first**: the model writes a full markdown speech script for the topic (optionally researching the web via Tavily tool-calls), then a separate JSON pass splits that manuscript into a slide outline + design system, then per-page HTML is generated. The manuscript is persisted and reused.

## Commands

```bash
npm run dev          # Vite dev server only (port 1420, strictPort — fails if taken)
npm run build        # vue-tsc --noEmit (typecheck) then vite build → dist/
npm run tauri dev    # full app: Rust + Vite (uses beforeDevCommand: npm run dev)
npm run tauri build  # production bundle (uses beforeBuildCommand: npm run build)
npm run render:icon  # render icon-source.svg → 1024 PNG, then `tauri icon` regenerates the full icon set
```

The Tauri CLI (`@tauri-apps/cli`) is a devDependency, so `npm run tauri …` works without a global install. `vite.config.ts` ignores `src-tauri/**` from watch and pins port 1420 (Tauri expects it). There is no test framework configured — no test script, no test dependencies.

Version is kept in sync across `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (currently `0.1.7`); bump all three together. `tauri-action` in CI reads the version from `tauri.conf.json`.

## Architecture

Standard Tauri two-process split, but the responsibilities are asymmetric and worth knowing:

**Frontend (`src/`) owns the product logic.** Vue 3 `<script setup>` SFCs, `vue-router` (routes: `/`, `/projects`, `/settings`, `/outline/:id`, `/editor/:id`, all lazy). The DB is *also* driven from the frontend via `@tauri-apps/plugin-sql` (SQLite file `auto_ppt.db`), with typed query helpers in `src/lib/db.ts`. Schema lives in `src-tauri/migrations/` and is applied by the Rust side at startup (`lib.rs` → `tauri_plugin_sql::Migration`): `001_init.sql` (projects/slides/messages/settings/exports), `002_add_style.sql` (`projects.style`), `003_add_slide_id_to_messages.sql` (`messages.slide_id` for per-page chat), `004_ai_configs.sql` (the `ai_configs` multi-AI table), `005_add_reasoning_to_messages.sql` (`messages.reasoning` for persisted thinking), `006_add_manuscript_and_search.sql` (`projects.manuscript` + `projects.search_enabled`).

**Backend (`src-tauri/src/lib.rs`) does only what the browser sandbox can't:** proxy the LLM API with SSE streaming (`chat_stream`, dispatching OpenAI *or* Anthropic format, including tool-call accumulation), abort an in-flight stream (`cancel_chat`), fetch the model list (`list_models`, also format-aware), call Tavily search/extract (`tavily_search`, `tavily_extract` — direct `reqwest` to `api.tavily.com`, not proxied through the LLM), and write exported files outside the fs scope (`save_file`). `main.rs` is a thin bin that just calls `tauri_app_lib::run()`; all real Rust code is in `lib.rs`. (The `[lib]` name `tauri_app_lib` + `staticlib/cdylib/rlib` crate-types is the standard Tauri 2 mobile-ready split — don't "fix" the apparent redundancy.) Frontend `src/main.ts` `bootstrap()` runs `ensureLegacyImport()` once at startup (see Multi-AI), always disables the context menu, and in production blocks devtools shortcuts (F12 / Ctrl+Shift+I/J/C).

### The generation pipeline (orchestrated by a global store)

Generation is **not** owned by any single component — it lives in `src/lib/genStore.ts`, which exports a module-level reactive `genState` (the single source of truth: `running`, `phase`, `projectId`, `slideIdx`, `reasoning`, `content`, `status`, `error`, `cancelled`). Because it is module-level, a generation run **survives component unmount/remount** — you can navigate away mid-stream and come back to live progress. Both `Outline.vue` and `Editor.vue` merely *read* `genState` (live preview from `genState.content`) and *watch* `genState.running` to reload the final DB state when a background run finishes. Prompts live in `src/lib/prompt.ts`. Phases: `idle | manuscript | outline | outline-chat | slide | chat | selfcheck`.

The flow spans two pages — ProjectList creates a project → `/outline/:id` → `/editor/:id`:

1. **Manuscript** (`Outline.vue` → `startOutline()`, phase `manuscript`) — writes the full markdown speech script for the topic *before* any slide structure exists. Two paths:
   - **With search** (`searchEnabled` true *and* a Tavily key configured): `chatAgent(...)` runs a multi-round agent loop with `tavilyTools` (`tavily_search` / `tavily_extract`). The model researches, each tool call is executed via `execTavilyTool` (results回填 as `role:"tool"` messages), and the loop continues until the model returns a final tool-free message = the manuscript. Tool usage/credits are audited into `genState.reasoning` and `settings.tavily_usage`.
   - **Without search** (or fallback if the model rejects tools): plain `chat()` streams the manuscript directly.
   The manuscript is persisted to `projects.manuscript` and a completion message (with reasoning) is added. **Reuse:** if `projects.manuscript` already exists on re-run (e.g. a prior split was cancelled/failed but the manuscript survived), the manuscript phase is skipped entirely and the existing text is split again. If the model ends with only tool calls and no text → the run throws ("文案生成失败：模型未产出任何文案内容") rather than producing an empty manuscript. `manuscriptPrompt` is **not** jsonMode.
2. **Outline split + design system** (still inside `startOutline()`, phase flips to `outline`) — `chatOnce(..., jsonMode=true)` with `splitOutlinePrompt(topic, manuscript, style)` → `{design_tokens, theme_css, slides[], style?}`. `parseOutline` tolerantly extracts the JSON (fence-stripping + brace-balancing) and **retries once** on parse failure. Stored on `projects` (design_tokens/theme_css/style) + one `slides` row per outline item (`html_content=null`); existing slides are deleted then re-inserted (覆盖写). `Outline.vue` auto-starts `startOutline` on mount when no slides exist yet, passing `!!project.search_enabled`. On success, the thinking is persisted. This is the **only** jsonMode call.
3. **Outline chat** (`Outline.vue` → `sendOutlineChat()`, phase `outline-chat`) — natural-language outline edits. **Not** jsonMode; the system prompt constrains the model to return the same JSON structure, and instructs it to keep each slide's `notes` aligned with the修改. The full manuscript is passed for reference ("确保覆盖文案要点"). `parseOutline` runs on the streamed content and **only writes to DB on parse success** (a failed parse leaves the existing outline untouched). Persists reasoning on success.
4. **Per-slide HTML** (`Editor.vue` → `startSlide()` / `startAll()`, phase `slide`) — builds `slideHtmlPrompt`: inlines the shared `theme_css` verbatim into a standalone HTML doc whose `.slide` canvas is fixed at **1920×1080**. Not JSON mode. `cleanHtml` strips code fences. During the stream, `slide.html_content` is updated live from `cleanHtml(genState.content)` so the preview follows token-by-token; on completion it is persisted (`upsertSlide`) and a completion message with reasoning is added. Then **`maybeSelfCheck`** may run (see Self-check). `startAll` loops per slide, skipping already-generated ones and advancing `genState.slideIdx`; the editor auto-follows via a `watch(genState.slideIdx)` gated on `genState.projectId === projectId` (not on `running`), so it tracks page advances across the `running=false` gap between pages.
5. **Per-slide chat editing** (`Editor.vue` → `sendChat()`, phase `chat`) — sends the current page's HTML + a modification instruction; the model returns a full revised HTML doc, streamed live into the preview. Messages are scoped to the slide via `messages.slide_id`. **Debug mode**: when the user picks an element, `sendChat` receives an `element {html, selector}` and switches the prompt to `chatWithElementPrompt` (edit scoped to that element; full-page HTML still returned). Persists reasoning on success.
6. **Export** — `exportPptx` (`src/lib/ppt.ts`) renders each slide's HTML in an **isolated hidden `<iframe>`** at 1920×1080 via `renderSlideToDataUrl` (not a plain div — the iframe isolates the slide's `<style>`, which can contain `:root`/`body/*` global rules that would otherwise pollute the app document during the screenshot), screenshots it with `modern-screenshot` (`domToPng` → PNG dataURL), assembles a `.pptx` via `pptxgenjs` (one full-bleed image per slide, `LAYOUT_WIDE`), then writes bytes through the Rust `save_file` command after a native save dialog. `renderSlideToDataUrl` is shared by export and the self-check screenshot. (See memory: `domToPng` clones `.slide` and loses `:root` CSS-var backgrounds — `ppt.ts` resolves them to solid colors in-place before screenshotting to prevent dark slides exporting white.)

### Web research (Tavily) & the agent loop

- **Tavily key** lives in the `settings` key-value table (`settings.tavily_api_key`), read/written via `getTavilyKey`/`setTavilyKey` (`src/lib/tavily.ts`, which re-uses `getSetting`/`setSetting` from `aiConfig.ts`). Configured on the Settings page. **Usage** is tracked in `settings.tavily_usage` (JSON: `searchCalls`/`extractCalls`/`extractUrls`/`credits`), updated by `recordTavilySearch`/`recordTavilyExtract` after each call.
- **Rust commands** (`tavily_search`, `tavily_extract`) call `https://api.tavily.com/search` and `/extract` directly with `Bearer <key>`, `basic` depth. Search returns an LLM-generated `answer` + up to 5 results (each `content` truncated to 1500 chars); extract takes ≤3 URLs/call (enforced in `tavily.ts`), returns markdown `raw_content` per URL (truncated to 4000 chars). Both report `credits` from Tavily's `usage` field. These are **plain `reqwest` calls, not streamed** — they are invoked from `execTavilyTool` inside the agent loop, never directly by the UI.
- **`chatAgent`** (`src/lib/chat.ts`) is the multi-round agent loop, used today only by the manuscript phase. Each round: `chat()` with `tools` → if the model emits `tool_calls`, execute each via `execTool`, push the assistant message (carrying its `tool_calls`) + `role:"tool"` result messages, loop; the first round with no tool calls is the final reply. **Limits** (default `maxLlmRounds=50`, `maxToolCalls=20`): only calls within the remaining tool quota are executed; the assistant message回填 only the executed calls (every `tool_call_id` *must* have a matching tool result or the API returns 400). On hitting the tool cap, a `system` message forcing "stop calling tools, produce the final manuscript" is appended and the loop breaks to a final tool-free request — it does *not* keep passing `tools` (the model could otherwise ignore the instruction and emit more `tool_calls`,空转 to `maxLlmRounds`). Hitting `maxLlmRounds` does one final tool-free request. `onRoundStart` lets the caller clear `genState.content` each round so intermediate text doesn't pollute the final manuscript UI.
- **Cancellation in the loop**: `chatAgent` takes an `isCancelled: () => boolean` callback (genStore passes `() => genState.cancelled`), checked before each round, before each tool execution, and after tools complete — so a cancel interrupts the loop between rounds instead of burning more LLM/tool quota. (Tool HTTP calls themselves can't be aborted mid-flight.)

### Style system

`src/lib/styles.ts` defines `STYLE_PRESETS` (12 built-in metadata-only presets: palette/font/density hints, no full CSS). The outline-split prompt has two modes decided by `stylesForPrompt(style)`:
- **explicit** — `projects.style` is set and matches a preset → inject only that preset's hints.
- **auto** — `style` is null → inject *all* presets and ask the model to pick one; the chosen `style` id is written back to `projects.style`. `startOutline`/`sendOutlineChat` resolve `resolvedStyle = parsed.style ?? style ?? null` and persist it.

ProjectList lets the user pick a style (or "自动/AI 选") at creation time.

### Per-page vs project-level chat

`messages.slide_id` (migration 003) scopes conversations: `listSlideMessages(slideId)` for the Editor's per-page chat; `listProjectMessages(projectId)` (`slide_id IS NULL`) for the Outline workbench. The `ChatPanel.vue` component is shared by both pages.

### The slide-canvas convention (cross-cutting)

`SLIDE_W=1920` / `SLIDE_H=1080` in `src/lib/prompt.ts` is the single source of truth shared by prompt construction, preview scaling (`SlidePreview.vue` renders HTML in an `<iframe srcdoc>` at fixed 1920×1080, CSS-transform-scaled to fit via `ResizeObserver`), and export screenshotting. Changing the canvas size means touching all three. `SlidePreview` also throttles `srcdoc` reloads (~150ms leading+trailing into a `displayHtml` ref) and paints the detected `.slide`/`body` solid background onto the iframe element during reload gaps, so streaming a dark slide doesn't flash white/black each token.

### Multi-AI configuration & formats

This **replaces** the old single key-value API config. `src/lib/aiConfig.ts` is the source of truth; `src/lib/settings.ts` is now a thin re-export shim kept only so historical imports don't break — new code should import from `aiConfig.ts`.

- **`ai_configs` table** (migration 004): one row per AI — `name / api_base / api_key / model / format("openai"|"anthropic") / multimodal / thinking_mode / thinking_effort / enabled / models_cache`. `enabled` is single-select: `setActiveAi(id)` flips all rows to 0 then the target to 1. `getActiveAi()` returns the one enabled row.
- **Active config is read at call time**, never cached: `chat()`/`chatOnce()`/`chatAgent()` call `getActiveAi()` per request, so switching the active AI takes effect on the next message. Throws "请先在「设置」页配置并启用一个 AI" if none is active or incomplete.
- **Model list is cached per-config** in `ai_configs.models_cache` (JSON array) via `getModelsCache(id)`/`saveModelsCache(id, ids)` — the Settings dropdown repopulates for the selected config, and is cleared when `api_base` or `format` changes.
- **Legacy import** (`ensureLegacyImport`, run once in `main.ts` `bootstrap()`): if `ai_configs` is empty and the old `settings` table has a non-empty `api_base`, creates one `openai`/`enabled` config from the legacy key-value values. Idempotent — won't re-fire once any config exists.
- **App-level toggles still use the `settings` key-value table** via `getSetting`/`setSetting` (re-exported from `aiConfig.ts`): `auto_selfcheck` (`"true"`/`"false"`; null/other treated as on), `tavily_api_key`, `tavily_usage`.
- **Format dispatch** (Rust `lib.rs`, driven by `config.format`):
  - `openai` (default) — POST `{api_base}/chat/completions`, `Authorization: Bearer`, OpenAI SSE (`data:` lines; `delta.content`→chunk, `delta.reasoning_content`→reasoning, `delta.tool_calls`→tool accumulation). `json_mode` → `response_format:{type:"json_object"}`. Tools → `tools:[{type:function,...}]` + `tool_choice:"auto"`.
  - `anthropic` — POST `{api_base}/v1/messages`, `x-api-key` + `anthropic-version: 2023-06-01`, system messages lifted to a top-level `system` string, Anthropic SSE (`event:`/`data:` pairs; `content_block_delta`→`text_delta`→chunk / `thinking_delta`→reasoning; `content_block_start(tool_use)` + `input_json_delta`→tool accumulation; `message_stop`→done). **No** `response_format` — `json_mode` is ignored and the prompt must constrain JSON output itself. Tools → `tools:[{name,description,input_schema}]`.
  - **Tool message translation differs by format** (in `openai_messages` / `anthropic_split`): OpenAI keeps `role:"tool"` messages standalone with `tool_call_id`, and the assistant message carries `tool_calls` as `[{id,type:function,function:{name,arguments}}]`. Anthropic has no `tool` role — `role:"tool"` messages become `tool_result` blocks, and **consecutive tool results are merged into one `user` message** (multiple `tool_result` blocks), because Anthropic requires user/assistant to strictly alternate (back-to-back `user` messages → 400). Assistant `tool_calls` become `tool_use` blocks in the assistant message's `content` array.
  - `list_models` mirrors this: OpenAI `GET {api_base}/models` (Bearer) vs Anthropic `GET {api_base}/v1/models` (x-api-key); both read `data[].id`.
- **Multimodal images**: `ChatMessage.images: Vec<String>` (dataURLs). OpenAI packs them as `image_url` parts; Anthropic as `image` base64 `source` blocks. Today the self-check path sends an image (the page screenshot).

### Self-check

Phase `selfcheck`. `maybeSelfCheck(projectId, slides, idx)` runs after a successful `startSlide` **iff** the `auto_selfcheck` setting ≠ `"false"` (default on). `selfCheckSlide` screenshots the just-generated page via `renderSlideToDataUrl` (only if the active AI is `multimodal`; non-multimodal skips the screenshot and self-checks from HTML/CSS alone) → sends `selfCheckPrompt(html, multimodal)` + the screenshot image (if any) → streams a revised HTML → **validates before writing**:
- structure: must be a complete `<html>` doc containing `.slide`;
- **theme fingerprint**: `themeFingerprint(html)` (every `background`/`background-color`/`color` declaration, whitespace-stripped, sorted, deduped) must equal the original's. A rewrite that altered the palette is **discarded and the original restored** — self-check must never touch the design system.

On success → persist + assistant message with reasoning. On structural/theme failure, cancel, or error → restore the original HTML and add a "已保留原页" message (no reasoning attached). Like every phase, cancel/error never writes half data.

### Debug / inspect mode

The Editor's "调试模式" toggle flips `SlidePreview`'s `inspectMode` prop. With it on, a capture-phase click listener on the iframe document (re-attached on iframe `@load`, because `srcdoc` loads async) highlights the clicked element and emits `pick {html: outerHTML, selector: cssSelectorPath}`. `Editor.onPick` wraps it as a `【选中元素】` fenced block and `ChatPanel.prepend`s it into the input; on send, `sendChat` parses that block back into an `element` arg, selecting `chatWithElementPrompt`.

### Streaming protocol (Rust ↔ frontend)

Frontend `chat()` (`src/lib/chat.ts`) calls `invoke("chat_stream", {config, messages})` and subscribes to Tauri events. `lib.rs` normalizes **both** OpenAI and Anthropic SSE into the same event set (parsed line-by-line, `bytes_stream` + manual `buf` accumulation). Tool-call deltas are accumulated in a `Vec<ToolAccum>` (OpenAI keyed by `delta.tool_calls[].index`, Anthropic by `content_block_start(tool_use)` order + `input_json_delta`) and flushed as one `chat-tool-calls` event at end of turn:

| event | payload | source |
|---|---|---|
| `chat-start` | `()` | connection 200 |
| `chat-chunk` | `String` | OpenAI `delta.content` · Anthropic `text_delta` |
| `chat-reasoning` | `String` | OpenAI `delta.reasoning_content` (DeepSeek) · Anthropic `thinking_delta` |
| `chat-tool-calls` | `Vec<ToolCall>` | OpenAI accumulated `delta.tool_calls` · Anthropic accumulated `tool_use` blocks (emitted once per turn, only if non-empty) |
| `chat-done` | `()` | stream end / OpenAI `[DONE]` / Anthropic `message_stop` |

`chat()` returns `{ toolCalls: ToolCall[] | null }` (collected from the `chat-tool-calls` event) and resolves when the stream finishes. `chatOnce()` is the thin "give me the full text" wrapper; `chatAgent()` drives the multi-round loop on top of `chat()`. **Cancellation**: `cancel_chat` aborts the `Abortable`-wrapped stream (a single `AbortSlot` held in managed state), emits `chat-done`, and returns `Err("__cancelled__")`; `chat.ts` rethrows that as a `CancelledError` (`.__cancelled=true`) so `genStore` can tell cancel apart from a real error. Cancellation is checked: between phases (each `start*` checks `genState.cancelled`), between agent rounds and around each tool execution (`chatAgent`'s `isCancelled` callback), and self-check restores the original HTML on cancel.

`list_models`, `tavily_search`, `tavily_extract` are separate **non-streaming** format-aware / direct-HTTP `invoke`s; the Settings page caches `list_models` per-config in `ai_configs.models_cache`.

### Thinking mode

`thinking_mode`/`thinking_effort` are **per-AI-config**, not global. When on, `lib.rs` injects:
- OpenAI: `thinking:{type:"enabled"}` + `reasoning_effort` (`"high"`/`"max"`).
- Anthropic: `thinking:{type:"enabled", budget_tokens}` (16000 for high, 32000 for max) and raises `max_tokens` to `budget + 8192`.

`chat-reasoning` events carry the thinking deltas; during reasoning there are no `chat-chunk` events. The UI shows a live "思考中" card fed by `genState.reasoning`. **Persistence** (migration 005): on each successful completion `genStore` passes `genState.reasoning` to `addMessage(...)` → `messages.reasoning`; `ChatPanel` renders it under the assistant message as a collapsible `<details>` (default collapsed, expand to review). Cancel/error/failed-self-check paths don't persist reasoning — consistent with "no half data on failure".

## Conventions & gotchas

- **API URL construction:** Rust trims a trailing `/` then appends per format — OpenAI: `{api_base}/chat/completions` + `{api_base}/models`; Anthropic: `{api_base}/v1/messages` + `{api_base}/v1/models`; Tavily: hardcoded `https://api.tavily.com/search|extract`. So `api_base` is the provider base (e.g. `https://api.deepseek.com`, `https://api.openai.com/v1`, `https://api.anthropic.com`) — never including the path. Settings help text mentions the suffix; the code doesn't take it from the user.
- **JSON mode is for the outline-split pass only** (the `outline` sub-phase inside `startOutline`). The `manuscript` sub-phase, `sendOutlineChat`, `startSlide`, and `sendChat` must not. Note: `response_format:json_object` is OpenAI-only — Anthropic silently ignores `json_mode` and relies on the prompt.
- **Manuscript-first invariant:** `startOutline` always produces (or reuses) `projects.manuscript` before splitting. Don't bypass the manuscript phase to "just generate an outline from the topic" — the split prompt takes the manuscript as its content source, and an empty manuscript throws rather than fabricating a hollow outline.
- **Every `tool_call_id` needs a matching tool result.** In `chatAgent`, the assistant message回填 only the tool calls that were actually executed (within the quota); dropped calls are *not* echoed back to the model. The quota-hit system message tells the model which calls were skipped.
- **AI config lives in `ai_configs`, not `settings`.** `src/lib/aiConfig.ts` is the source of truth (CRUD + `getActiveAi`/`setActiveAi` single-select + per-config `models_cache` + `ensureLegacyImport`). `src/lib/settings.ts` is a thin re-export shim — don't add new API-config code there. The `settings` table now holds app-level key-value data only: `auto_selfcheck`, `tavily_api_key`, `tavily_usage`.
- **Buttons/status read from `genState`, not local refs.** `Editor.vue`/`Outline.vue` gate buttons on `genState.running` and surface progress via `genState.status`; flows are sequential and gated by `running`. **Global lock**: `genState` is a singleton, so a generation in project A blocks project B — `ChatPanel` takes a `locked` prop (Editor/Outline pass `genState.running`) that disables send while any generation runs, and `ProjectList` disables new-project buttons with a "生成中" hint. Viewing/switching existing projects stays allowed (to watch live progress). **Cancel**: `cancelGeneration()` sets `genState.cancelled` + invokes `cancel_chat`; each phase checks `cancelled` between steps, `chatAgent` checks it between rounds/tools, and self-check restores the original HTML on cancel. Live preview during a run comes from `cleanHtml(genState.content)` (or the raw manuscript text in the `manuscript` phase), *not* the DB row (DB read only on completion); `Editor.currentHtml` falls back to `cur.html_content` when `genState.content` is still empty, so starting a chat edit doesn't blank the preview before the first chunk.
- **Self-check must not alter the theme.** `themeFingerprint` guards this — if a multimodal rewrite changes any background/color, it's discarded and the original restored.
- **TLS:** `reqwest` is built with `rustls-tls` (no native OpenSSL on Windows) + `stream` feature for SSE — don't switch to default features.
- **CSP** is `null` in `tauri.conf.json`; slides rely on fully inlined CSS (no external resources) so this is intentional.
- **Capabilities** (`src-tauri/capabilities/default.json`) scope the `main` window to `core:default`, `opener:default`, `sql:default` + `sql:allow-execute/select/close`, and `dialog:default`. Note: `cancel_chat`, `chat_stream`, `list_models`, `tavily_search`, `tavily_extract`, and `save_file` are **plain `#[tauri::command]`s that need no capability entries** — they do their own I/O via `reqwest` (network) or `std::fs::write` (fs), not through Tauri plugins. Capabilities only need updating when a *new command uses a Tauri plugin API* (e.g. a new `fs:`/`dialog:`/`sql:` permission).
- **`Cargo.lock` is intentionally tracked** (binary crate, not a library) — do not gitignore it. Rust build output (`target/`, `gen/schemas`) is ignored via `src-tauri/.gitignore`.
- **CI release** (`.github/workflows/release.yml`, Windows-only, builds via `tauri-apps/tauri-action@v0`, **unsigned**): a push to `master` publishes/overwrites a rolling `latest` **prerelease**; pushing a `v*` tag publishes a versioned stable Release. So every master commit ships a build; cut a `v*` tag for a "real" release. There is no test/lint gate in CI — `npm run build` (which includes `vue-tsc --noEmit`) is the only typecheck.
