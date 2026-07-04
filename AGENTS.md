# AGENTS.md

Compact agent guide. Deep architecture, conventions, and the full generation pipeline are in [`CLAUDE.md`](./CLAUDE.md) — read it before non-trivial work. This file only captures what an agent would otherwise guess wrong.

## Commands

```bash
npm run tauri dev    # full app (Rust + Vite). Port 1420 is strictPort — fails if taken.
npm run dev          # Vite only (no Tauri commands; UI preview only)
npm run build        # vue-tsc --noEmit (the only typecheck) then vite build
npm run tauri build  # production bundle
npm run render:icon  # SVG → 1024 PNG → `tauri icon` regenerates the full icon set
```

No test framework, no lint script. `npm run build` (specifically `vue-tsc --noEmit`) is the only verification gate — run it after frontend changes.

Rust changes: `cargo check` / `cargo build` inside `src-tauri/`. There is no separate Rust test suite.

## Version sync

Version `0.1.7` (currently) is kept in sync across **three** files — bump all together:
- `package.json`
- `src-tauri/tauri.conf.json` (CI reads the version from here)
- `src-tauri/Cargo.toml`

## Release / CI

`.github/workflows/release.yml` (Windows-only, unsigned, `tauri-apps/tauri-action@v0`):
- Push to `master` → overwrites a rolling `latest` **prerelease**.
- Push a `v*` tag → versioned stable Release.

Every master commit ships a build; cut a `v*` tag for a "real" release. No CI test/lint gate — `npm run build` is the only typecheck.

## Architecture essentials (not obvious from filenames)

- **Tauri two-process, asymmetric.** Frontend (`src/`) owns product logic AND drives SQLite directly via `@tauri-apps/plugin-sql`. Rust (`src-tauri/src/lib.rs`, single file) does only what the sandbox can't: proxy LLM SSE (OpenAI *or* Anthropic format dispatch), `cancel_chat`, `list_models`, Tavily search/extract (direct `reqwest`), `save_file`. `main.rs` is a thin bin calling `tauri_app_lib::run()` — the `[lib]` name + `staticlib/cdylib/rlib` crate-types is the standard mobile-ready split, don't "fix" it.
- **Generation is orchestrated by `src/lib/genStore.ts`**, a module-level reactive singleton (`genState`). A run **survives component unmount/remount** — pages read `genState`, they don't own it. Because it's a singleton, **a generation in project A globally locks project B**; `ChatPanel.locked` and ProjectList's disabled buttons reflect `genState.running`.
- **Manuscript-first invariant.** `startOutline` always produces (or reuses) `projects.manuscript` before splitting into an outline. Don't bypass it. The only `jsonMode` call is the outline-split pass; manuscript / slide / chat must not use it (Anthropic silently ignores `json_mode` anyway).
- **Slide canvas is fixed 1920×1080** (`SLIDE_W/H` in `src/lib/prompt.ts`) — shared by prompts, preview scaling (`SlidePreview.vue`), and export screenshotting. Changing it touches all three.
- **Active AI config is read at call time** (`getActiveAi()` per request), never cached. Configs live in the `ai_configs` table (`src/lib/aiConfig.ts` is the source of truth). `src/lib/settings.ts` is a thin re-export shim — don't add new API-config code there. `settings` table holds only app-level keys: `auto_selfcheck`, `tavily_api_key`, `tavily_usage`.
- **Every `tool_call_id` needs a matching tool result** or the API 400s. In `chatAgent`, the assistant message is backfilled with only the tool calls actually executed (within quota); dropped calls aren't echoed.
- **Self-check must not alter the theme** — `themeFingerprint` guards this; a rewrite changing any background/color is discarded and the original restored.
- **Cancel never writes half data.** Each phase checks `genState.cancelled` between steps; `chatAgent` checks between rounds/tools; self-check restores original HTML on cancel.

## Migrations

`src-tauri/migrations/00X_*.sql`, registered in order in `lib.rs` `run()` and applied by `tauri_plugin_sql` at startup. Current count: **7** (001–007). When adding one, create the SQL file AND append a `Migration { version, … }` entry — both are required.

## Toolchain / config quirks

- **`reqwest` uses `rustls-tls` + `stream`** (no native OpenSSL on Windows). Don't switch to default features.
- **CSP is `null`** in `tauri.conf.json` — slides use fully inlined CSS by design.
- **`Cargo.lock` is intentionally tracked** (binary crate) — don't gitignore it.
- **Capabilities** (`src-tauri/capabilities/default.json`) scope only Tauri-plugin permissions. `chat_stream`, `cancel_chat`, `list_models`, `tavily_search`, `tavily_extract`, `save_file` are plain `#[tauri::command]`s doing their own `reqwest`/`std::fs` I/O — they need **no** capability entries. Only add capability entries when a new command uses a Tauri plugin API.
- **API URL construction:** `api_base` is the provider base, never including the path. Rust trims trailing `/` then appends per format — OpenAI: `/chat/completions` + `/models`; Anthropic: `/v1/messages` + `/v1/models`; Tavily: hardcoded `https://api.tavily.com/{search,extract}`.
- **Vite** ignores `src-tauri/**` from watch and pins port 1420 (Tauri expects it).

## Conventions

- UI and all LLM prompts are in **Chinese** — keep user-facing strings/prompts in Chinese when editing.
- SQLite DB lives in system app data (`%APPDATA%\com.autoppt.app\auto_ppt.db` on Windows), not in the repo.
- `domToPng` (export) clones `.slide` and loses `:root` CSS-var backgrounds — `ppt.ts` resolves them to solid colors in-place before screenshotting to prevent dark slides exporting white.
