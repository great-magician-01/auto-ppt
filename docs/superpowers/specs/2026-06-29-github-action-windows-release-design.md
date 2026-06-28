# GitHub Action 自动构建 Windows 安装包到 Release — 设计文档

日期:2026-06-29
状态:已批准,待写实现计划

## 目标

提交代码到 GitHub 时自动构建 Windows 安装包并发布到 Release,无需本地手动打包。满足"提交即出包",同时支持版本化正式发布。

## 背景

AutoPPT 是 Tauri 2 桌面应用(Windows)。当前 `npm run tauri build` 可本地构建,产出 NSIS `.exe` 和 MSI `.msi` 两种安装包(`tauri.conf.json` 中 `bundle.targets: "all"` 在 Windows 上同时产出两者)。`reqwest` 用 `rustls-tls`,无需 Windows runner 上预装 native OpenSSL。仓库目前无 `.github/` 目录,从零搭建。

## 触发策略(两条规则,一个 workflow 文件)

文件 `.github/workflows/release.yml`,在 `push` 上挂两个触发条件,互不重叠(分支推送与标签推送是 GitHub Actions 的独立事件):

- **提交主干 `main`** → 构建并覆盖更新名为 `latest` 的预发布(Pre-release)
- **打标签 `v*`(如 `v0.1.0`)** → 构建并创建正式 Release

放在同一个 `push` 触发器里是安全的。

## 构建任务

- 运行环境:`windows-latest`(只构建 Windows)
- 工具:`tauri-apps/tauri-action@v0`
  - 自动:checkout → 安装 Rust 工具链 → `npm ci` → 跑 `npm run tauri build` → 上传产物到对应 Release
- 产物:NSIS `.exe` + MSI `.msi`,两者都作为 Release 资产上传
- 权限:`contents: write`(创建/更新 Release 必需)

## 代码签名

不签名。零证书配置,CI 直接能跑。代价:用户首次安装时 Windows SmartScreen 会弹"Windows 已保护你的电脑"警告,需点"仍要运行"。个人项目/小范围分发可接受。

## Release 映射(根据触发类型分流)

通过 `if: startsWith(github.ref, 'refs/tags/')` 区分两种情况,设置不同参数:

| 触发 | tag 名 | releaseName | prerelease |
|---|---|---|---|
| push 到 main | `latest`(固定,每次覆盖) | `Latest Build` | true |
| push tag `v0.1.0` | `v0.1.0`(用所打的 tag) | `v0.1.0` | false(正式) |

`latest` 每次构建会覆盖更新,不累积历史版本;`v*` 标签各自形成独立的版本化 Release,保留历史。

## 使用方式

- **日常开发**:`git push` 到 main → 几分钟后在 Release 页面找 `latest`,内含最新 `.exe` / `.msi`
- **发正式版**:把 `tauri.conf.json` 和 `Cargo.toml` 的 `version` 改成与 tag 一致 → `git tag v0.1.0 && git push origin v0.1.0` → Release 页面出现版本化正式版

## 非目标(YAGNI)

- 不构建 macOS / Linux(当前只需 Windows)
- 不做代码签名(按用户选择)
- 不做多架构(仅 x64,`windows-latest` 默认)
- 不自动从 git tag 提取版本号写入配置文件(版本号由用户在发版前手动同步)
