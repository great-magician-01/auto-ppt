# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

纸光幻演 (AutoPPT) — a Tauri 2 desktop app that generates PowerPoint decks from an LLM. It supports **multiple AI configurations**, each either OpenAI-compatible (DeepSeek, OpenAI, …) or Anthropic-native (Claude), with exactly one enabled at a time. Vue 3 + TypeScript (Vite) frontend, Rust backend. The app UI and all LLM prompts are in Chinese; keep user-facing strings/prompts in Chinese when editing.

## Commands

```bash
npm run dev          # Vite dev server only (port 1420, strictPort — fails if taken)
npm run build        # vue-tsc --noEmit (typecheck) then vite build → dist/
npm run tauri dev    # full app: Rust + Vite (uses beforeDevCommand: npm run dev)
npm run tauri build  # production bundle (uses beforeBuildCommand: npm run build)
npm run render:icon  # render icon-source.svg → 1024 PNG, then `tauri icon` regenerates the full icon set
```

The Tauri CLI (`@tauri-apps/cli`) is a devDependency, so `npm run tauri …` works without a global install. `vite.config.ts` ignores `src-tauri/**` from watch and pins port 1420 (Tauri expects it). There is no test framework configured — no test script, no test dependencies.

## Architecture

Standard Tauri two-process split, but the responsibilities are asymmetric and worth knowing:

**Frontend (`src/`) owns the product logic.** Vue 3 `<script setup>` SFCs, `vue-router` (routes: `/`, `/projects`, `/settings`, `/outline/:id`, `/editor/:id`, all lazy). The DB is *also* driven from the frontend via `@tauri-apps/plugin-sql` (SQLite file `auto_ppt.db`), with typed query helpers in `src/lib/db.ts`. Schema lives in `src-tauri/migrations/` and is applied by the Rust side at startup (`lib.rs` → `tauri_plugin_sql::Migration`): `001_init.sql` (projects/slides/messages/settings/exports), `002_add_style.sql` (`projects.style`), `003_add_slide_id_to_messages.sql` (`messages.slide_id` for per-page chat), `004_ai_configs.sql` (the `ai_configs` multi-AI table), `005_add_reasoning_to_messages.sql` (`messages.reasoning` for persisted thinking), `006_add_manuscript_and_search.sql` (`projects.manuscript` full文案 + `projects.search_enabled` per-project web-search toggle).

**Backend (`src-tauri/src/lib.rs`) does only what the browser sandbox can't:** proxy the LLM API with SSE streaming (`chat_stream`, dispatching OpenAI *or* Anthropic format, **including dual-format LLM tool-call streaming**), abort an in-flight stream (`cancel_chat`), fetch the model list (`list_models`, also format-aware), call the Tavily web-search/extract API (`tavily_search` / `tavily_extract`, non-streaming like `list_models`), and write exported files outside the fs scope (`save_file`). `main.rs` is a thin bin that just calls `tauri_app_lib::run()`; all real Rust code is in `lib.rs`. (The `[lib]` name `tauri_app_lib` + `staticlib/cdylib/rlib` crate-types is the standard Tauri 2 mobile-ready split — don't "fix" the apparent redundancy.) Frontend `src/main.ts` `bootstrap()` runs `ensureLegacyImport()` once at startup (see Multi-AI), always disables the context menu, and in production blocks devtools shortcuts (F12 / Ctrl+Shift+I/J/C).

### The generation pipeline (orchestrated by a global store)

Generation is **not** owned by any single component — it lives in `src/lib/genStore.ts`, which exports a module-level reactive `genState` (the single source of truth: `running`, `phase`, `projectId`, `slideIdx`, `reasoning`, `content`, `status`, `error`, `cancelled`). Because it is module-level, a generation run **survives component unmount/remount** — you can navigate away mid-stream and come back to live progress. Both `Outline.vue` and `Editor.vue` merely *read* `genState` (live preview from `genState.content`) and *watch* `genState.running` to reload the final DB state when a background run finishes. Prompts live in `src/lib/prompt.ts`. Phases: `idle | manuscript | outline | outline-chat | slide | chat | selfcheck`.

