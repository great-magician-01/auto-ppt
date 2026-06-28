# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AutoPPT — a Tauri 2 desktop app that uses an OpenAI-compatible LLM to generate PowerPoint decks. Vue 3 + TypeScript (Vite) frontend, Rust backend. The app UI and all LLM prompts are in Chinese; keep user-facing strings/prompts in Chinese when editing.

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

**Frontend (`src/`) owns the product logic.** Vue 3 `<script setup>` SFCs, `vue-router` (routes: `/`, `/projects`, `/settings`, `/outline/:id`, `/editor/:id`, all lazy). The DB is *also* driven from the frontend via `@tauri-apps/plugin-sql` (SQLite file `auto_ppt.db`), with typed query helpers in `src/lib/db.ts`. Schema lives in `src-tauri/migrations/` and is applied by the Rust side at startup (`lib.rs` → `tauri_plugin_sql::Migration`): `001_init.sql` (projects/slides/messages/settings/exports), `002_add_style.sql` (`projects.style`), `003_add_slide_id_to_messages.sql` (`messages.slide_id` for per-page chat).

**Backend (`src-tauri/src/lib.rs`) does only what the browser sandbox can't:** proxy the LLM API with SSE streaming (`chat_stream`), fetch the model list (`list_models`), and write exported files outside the fs scope (`save_file`). `main.rs` is a thin bin that just calls `tauri_app_lib::run()`; all real Rust code is in `lib.rs`. (The `[lib]` name `tauri_app_lib` + `staticlib/cdylib/rlib` crate-types is the standard Tauri 2 mobile-ready split — don't "fix" the apparent redundancy.)

### The generation pipeline (orchestrated by a global store)

Generation is **not** owned by any single component — it lives in `src/lib/genStore.ts`, which exports a module-level reactive `genState` (the single source of truth: `running`, `phase`, `projectId`, `slideIdx`, `reasoning`, `content`, `status`, `error`). Because it is module-level, a generation run **survives component unmount/remount** — you can navigate away mid-stream and come back to live progress. Both `Outline.vue` and `Editor.vue` merely *read* `genState` (live preview from `genState.content`) and *watch* `genState.running` to reload the final DB state when a background run finishes. Prompts live in `src/lib/prompt.ts`. Phases: `idle | outline | outline-chat | slide | chat`.

The flow spans two pages — ProjectList creates a project → `/outline/:id` → `/editor/:id`:

1. **Outline + design system** (`Outline.vue` → `startOutline()`, phase `outline`) — `chatOnce(..., jsonMode=true)` → Rust `chat_stream` POSTs `{api_base}/chat/completions` with `response_format: json_object`. Returns `{design_tokens, theme_css, slides[], style?}`. `parseOutline` tolerantly extracts the JSON (fence-stripping + brace-balancing) and **retries once** on parse failure. Stored on `projects` (design_tokens/theme_css/style) + one `slides` row per outline item (`html_content=null`). `Outline.vue` auto-starts this on mount when no slides exist yet.
2. **Outline chat** (`Outline.vue` → `sendOutlineChat()`, phase `outline-chat`) — natural-language outline edits. **Not** jsonMode; the system prompt constrains the model to return the same JSON structure. `parseOutline` runs on the streamed content and **only writes to DB on parse success** (a failed parse leaves the existing outline untouched).
3. **Per-slide HTML** (`Editor.vue` → `startSlide()` / `startAll()`, phase `slide`) — builds `slideHtmlPrompt`: inlines the shared `theme_css` verbatim into a standalone HTML doc whose `.slide` canvas is fixed at **1920×1080**. Not JSON mode. `cleanHtml` strips code fences. During the stream, `slide.html_content` is updated live from `cleanHtml(genState.content)` so the preview follows token-by-token; on completion it is persisted (`upsertSlide`). `startAll` loops per slide, skipping already-generated ones and advancing `genState.slideIdx` (the editor auto-follows).
4. **Per-slide chat editing** (`Editor.vue` → `sendChat()`, phase `chat`) — sends the current page's HTML + a modification instruction; the model returns a full revised HTML doc, streamed live into the preview. Messages are scoped to the slide via `messages.slide_id`.
5. **Export** — `exportPptx` (`src/lib/ppt.ts`) renders each slide's HTML in an **isolated hidden `<iframe>`** at 1920×1080 (not a plain div — the iframe isolates the slide's `<style>`, which can contain `:root`/`body/*` global rules that would otherwise pollute the app document during the screenshot), screenshots it with `modern-screenshot` (`domToPng` → PNG dataURL), assembles a `.pptx` via `pptxgenjs` (one full-bleed image per slide, `LAYOUT_WIDE`), then writes bytes through the Rust `save_file` command after a native save dialog.

