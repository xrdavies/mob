# 发布与公开下载（macOS、Windows、Linux）

源码仓库可以保持私有。mobd 在独立的 [mobd 仓库](https://github.com/xrdavies/mobd)，
其签名、安装器和发布配置见该仓库的 [发布文档](https://github.com/xrdavies/mobd/blob/main/docs/releases.md)。
本仓库的 GitHub Actions 构建 mob 桌面应用（macOS 版签名并公证），GitHub
Release 保存构建产物；发布正式 Release 后，独立工作流将产物上传到 Cloudflare
R2，用户通过自定义域名下载。官网在同级目录 `../mob-site`，由 GitHub Pages 构建和部署。

macOS 总是发布；Windows 和 Linux 只在仓库变量 `RELEASE_WINDOWS` / `RELEASE_LINUX` 为 `true`
时构建和发布（构建与 R2 发布都读取这两个变量，开启的平台缺任何文件都会失败）。从 v0.5.1 起
开启这两个仓库变量，发布三个平台。所有平台共用同一个版本号、同一个 Tauri 更新密钥：

| 平台 | 构建任务 | 下载文件 | 应用内更新 |
| --- | --- | --- | --- |
| macOS 13+ · Apple Silicon | `app`（macos-15） | `mob_X.Y.Z_darwin_arm64.dmg` | `.app.tar.gz` |
| Windows 10/11 · x64 | `windows`（windows-2022） | `mob_X.Y.Z_windows_x64-setup.exe`（NSIS，安装到当前用户） | 同一个 `-setup.exe` |
| Linux x64（Ubuntu 22.04+） | `linux`（ubuntu-22.04） | `mob_X.Y.Z_linux_x64.AppImage`、`.deb` | 仅 AppImage；deb 用户手动下载新版 |

Windows 安装程序**暂未做 Authenticode 签名**，首次运行时 SmartScreen 会提示“未知发布者”；
更新包仍由 Tauri 更新密钥签名校验。以后加签名只需在 `windows` 任务里增加签名步骤。
不提供 Intel Mac、arm64 Windows/Linux 或 iPhone 安装包。更新源只有 R2。

`ci.yml` 检查每次推送到 `main` 和指向 `main` 的 PR（类型检查、测试、前端构建，macOS 上编译并测试 Rust 端），不产出文件。
`build.yml`（Test builds）手动运行（Actions → Test builds → Run workflow），可从任意分支构建未签名的
macOS、Windows、Linux 测试包（Actions 构建产物，保留 14 天），用于在发布前试装；它不需要任何密钥，也不发布。
未签名的 macOS 应用首次打开会被拦截：右键 Mob.app → 打开，或运行 `xattr -dr com.apple.quarantine Mob.app`。

## 1. 准备 Cloudflare R2

1. 创建专用发布桶，例如 `mob-releases`。桶内只存放允许公开下载的文件。
2. 在桶的 **Settings → Custom Domains** 绑定下载域名 `dl.mymob.dev`（与 mobd 共用），
   确认状态为 Active。
3. 创建限定到该桶的 **Object Read & Write** R2 API 凭据，保存 Access Key ID
   和 Secret Access Key。上传使用 S3 API；最终用户不需要任何令牌。
4. 不使用 `r2.dev` 作为正式下载地址，不在下载域名启用登录验证或浏览器挑战。
5. 不需要配置 CORS：官网在构建时读取发布清单，浏览器不直接请求 R2 的 JSON；
   Tauri 原生更新请求和 curl 也不依赖 CORS。

### 缓存规则

发布器为版本路径设置 `Cache-Control: public, max-age=31536000, immutable`，
为可变入口设置 `Cache-Control: no-store`。在 Cloudflare Cache Rules 中：

- `/mob/v*/*`、`/mobd/v*/*` 可缓存，尊重对象的缓存头。
- `/mob/latest.json`、`/mobd/latest.json`、两端的 `releases.json` 和
  `/mobd/install.sh` **绕过缓存**。不要用全站长 TTL 覆盖它们。
- 首次验证前不要缓存缺失文件的 404；调整缓存规则后清理旧缓存。

官方参考：[R2 公共访问](https://developers.cloudflare.com/r2/buckets/public-buckets/)、
[R2 缓存](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)、
[S3 CLI 上传](https://developers.cloudflare.com/r2/examples/aws/aws-cli/)。
工作流已设置 AWS CLI classic transfer client 及按需 checksum，以兼容 R2。

## 2. GitHub Actions 配置清单

在 **Settings → Environments** 创建 `release` 环境，允许版本标签和可信手动运行。
以下所有值配置在该环境中；不要提交到 Git，也不要粘贴到公开日志。

### Secrets

| 名称 | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | 包含私钥的 Developer ID Application `.p12` 文件的 Base64 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| `APPLE_SIGNING_IDENTITY` | 完整签名身份，例如 `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | 公证使用的 Apple 账号 |
| `APPLE_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | 10 位 Apple Developer Team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri 更新私钥文件的完整内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 更新私钥密码 |
| `R2_ACCESS_KEY_ID` | 限定到发布桶的 R2 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | 对应的 R2 Secret Access Key |
| `SITE_DISPATCH_TOKEN` | 可选。能向 `xrdavies/mob-site` 发送 `repository_dispatch` 的令牌；R2 发布后触发官网重建。未配置时官网在每小时构建时获取新版本 |

### Variables

| 名称 | 内容 |
| --- | --- |
| `TAURI_UPDATER_PUBLIC_KEY` | Tauri 更新公钥文件的完整内容 |
| `DOWNLOAD_BASE_URL` | `https://dl.mymob.dev`；不能含路径、认证信息或查询参数 |
| `R2_ACCOUNT_ID` | Cloudflare 的 32 位账户 ID |
| `R2_BUCKET` | 发布桶名称，如 `mob-releases` |
| `RELEASE_WINDOWS` / `RELEASE_LINUX` | **仓库级** Variable（Settings → Secrets and variables → Actions → Variables；任务级 `if` 读不到 environment 变量）。从 v0.5.1 起均设为 `true`，构建并发布 Windows 和 Linux |

`TAURI_UPDATER_PUBLIC_KEY` 和 `DOWNLOAD_BASE_URL` 是公开配置，也支持存为同名
Secret，与 mobd 的下载域名读取方式一致。构建和 R2 发布均优先读取 Variable，
为空时读取 Secret；只需配置一处。R2 发布对 `R2_ACCOUNT_ID` 和 `R2_BUCKET` 也支持
同名 Secret。mobd 仓库需要单独配置自己的 `release` 环境，GitHub 不会在仓库间复制；
Apple/R2 凭据可以复用，Tauri 更新密钥只在 mob 配置。

Apple 证书与 Tauri 更新密钥是独立的。导出证书并生成更新密钥：

```bash
openssl base64 -A -in /path/to/DeveloperID.p12 -out /tmp/apple-certificate.txt
security find-identity -v -p codesigning
mkdir -p ~/.tauri
npm run tauri -- signer generate -w ~/.tauri/mob.key
```

私钥应有离线备份，每个版本沿用同一 Tauri 公钥/私钥。`GITHUB_TOKEN` 自动提供，
构建工作流的 Release 步骤需要 `contents: write`，R2 发布流程只需要 `contents: read`。
Apple 凭据缺失或签名、公证失败时不会发布未签名替代品。

## 3. 构建和发布

配置好 `release` 环境后，在 **mob 仓库根目录**运行。需要 Node.js 24+、Git 和
`origin` 的推送权限；证书和更新私钥由 CI 读取，本机不需要安装，也不需要 GitHub CLI。
先提交并推送要发布的修改，让本地 `main` 与远端一致：

```bash
git switch main
git pull --ff-only
# 如果有本地提交，先执行 git push origin main
make version          # 当前版本（package.json 等）、上一个发布标签和之后的提交
make release-patch    # 0.3.1 → 0.3.2；新功能用 release-minor，不兼容的改动用 release-major
```

版本号以版本文件为准：`make release-*` 在它的基础上递增，标签只是它的镜像。
需要跳号或修正版本时，用 `make release VERSION=vX.Y.Z` 指定版本（必须高于已有标签）。脚本 `.github/release/tag.mjs` 会：

1. 校验 `vMAJOR.MINOR.PATCH` 格式，不接受预发布后缀或带前导零的版本。
2. 要求当前分支为 `main`，工作区和暂存区干净（包括未跟踪文件）。
3. 在线读取 `origin/main` 和版本标签，确认当前提交已经推送、没有落后远端。
4. 拒绝本地或远端已有的标签、低于远端已有稳定标签的版本，以及已经发布过的提交。
   `make release-*` 还要求版本文件一致，且不落后于远端最新标签（否则用 `VERSION=` 指定）。
5. 显示「当前 → 新版本」和上一个标签之后的提交，询问 `[y/N]`；回答 `y` 才继续，其他回答不做任何修改。
6. 把版本写入 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`，提交 `chore(release): vX.Y.Z`（文件已是该版本时不提交）。
7. 在该提交创建附注标签，用 `git push --atomic` 同时推送 `main` 和标签，触发 **Release mob**。
   推送被拒时两者都不会到达 GitHub，本地提交和标签保留，按提示重试。

CI 检查 `main` 上的版本文件一致；**Release mob** 在构建前确认标签提交的版本文件与标签一致，不一致时直接失败。

也可以直接运行 `node .github/release/tag.mjs patch` 或 `… v0.1.0`。除版本提交外，脚本不合并或推送其他提交；
安装包版本仍由 CI 根据标签注入并校验。测试、打包和签名在
Actions 中执行。本地可先运行 `make check`；只测试发布工具使用 `make release-test`。

推送标签成功表示构建请求已提交，**不表示构建或公开发布已经完成**。
到仓库的 Actions 页面查看 **Release mob**；也可以手动运行它，
填写已存在的稳定标签。
`.github/workflows/release.yml` 将标签解析到的提交用于桌面端 macOS 构建：

- mob：运行前端测试，构建 arm64 `Mob.app` 和 `.dmg`，Apple 签名、公证并检查
  stapled ticket；生成 Tauri 签名的 `.app.tar.gz` 及 `.sig`。
- 开启 `RELEASE_WINDOWS` / `RELEASE_LINUX` 时另外构建 Windows 安装程序和 Linux AppImage/`.deb`；
  未开启时这些任务显示为 skipped，不影响发布。
- 收集桌面文件、生成 `SHA256SUMS`，创建或更新**草稿** GitHub Release。
  `mob_release.json` 记录构建时的公开更新配置，供发布阶段核对域名和版本。

检查草稿中的文件，在单独的 Mac 上试装，确认能与当前发布的 mobd 配对、对话、打开实时桌面，
并编辑面向最终用户的 release notes：用英文（官网是英文），只用纯文本、`**粗体**`、链接和换行，
它们会显示在官网下载页和应用内更新提示。不要直接把包含私有 PR 链接的自动生成说明当作公开产品文案。
之后在 GitHub 的 Releases 页面打开该草稿，点击 **Publish release**，
保持 **Set as a pre-release** 未勾选。脚本不会自动发布草稿。

`.github/workflows/publish-r2.yml` 的 **Publish mob downloads to R2** 自动执行：

1. 下载已发布 Release 的产物，验证 `SHA256SUMS`。
2. 验证发布域名与构建时嵌入 App 的更新域名一致。
3. 生成 mob 的 `release.json` 和校验文件。
4. 拒绝覆盖内容不同的版本文件，拒绝把 stable 指向更低版本。
5. 上传缺少的版本文件，经公开 HTTPS 下载并重新校验全部文件。
6. 最后更新 `mob/releases.json` 和 `mob/latest.json`。
7. 配置了 `SITE_DISPATCH_TOKEN` 时触发官网重建；失败不影响发布。

也可以手动运行发布工作流，输入已发布的 `vX.Y.Z`，用于重试或补发。
同一仓库的 R2 发布任务串行执行；本仓库只读写 `mob/`。完全相同的文件允许重试；已发布文件或说明变化时需要新版本。
如果中途失败，已上传的版本文件保留供重试；重新运行会继续完成。更高版本发布后不再补发旧版本。
mobd 仓库独立维护 `mobd/`，两个产品的版本号和发布时间不需要一致。

使用普通账号或 GitHub 网页发布 Release 可以触发此流程；由工作流的默认
`GITHUB_TOKEN` 发布的事件不会自动触发另一个工作流，此时手动运行 R2 发布流程。
私有 GitHub Release 是内部构建记录，用户只使用公开 R2 地址。

等 R2 工作流成功后，打开 `${DOWNLOAD_BASE_URL}/mob/latest.json` 确认版本，
并用其中的 `download.url` 下载 DMG。用上一个已安装版本执行一次应用内更新（A → B）验证。
0.2.0 起应用包名为 `Mob.app`（之前为 `mob.app`），bundle ID 和更新地址不变；从 0.0.x 更新后确认应用
能正常启动、机器和配对保留。

### 失败与重试

- 本地检查失败：根据提示处理工作区、分支或版本；此时尚未写入版本、提交或创建标签。
- 版本文件格式不符（例如 `package.json` 不是 2 空格缩进）：脚本在写入前停止，工作区保持干净；修正后重试。
- 推送失败：`main` 和标签是原子推送，二者都不会到达远端；本地保留版本提交和标签。先用
  `git ls-remote origin refs/tags/v0.1.0` 查看远端；若没有该标签，修复网络或权限后执行脚本提示的
  `git -c push.followTags=false push --atomic origin main refs/tags/v0.1.0:refs/tags/v0.1.0`。
  若远端 `main` 已有新提交导致被拒：`git tag -d v0.1.0 && git reset --hard origin/main`，
  再重新运行 `make release`。若标签已在远端，查看 Actions；不要重新创建或强制移动已推送的标签。
- 构建、签名或公证失败：修正 GitHub 环境配置后，在 Actions 重跑失败任务，
  或手动运行 **Release mob**，使用原标签。
- 需要修改代码：提交并推送修改，使用新的更高版本标签。
- R2 发布失败：手动运行 **Publish mob downloads to R2**，填写已发布的原标签；
  保持产物和发布说明不变。已公开版本的内容变化需要新版本。

### R2 文件结构

```text
mob/
  v0.1.0/
    mob_0.1.0_darwin_arm64.dmg
    mob_0.1.0_darwin_arm64.app.tar.gz
    mob_0.1.0_darwin_arm64.app.tar.gz.sig
    SHA256SUMS
    release.json
  latest.json
  releases.json
```

两个仓库分别打 `vX.Y.Z` 标签，各自构建自己的产品并维护清单和历史。官网构建时读取
`releases.json`（当前下载和历史记录），不依赖私有 GitHub API；`latest.json` 供应用内更新使用。

## 4. Tauri updater

构建时生成的配置包含：

```json
{
  "version": "0.1.0",
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "Tauri 更新公钥的完整内容",
      "endpoints": ["https://dl.mymob.dev/mob/latest.json"]
    }
  }
}
```

`latest.json` 与该版本的 `release.json` 相同，保留 Tauri 的标准字段：

```json
{
  "version": "0.1.0",
  "notes": "本次更新说明",
  "pub_date": "2026-10-14T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://dl.mymob.dev/mob/v0.1.0/mob_0.1.0_darwin_arm64.app.tar.gz",
      "signature": "生成的 .sig 文件内容，不是 URL",
      "sha256": "更新包的 SHA-256"
    }
  },
  "download": {
    "url": "https://dl.mymob.dev/mob/v0.1.0/mob_0.1.0_darwin_arm64.dmg",
    "sha256": "DMG 的 SHA-256"
  },
  "checksums_url": "https://dl.mymob.dev/mob/v0.1.0/SHA256SUMS"
}
```

Tauri 使用 `.app.tar.gz` 和更新签名；网站用 `download` 提供 DMG。
额外字段也供安装器和网站复用。更新源及下载全程使用 HTTPS，不嵌入 GitHub 或 R2 令牌。

App 启动时检查更新，Settings → About 可以手动重试。用户确认后安装并重启；当前
可见任务运行中或提交中禁止安装。下载或签名失败不会重启。开发版未配置更新源时显示
当前版本和未配置提示，不请求更新插件。浏览器预览不执行原生更新。

发布验收必须安装签名版本 A，再发布更高版本 B，实际验证检查、下载、验签、安装、
重启及离线重试。修改静态清单到较低版本不会让已安装客户端自动降级；修复应发布更高版本。
官方协议：[Tauri updater](https://v2.tauri.app/plugin/updater/)。

## 5. 官网部署

`../mob-site` 是独立的静态网站项目（Astro + Tailwind，英文），包含首页、下载、快速开始、隐私政策和
404 页，部署在 https://mymob.dev 。无域名时可本地预览；生产构建要求 `SITE_URL`。

官网由 GitHub Pages 部署（`../mob-site/.github/workflows/pages.yml`）：推送 `main`、每小时
一次，以及收到发布工作流的 `release-published` 事件时重新构建。仓库 Variables：

| 名称 | 用途 |
| --- | --- |
| `SITE_URL` | 官网 HTTPS 根地址 |
| `DOWNLOAD_BASE_URL` | 与 mob 发布流程相同的 R2 下载根地址 |
| `IOS_APP_URL` | 可选：App Store 或 TestFlight 链接 |

构建时读取各产品的 `releases.json`。没有版本时显示尚未发布；网络失败时显示获取失败，
不生成假下载链接。官网自己的构建/部署文档位于 `../mob-site/README.md`。

## 首次发布验收清单

- [ ] R2 下载域名已生效；可公开访问，不触发登录/浏览器挑战。
- [ ] 缓存规则区分版本文件和动态入口。
- [ ] `release` 环境的 10 个必需 Secrets、4 项公开配置完整（公钥和下载域名可存为同名 Secret）；可选 `SITE_DISPATCH_TOKEN`。
- [ ] `RELEASE_WINDOWS` / `RELEASE_LINUX` 符合本次计划（目前都不设置）。
- [ ] `make release-patch`（或 `-minor`、`-major`、`VERSION=vX.Y.Z`）成功：`main` 上有 `chore(release)` 提交，标签已推送。
- [ ] 生成并备份 Tauri 密钥，Apple 签名/公证检查通过。
- [ ] 在其他 Apple Silicon Mac 上试装草稿中的 DMG，并与当前 mobd 配对使用。
- [ ] Release 正文已改为面向用户的英文说明。
- [ ] 发布 GitHub 稳定 Release，确认 R2 工作流完成。
- [ ] 无 GitHub 登录的设备可下载桌面 DMG 和更新包。
- [ ] 官网下载页显示新版本、DMG 链接和更新说明；初次配置能完成连接。
- [ ] 下一个版本执行一次实际的 Tauri A → B 更新验证。