The flow spans two pages — ProjectList creates a project → `/outline/:id` → `/editor/:id`:

1. **Manuscript → outline + design system** (`Outline.vue` → `startOutline()`, phases `manuscript` then `outline`) — now **two sub-stages** (文案先行):
   - **Manuscript** (`manuscriptPrompt`): the model writes a complete markdown 演讲文案 first. If the project has `search_enabled` **and** a Tavily key is configured (`getTavilyKey`), this runs as a multi-turn agent loop (`chatAgent` + `tavilyTools`) — the model autonomously calls `tavily_search`/`tavily_extract` to research, results are fed back, until it emits the final manuscript text. With no key / unsupported tools it falls back to a plain offline `chat` stream. **Not** JSON mode. The manuscript persists to `projects.manuscript` and renders as a collapsible panel in the Outline workbench. A pre-existing manuscript (e.g. split stage was cancelled last run) is reused and the manuscript stage skipped. An empty manuscript (model returned only tool calls / nothing) **throws** rather than produce an empty outline.
   - **Split** (`splitOutlinePrompt(topic, manuscript, style)`, JSON mode): `chatOnce(..., jsonMode=true)` splits the manuscript into `{design_tokens, theme_css, slides[], style?}` — each slide now carries a `notes` field (讲稿片段, later written to PPTX speaker notes). Page count is **dynamic** (the prompt instructs ~6–20+ pages by content richness, not a fixed number). `parseOutline` tolerantly extracts the JSON (fence-stripping + brace-balancing) and **retries once** on parse failure. Stored on `projects` (design_tokens/theme_css/style) + one `slides` row per outline item (`html_content=null`). `Outline.vue` auto-starts this on mount when no slides exist yet. OpenAI format sends `response_format: json_object`; Anthropic ignores `json_mode` and relies on the prompt. Thinking persisted on each sub-stage's success.
2. **Outline chat** (`Outline.vue` → `sendOutlineChat()`, phase `outline-chat`) — natural-language outline edits. **Not** jsonMode; the system prompt constrains the model to return the same JSON structure and **preserve each slide's `notes`**. The full manuscript is passed for reference so edits stay aligned with the文案. `parseOutline` runs on the streamed content and **only writes to DB on parse success** (a failed parse leaves the existing outline untouched). Persists reasoning on success.
3. **Per-slide HTML** (`Editor.vue` → `startSlide()` / `startAll()`, phase `slide`) — builds `slideHtmlPrompt`: inlines the shared `theme_css` verbatim into a standalone HTML doc whose `.slide` canvas is fixed at **1920×1080**. Not JSON mode. `cleanHtml` strips code fences. During the stream, `slide.html_content` is updated live from `cleanHtml(genState.content)` so the preview follows token-by-token; on completion it is persisted (`upsertSlide`) and a completion message with reasoning is added. Then **`maybeSelfCheck`** may run (see Self-check). `startAll` loops per slide, skipping already-generated ones and advancing `genState.slideIdx`; the editor auto-follows via a `watch(genState.slideIdx)` gated on `genState.projectId === projectId` (not on `running`), so it tracks page advances across the `running=false` gap between pages.
4. **Per-slide chat editing** (`Editor.vue` → `sendChat()`, phase `chat`) — sends the current page's HTML + a modification instruction; the model returns a full revised HTML doc, streamed live into the preview. Messages are scoped to the slide via `messages.slide_id`. **Debug mode**: when the user picks an element, `sendChat` receives an `element {html, selector}` and switches the prompt to `chatWithElementPrompt` (edit scoped to that element; full-page HTML still returned). Persists reasoning on success.
5. **Export** — `exportPptx` (`src/lib/ppt.ts`) renders each slide's HTML in an **isolated hidden `<iframe>`** at 1920×1080 via `renderSlideToDataUrl` (not a plain div — the iframe isolates the slide's `<style>`, which can contain `:root`/`body/*` global rules that would otherwise pollute the app document during the screenshot), screenshots it with `modern-screenshot` (`domToPng` → PNG dataURL), assembles a `.pptx` via `pptxgenjs` (one full-bleed image per slide, `LAYOUT_WIDE`; each slide's `outline.notes` is written to that slide's speaker notes via `addNotes`), then writes bytes through the Rust `save_file` command after a native save dialog. `renderSlideToDataUrl` is shared by export and the self-check screenshot.