### Style system

`src/lib/styles.ts` defines `STYLE_PRESETS` (12 built-in metadata-only presets: palette/font/density hints, no full CSS). The outline prompt has two modes decided by `stylesForPrompt(style)`:
- **explicit** — `projects.style` is set and matches a preset → inject only that preset's hints.
- **auto** — `style` is null → inject *all* presets and ask the model to pick one; the chosen `style` id is written back to `projects.style`. `startOutline`/`sendOutlineChat` resolve `resolvedStyle = parsed.style ?? style ?? null` and persist it.

ProjectList lets the user pick a style (or "自动/AI 选") at creation time.

### Per-page vs project-level chat

`messages.slide_id` (migration 003) scopes conversations: `listSlideMessages(slideId)` for the Editor's per-page chat; `listProjectMessages(projectId)` (`slide_id IS NULL`) for the Outline workbench. The `ChatPanel.vue` component is shared by both pages.

### The slide-canvas convention (cross-cutting)

`SLIDE_W=1920` / `SLIDE_H=1080` in `src/lib/prompt.ts` is the single source of truth shared by prompt construction, preview scaling (`SlidePreview.vue` renders HTML in an `<iframe srcdoc>` at fixed 1920×1080, CSS-transform-scaled to fit via `ResizeObserver`), and export screenshotting. Changing the canvas size means touching all three.

### Streaming protocol (Rust ↔ frontend)

Frontend `chat()` (`src/lib/chat.ts`) calls `invoke("chat_stream", {config, messages})` and subscribes to Tauri events emitted by `lib.rs`, which parses SSE line-by-line (`bytes_stream` + manual `buf` accumulation):

| event | payload | source field |
|---|---|---|
| `chat-start` | `()` | connection 200 |
| `chat-chunk` | `String` | `delta.content` |
| `chat-reasoning` | `String` | `delta.reasoning_content` |
| `chat-done` | `()` | stream end / `[DONE]` |

`invoke` resolves when the stream finishes. The reasoning field is `reasoning_content` (DeepSeek convention), not OpenAI's `reasoning`.

`list_models` is a separate, **non-streaming** `invoke` that GETs `{api_base}/models` and returns `string[]` of model ids; the Settings page caches the result in the `settings` table (key `models`) via `getModelsCache`/`saveModelsCache` so the dropdown repopulates on reopen.

### Thinking mode

When `thinking_mode` is on (Settings page), `lib.rs` injects `thinking: {type:"enabled"}` and `reasoning_effort` (`"high"`/`"max"`) into the request body. `chat-reasoning` events carry the thinking deltas; during reasoning there are no `chat-chunk` events. The `ChatPanel` shows a live "思考中" card fed by `genState.reasoning`.

## Conventions & gotchas

- **API URL construction:** Rust builds `{api_base}/chat/completions` and `{api_base}/models` after trimming a trailing `/`. So `api_base` is the provider base, e.g. `https://api.deepseek.com` or `https://api.openai.com/v1` — *not* including `/chat/completions`. The Settings page appends `/chat/completions` only in its help text, the actual code doesn't.
- **JSON mode is for outline generation only.** `startOutline` uses it; `sendOutlineChat`, `startSlide`, and `sendChat` must not.
- **Settings are key-value** in the `settings` table (`api_base`, `api_key`, `model`, `thinking_mode` as `"true"`/`"false"` string, `thinking_effort`, plus the cached `models` JSON array). `src/lib/settings.ts` marshals to/from the `ApiSettings` shape.
- **Buttons/status read from `genState`, not local refs.** `Editor.vue`/`Outline.vue` gate buttons on `genState.running` and surface progress via `genState.status`; flows are sequential and gated by `running`. Live preview during a run comes from `cleanHtml(genState.content)`, *not* from the DB row (the DB is only read on run completion).
- **TLS:** `reqwest` is built with `rustls-tls` (no native OpenSSL on Windows) + `stream` feature for SSE — don't switch to default features.
- **CSP** is `null` in `tauri.conf.json`; slides rely on fully inlined CSS (no external resources) so this is intentional.
- **Capabilities** (`src-tauri/capabilities/default.json`) scope the `main` window to `core:default`, `opener:default`, `sql:default` + `sql:allow-execute/select/close`, and `dialog:default`. Adding a new Tauri command that needs fs/network perms means updating permissions here.
- **`Cargo.lock` is intentionally tracked** (binary crate, not a library) — do not gitignore it. Rust build output (`target/`, `gen/schemas`) is ignored via `src-tauri/.gitignore`.
