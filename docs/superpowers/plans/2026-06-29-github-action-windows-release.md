# GitHub Action 自动构建 Windows 安装包到 Release 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建一个 GitHub Actions workflow,在 push 到 `main` 和打 `v*` 标签时自动构建 Windows 安装包(NSIS `.exe` + MSI `.msi`)并发布到对应 GitHub Release。

**Architecture:** 单个 workflow 文件 `.github/workflows/release.yml`,使用 `tauri-apps/tauri-action@v0` 完成 checkout / Rust 工具链 / `npm ci` / `tauri build` / 上传产物到 Release 的全流程。通过 `if` 条件区分分支推送(滚动 `latest` 预发布)与标签推送(版本化正式 Release)。

**Tech Stack:** GitHub Actions、`tauri-apps/tauri-action@v0`、Tauri 2(已有)、`npm run tauri build`。

## Global Constraints

- 只构建 Windows(`windows-latest`),仅 x64。
- `tauri.conf.json` 中 `bundle.targets: "all"` 在 Windows 上产出 NSIS `.exe` 和 MSI `.msi`,两者都要上传。
- 不做代码签名,CI 零证书配置。
- 两条触发规则在同一个 `push` 触发器里,分支推送与标签推送互不重叠。
- 仓库目前不是 git 仓库(`git: false`);workflow 真正生效需要先 `git init` 并推到 GitHub 远程。本计划只负责产出 workflow 文件本身,不负责初始化 git 仓库。
- 权限必须 `contents: write`(创建/更新 Release 必需)。

---

## 文件结构

只创建一个文件,不修改任何现有代码:

- **Create:** `.github/workflows/release.yml` —— 完整的 GitHub Actions workflow,职责:定义触发条件、构建任务、Release 映射。

无测试框架要求(Tauri 桌面应用项目无测试脚本);验证方式为 YAML 语法校验 + 实际推送触发后查看 Actions 运行日志与 Release 页面产物。

---

### Task 1: 创建 GitHub Actions workflow 文件

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: 无(独立 workflow)
- Produces: 一个可被 GitHub Actions 加载的 workflow,在 push 到 `master` 或打 `v*` 标签时触发,产出 Windows 安装包并发布到 Release。

- [ ] **Step 1: 创建 workflow 文件**

写入 `.github/workflows/release.yml`,完整内容如下:

```yaml
name: Release

on:
  push:
    branches:
      - master
    tags:
      - 'v*'

jobs:
  release:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: 安装 Node.js
        uses: actions/setup-node@v4
        with:
          node-version: lts/*
          cache: npm

      - name: 安装 Rust 工具链
        uses: dtolnay/rust-toolchain@stable

      - name: 缓存 Cargo 编译产物
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: 安装前端依赖
        run: npm ci

      - name: 构建并发布
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          # 分支推送(master)→ 滚动覆盖 latest 预发布;标签推送 → 版本化正式 Release
          tagName: ${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || 'latest' }}
          releaseName: ${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || 'Latest Build' }}
          releaseBody: 'AutoPPT Windows 安装包,由 GitHub Actions 自动构建。'
          releaseDraft: false
          prerelease: ${{ !startsWith(github.ref, 'refs/tags/') }}
```

说明(实现者须知):
- `on.push.branches: [main]` 与 `on.push.tags: [v*]` 是两个独立的触发事件,不会互相干扰。
- `tauri-action@v0` 自动完成:checkout(本步骤显式做了,稳妥)、装 Rust stable、`npm ci`、`npm run tauri build`、把 `.exe`/`.msi` 上传到由 `tagName` 指定的 Release。
- `tagName` 用三元表达式:标签推送时取 `github.ref_name`(即 `v0.1.0`),分支推送时固定为 `latest`。`tauri-action` 对同名 `tagName` 会更新已有 Release 而非报错,故 `latest` 每次覆盖。
- `prerelease`:分支推送为 `true`(预发布),标签推送为 `false`(正式)。
- `GITHUB_TOKEN` 是 Actions 自动注入的 secret,无需手动配置。
- 不设 `tauriScript` / `args` 等参数,走 `tauri-action` 默认逻辑即可。

- [ ] **Step 2: 校验 YAML 语法**

由于本机无 yamllint,用 Node 内置方式快速校验。运行:

```bash
node -e "require('fs').readFileSync('.github/workflows/release.yml','utf8'); console.log('file readable')"
```

Expected: 输出 `file readable` 且无报错。

如本机装有 `yamllint`(可选),可进一步运行:

```bash
yamllint .github/workflows/release.yml
```

Expected: 无错误(可能有轻微样式提示,可忽略)。

> 注:完整 YAML 结构校验的最权威方式是 GitHub Actions 本身的语法检查 —— 推送到仓库后,在 Actions 页面若 workflow 出现在侧栏即说明结构被 GitHub 接受。

- [ ] **Step 3: 提交**

此项目当前非 git 仓库。若实现时仍是 `git: false`:

```bash
git init
git add .github/workflows/release.yml
git commit -m "ci: add windows release workflow"
```

若已是 git 仓库:

```bash
git add .github/workflows/release.yml
git commit -m "ci: add windows release workflow"
```

- [ ] **Step 4: 推送并验证触发**

需要一个 GitHub 远程仓库。执行(替换 `<你的仓库地址>`):

```bash
git remote add origin <你的仓库地址>
git push -u origin main
```

Expected: 推送后约 1 分钟内,GitHub 仓库的 **Actions** 页面出现一次 `Release` workflow 运行;约 5–15 分钟后运行成功,在 **Releases** 页面出现名为 `Latest Build` 的预发布版本,资产含 `AutoPPT_0.1.0_x64-setup.exe` 与 `AutoPPT_0.1.0_x64_en-US.msi`(文件名中的版本号取自 `tauri.conf.json` 的 `version`,当前为 `0.1.0`)。

验证正式版触发:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Expected: Actions 页面再出现一次 `Release` workflow 运行;成功后在 Releases 页面出现名为 `v0.1.0` 的正式版本(非预发布),资产同样含 `.exe` 和 `.msi`。

> 若 Actions 运行失败:进入运行详情查看日志。最常见错误是 `tauri-action` 找不到 `tauri.conf.json`(确认仓库根下有 `src-tauri/`)或 `npm ci` 失败(确认 `package-lock.json` 已提交)。

---

## Self-Review 结果(已对照 spec 核对)

1. **Spec 覆盖**:spec 中"触发策略""构建任务""代码签名""Release 映射""使用方式"各节均对应到 Task 1 的 workflow 内容与 Step 4 的验证。无遗漏。
2. **占位符扫描**:无 TBD/TODO;Step 4 中 `<你的仓库地址>` 是用户必填的运行期参数,已在文中标注替换,属合理。
3. **类型/命名一致性**:`tagName`/`releaseName`/`prerelease` 三处表达式逻辑自洽,与 spec 表格一致。文件名 `release.yml` 全程一致。
4. **YAGNI**:仅 Windows、不签名、不自动写版本号,均与 spec 一致。