### Style system

`src/lib/styles.ts` defines `STYLE_PRESETS` (12 built-in metadata-only presets: palette/font/density hints, no full CSS). The outline prompt has two modes decided by `stylesForPrompt(style)`:
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
- **Active config is read at call time**, never cached: `chat()`/`chatOnce()` call `getActiveAi()` per request, so switching the active AI takes effect on the next message. Throws "请先在「设置」页配置并启用一个 AI" if none is active or incomplete.
- **Model list is cached per-config** in `ai_configs.models_cache` (JSON array) via `getModelsCache(id)`/`saveModelsCache(id, ids)` — the Settings dropdown repopulates for the selected config, and is cleared when `api_base` or `format` changes.
- **Legacy import** (`ensureLegacyImport`, run once in `main.ts` `bootstrap()`): if `ai_configs` is empty and the old `settings` table has a non-empty `api_base`, creates one `openai`/`enabled` config from the legacy key-value values. Idempotent — won't re-fire once any config exists.
- **App-level key-value state still uses the `settings` table** via `getSetting`/`setSetting` (re-exported from `aiConfig.ts`). Keys: `auto_selfcheck` (`"true"`/`"false"`; null/other treated as on), `tavily_api_key` (enables web research when set; its presence is what makes the ProjectList "联网搜索" toggle appear), `tavily_usage` (JSON `{searchCalls, extractCalls, extractUrls, credits}` — usage stats shown/reset in Settings).
- **Format dispatch** (Rust `lib.rs`, driven by `config.format`):
  - `openai` (default) — POST `{api_base}/chat/completions`, `Authorization: Bearer`, OpenAI SSE (`data:` lines; `delta.content`→chunk, `delta.reasoning_content`→reasoning). `json_mode` → `response_format:{type:"json_object"}`.
  - `anthropic` — POST `{api_base}/v1/messages`, `x-api-key` + `anthropic-version: 2023-06-01`, system messages lifted to a top-level `system` string, Anthropic SSE (`event:`/`data:` pairs; `content_block_delta`→`text_delta`→chunk / `thinking_delta`→reasoning; `message_stop`→done). **No** `response_format` — `json_mode` is ignored and the prompt must constrain JSON output itself.
  - `list_models` mirrors this: OpenAI `GET {api_base}/models` (Bearer) vs Anthropic `GET {api_base}/v1/models` (x-api-key); both read `data[].id`.
- **Multimodal images**: `ChatMessage.images: Vec<String>` (dataURLs). OpenAI packs them as `image_url` parts; Anthropic as `image` base64 `source` blocks. Today only the self-check path sends an image (the page screenshot).

### Self-check

Phase `selfcheck`. `maybeSelfCheck(projectId, slides, idx)` runs after a successful `startSlide` **iff** the `auto_selfcheck` setting ≠ `"false"` (default on) — it now runs for **both multimodal and non-multimodal AIs** (was multimodal-only). `selfCheckSlide`: multimodal AIs screenshot the just-generated page via `renderSlideToDataUrl` and send `selfCheckPrompt(html, multimodal=true)` + the image; non-multimodal AIs send `selfCheckPrompt(html, multimodal=false)` with **no image** (the model infers overflow/alignment from CSS/structure alone). Either way it streams a revised HTML → **validates before writing**:
- structure: must be a complete `<html>` doc containing `.slide`;
- **theme fingerprint**: `themeFingerprint(html)` (every `background`/`background-color`/`color` declaration, whitespace-stripped, sorted, deduped) must equal the original's. A rewrite that altered the palette is **discarded and the original restored** — self-check must never touch the design system.

On success → persist + assistant message with reasoning. On structural/theme failure, cancel, or error → restore the original HTML and add a "已保留原页" message (no reasoning attached). Like every phase, cancel/error never writes half data.

### Debug / inspect mode

The Editor's "调试模式" toggle flips `SlidePreview`'s `inspectMode` prop. With it on, a capture-phase click listener on the iframe document (re-attached on iframe `@load`, because `srcdoc` loads async) highlights the clicked element and emits `pick {html: outerHTML, selector: cssSelectorPath}`. `Editor.onPick` wraps it as a `【选中元素】` fenced block and `ChatPanel.prepend`s it into the input; on send, `sendChat` parses that block back into an `element` arg, selecting `chatWithElementPrompt`.

### Streaming protocol (Rust ↔ frontend)

Frontend `chat()` (`src/lib/chat.ts`) calls `invoke("chat_stream", {config, messages})` and subscribes to Tauri events. `lib.rs` normalizes **both** OpenAI and Anthropic SSE into the same event set (parsed line-by-line, `bytes_stream` + manual `buf` accumulation):

| event | payload | source |
|---|---|---|
| `chat-start` | `()` | connection 200 |
| `chat-chunk` | `String` | OpenAI `delta.content` · Anthropic `text_delta` |
| `chat-reasoning` | `String` | OpenAI `delta.reasoning_content` (DeepSeek) · Anthropic `thinking_delta` |
| `chat-tool-calls` | `Vec<ToolCall>` | OpenAI `delta.tool_calls` (accumulated by `index`) · Anthropic `tool_use` blocks (accumulated by `content_block_start` order); emitted once at round end |
| `chat-done` | `()` | stream end / OpenAI `[DONE]` / Anthropic `message_stop` |

`invoke` resolves when the stream finishes. **Tool calling** (dual-format): when `chat()` is passed `opts.tools`, Rust accumulates streamed tool-call deltas and emits them as one `chat-tool-calls` event at round end; `chat()` returns `{toolCalls}`. `chatAgent()` (`chat.ts`) drives the multi-turn loop — feed each tool result back as a `role:"tool"` message (Rust merges consecutive tool results into one Anthropic `user` message to satisfy the user/assistant alternation rule) until a round emits no tool calls. Limits default to ≤50 LLM rounds / ≤20 tool calls; hitting the tool budget appends a system instruction forcing a final answer and stops passing tools (prevents empty-loop spin). It takes an `isCancelled` callback checked between rounds and after each tool exec. In `genStore`, the manuscript agent loop wires `execTavilyTool` as the executor — it runs `tavily_search`/`tavily_extract` via `invoke`, records per-call credits to `tavily_usage`, and appends an audit line (query + credits) to `genState.reasoning`. **Cancellation**: `cancel_chat` aborts the `Abortable`-wrapped stream (a single `AbortSlot` held in managed state), emits `chat-done`, and returns `Err("__cancelled__")`; `chat.ts` rethrows that as a `CancelledError` (`.__cancelled=true`) so `genStore` can tell cancel apart from a real error and check `genState.cancelled` between phases.

`list_models` is a separate, **non-streaming** format-aware `invoke`; the Settings page caches its result per-config in `ai_configs.models_cache`.

### Thinking mode

`thinking_mode`/`thinking_effort` are **per-AI-config**, not global. When on, `lib.rs` injects:
- OpenAI: `thinking:{type:"enabled"}` + `reasoning_effort` (`"high"`/`"max"`).
- Anthropic: `thinking:{type:"enabled", budget_tokens}` (16000 for high, 32000 for max) and raises `max_tokens` to `budget + 8192`.

`chat-reasoning` events carry the thinking deltas; during reasoning there are no `chat-chunk` events. The UI shows a live "思考中" card fed by `genState.reasoning`. **Persistence** (migration 005): on each successful completion `genStore` passes `genState.reasoning` to `addMessage(...)` → `messages.reasoning`; `ChatPanel` renders it under the assistant message as a collapsible `<details>` (default collapsed, expand to review). Cancel/error/failed-self-check paths don't persist reasoning — consistent with "no half data on failure".

## Conventions & gotchas

- **API URL construction:** Rust trims a trailing `/` then appends per format — OpenAI: `{api_base}/chat/completions` + `{api_base}/models`; Anthropic: `{api_base}/v1/messages` + `{api_base}/v1/models`. So `api_base` is the provider base (e.g. `https://api.deepseek.com`, `https://api.openai.com/v1`, `https://api.anthropic.com`) — never including the path. Settings help text mentions the suffix; the code doesn't take it from the user.
- **JSON mode is for the outline *split* stage only** (the second half of `startOutline`, via `chatOnce(..., true)`). The manuscript stage, `sendOutlineChat`, `startSlide`, `sendChat`, and the self-check stream must not use it. Note: `response_format:json_object` is OpenAI-only — Anthropic silently ignores `json_mode` and relies on the prompt.
- **AI config lives in `ai_configs`, not `settings`.** `src/lib/aiConfig.ts` is the source of truth (CRUD + `getActiveAi`/`setActiveAi` single-select + per-config `models_cache` + `ensureLegacyImport`). `src/lib/settings.ts` is a thin re-export shim — don't add new API-config code there. The `settings` table holds app-level key-value state (`auto_selfcheck`, `tavily_api_key`, `tavily_usage`).
- **Buttons/status read from `genState`, not local refs.** `Editor.vue`/`Outline.vue` gate buttons on `genState.running` and surface progress via `genState.status`; flows are sequential and gated by `running`. **Global lock**: `genState` is a singleton, so a generation in project A blocks project B — `ChatPanel` takes a `locked` prop (Editor/Outline pass `genState.running`) that disables send while any generation runs, and `ProjectList` disables new-project buttons with a "生成中" hint. Viewing/switching existing projects stays allowed (to watch live progress). **Cancel**: `cancelGeneration()` sets `genState.cancelled` + invokes `cancel_chat`; each phase checks `cancelled` between steps and self-check restores the original HTML on cancel. Live preview during a run comes from `cleanHtml(genState.content)`, *not* the DB row (DB read only on completion); `Editor.currentHtml` falls back to `cur.html_content` when `genState.content` is still empty, so starting a chat edit doesn't blank the preview before the first chunk.
- **Self-check must not alter the theme.** `themeFingerprint` guards this — if a self-check rewrite changes any background/color, it's discarded and the original restored (applies to both multimodal and non-multimodal self-check).
- **TLS:** `reqwest` is built with `rustls-tls` (no native OpenSSL on Windows) + `stream` feature for SSE — don't switch to default features.
- **CSP** is `null` in `tauri.conf.json`; slides rely on fully inlined CSS (no external resources) so this is intentional.
- **Capabilities** (`src-tauri/capabilities/default.json`) scope the `main` window to `core:default`, `opener:default`, `sql:default` + `sql:allow-execute/select/close`, and `dialog:default`. `cancel_chat`/`tavily_search`/`tavily_extract` need no extra perms (plain commands; Tavily does outbound HTTPS from Rust via `reqwest`, which isn't Tauri-scoped); `save_file` writes via `std::fs::write` directly, bypassing the fs plugin. Adding a command that needs fs/network perms means updating permissions here.
- **`Cargo.lock` is intentionally tracked** (binary crate, not a library) — do not gitignore it. Rust build output (`target/`, `gen/schemas`) is ignored via `src-tauri/.gitignore`.
