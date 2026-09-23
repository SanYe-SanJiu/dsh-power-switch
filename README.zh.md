# dsh-power-switch

[English](README.md) | 中文

DeepSeek Harness（DSH）插件，提供两项功能：

- **关闭进程**：侧边栏页脚的 `⏻` 按钮（二次确认）经 DSH 自身的优雅退出通道关闭本机 `dsh web` 进程，会话与设置先落盘。
- **启动方式切换**：设置 → 插件页卡片上的切换按钮，在「应用窗口 / 普通标签页」之间切换下次启动方式。单次点击完成：保存设置 → 更新桌面快捷方式 → 重启 DSH。

## 平台支持

仅支持 Windows。`package.json` 声明 `"os": ["win32"]`，其他平台无法安装。

应用窗口模式依赖桌面快捷方式（Windows Script Host 与 `.lnk`），当前没有等价实现。关闭进程功能本身不依赖平台（通过 `ctx.appExit`，不调用 shell），但为避免在 macOS/Linux 上安装后核心功能静默失效，本包明确声明不支持；后续如需支持，需补充 `open`/`xdg-open`、macOS 浏览器路径与 `.desktop` 等价实现。

## 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10 或更高 |
| DSH | `>=0.1.0-rc.6`（见 `package.json` 的 `engines.dsh`） |
| Node.js | `>=20` |

## 安装

先按 DSH 的运行方式选一条命令，再按需替换包规格：

```powershell
# ① 已安装 dsh 命令（npm 全局安装或桌面版）
dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch

# ② 从源码检出运行，且检出已构建（存在 apps/cli/lib/bin.js）
#    需在检出根目录执行
node apps\cli\lib\bin.js plugin --profile web add github:SanYe-SanJiu/dsh-power-switch

# ③ 从源码检出运行，未构建或希望直接跑 TypeScript 源码
#    需在检出根目录执行；官方开发文档（docs/user/develop/basic/publish.md）
#    对源码检出的写法就是这条
pnpm dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch
```

三种入口**完全等价**，本文其余命令都可照此替换（把 `dsh` 换成 `node apps\cli\lib\bin.js` 或 `pnpm dsh`）。包规格部分可换成：

```powershell
# 指定提交：git 安装由 pnpm 缓存，重复 add 不保证刷新；指定提交也可复现
<入口> plugin --profile web add github:SanYe-SanJiu/dsh-power-switch#<commit-sha>

# 从本地检出安装（用于开发；link: 保持指向检出目录，不复制）
<入口> plugin --profile web add link:<本包检出的绝对路径>
```

说明：

- `--profile` 为必填项；Web UI 对应的 profile 名为 `web`（`dsh web` 等价于 `dsh --profile web`）。
- `apps/cli/lib/bin.js` 是 `pnpm build` 的产物、不在仓库中，因此刚克隆的检出用 ③。
- `add` 之后的参数原样转发给 pnpm，因此 npm 包名、`github:owner/repo[#ref]`、`link:路径` 与 tarball URL 均可使用。相对路径（`./x`、`../x`、`link:../x`）以执行命令时的工作目录为基准解析，而非以 profile 目录为基准。
- 安装完成后，DSH 会自动将该包加入 profile 的 `dsh.profile.bundles`（该包声明了 `dsh.bundle.patch`），无需手工编辑 JSON。未声明 bundle patch 的包会收到"仅作为普通依赖安装"的提示。
- 仓库中包含构建产物 `lib/`，因此从 GitHub 安装不需要构建步骤，也不会触发 pnpm 的 allowBuilds 拦截。

### 安装失败时的两种情形

**① `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`**

profile 中存在发布未满 pnpm 等待期的插件版本时，pnpm 会在任何改动前校验整个锁文件，导致所有插件操作被拒绝（包括卸载其他插件）。可对本次命令放行：

```powershell
dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch --config.minimum-release-age=0
```

必须使用连字符拼写：驼峰形式 `--config.minimumReleaseAge=0` 在 pnpm ≥ 12.3 中会被静默忽略，开关看似生效但报错不变。另不建议按提示执行 `pnpm clean --lockfile`，该命令会重新解析整个 profile，一并更换其他插件版本。

**② 网络较慢**

`github:` 安装需拉取整个仓库，可能超过 pnpm 默认 60 秒的抓取超时。追加第二个一次性开关：

```powershell
dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch --config.minimum-release-age=0 --config.fetchTimeout=600000
```

安装完成后重启一次 DSH，打开 **设置 → 插件**：列表中会出现标签为「DSH 电源按钮」的卡片，侧边栏页脚会出现 `⏻`。

### 安装校验与卸载

- 校验：profile 的 `dsh.profile.bundles` 中包含本插件，且 `node_modules\dsh-power-switch` 为普通目录（本地 `link:` 安装为符号链接或 junction）。
- 卸载：`dsh plugin --profile web remove dsh-power-switch`。
- 切换回本地检出：先卸载，再执行 `dsh plugin --profile web add link:<本包检出的绝对路径>`；两步均建议附带上述一次性开关。
- 同一 profile 中不要同时安装 GitHub 版本与本地 `link:` 版本：包名相同，后安装者会替换先安装者。

> `dsh plugin` 会写入 `$DSH_HOME/profiles/web/`；若 dsh 运行于沙箱环境，请在普通终端中执行。

## 关闭进程

侧边栏 `⏻`、卡片中的「关闭 DSH 进程」按钮，以及 `POST /api/dsh-power-switch/shutdown` 路由，三者行为一致：

1. 先返回响应，再开始退出（页面因此能收到「已发出关闭请求」；超过 10 秒无响应则报告失败）；
2. 走优雅退出：会话与设置先落盘，插件树先卸载；
3. 若优雅退出停滞，看门狗在超时后强制结束进程。

`appExit` 服务在宿主启动过程中逐步就绪。服务刚启动、该服务尚未注册时触发关闭，插件会退回 `SIGTERM`（实测日志为 `no appExit service; sending SIGTERM to self`）。如需确保优雅退出，可在启动数秒后再执行关闭。

应用窗口模式下，进程退出后页面自动关闭；普通标签页模式下，浏览器不允许页面关闭由用户打开的标签页，因此卡片提示按 **Ctrl+W**。这属于浏览器行为限制。

## 启动方式：应用窗口 / 普通标签页

| | 应用窗口 | 普通标签页 |
|---|---|---|
| 打开方式 | Chromium `--app=`（无地址栏与标签栏） | 默认浏览器的标签页 |
| 关闭进程后 | 页面自动关闭 | 需按 Ctrl+W |

卡片上的切换按钮一次点击完成三件事：保存设置、更新桌面快捷方式、重启 DSH。设置写入 `$DSH_HOME/settings.yaml` 的 `dsh-power-switch` 段，同时更新组合入口，因此宿主的 settings 服务不可用时，重启后仍按所选方式打开。

### 无法安全重启时会拒绝执行

重启助手必须先向宿主确认接管，宿主才会退出；确认未到达时，路由返回 500 并继续提供服务。三种拒绝原因分别对应卡片上的一条说明：

- 当前 DSH 不是以 `dsh web` 命令行方式启动（例如桌面版），无法重放启动命令；
- 重启助手未能启动；
- 重启助手已启动但未确认就位。

任一情形下，关闭进程功能不受影响，且设置已经保存。

### 桌面快捷方式

切换到应用窗口时接管已有的 DSH 快捷方式（不存在时新建 `DSH 启动器`），切回普通标签页时还原为原有启动方式。接管前的目标、参数、图标与描述记录在状态目录的 `shortcut-backup.txt` 中，可随时还原。

需要这一层的原因：`dsh web` 将 URL 交给默认浏览器，因此始终打开标签页；它没有应用窗口选项，且该交接由使用清空环境变量的平台 opener 启动，插件无法拦截。因此「下次启动的窗口形态」只能由启动 dsh 的一方决定，即本包提供的启动器 `scripts/launch-dsh.mjs`（外壳 `launch-dsh.vbs`）：读取设置中的模式 → 未运行服务时按记录的启动命令启动 → 等待宿主输出 token → 按模式打开窗口。

「按记录的启动命令」指插件运行时将自身的启动信息（`process.execPath`、argv、cwd）写入状态目录的 `boot.json`，启动器原样重放。早期实现为拼接 `<检出目录>/apps/cli/lib/bin.js`——该路径仅存在于 DSH 源码检出中，其他安装方式下必然失败。

冷启动无法自行得知的两项事实，一律**推导或记录，绝不假设**。端口取自宿主自己写下的记录：上次运行记录的认证 URL，其次为记录的启动命令中的 `--port`，最后才是文档中的默认值；等待宿主就绪信号时不限定端口，因此在非默认端口上服务的 DSH 会被正常启动并打开窗口，而不是在它从未使用过的端口上空等两分钟后失败。DSH home 作为 `--home <目录>` 写入快捷方式，并由外壳下传为 `DSH_HOME`（环境中已有该变量时以环境为准），因此从资源管理器双击快捷方式时，读取的状态目录与宿主一致——即使 `DSH_HOME` 只在该用户自己的终端里定义过。

启动失败会明确报出。外壳会等待启动器结束，退出码非 0 时弹出对话框，显示退出码、日志末尾与日志路径：快捷方式是被双击的，而静默退出的外壳与「快捷方式根本没接上」在现象上无法区分。

启动器也可直接在命令行使用：

```powershell
node scripts/launch-dsh.mjs                            # 按设置中的模式
node scripts/launch-dsh.mjs --app                      # 本次强制应用窗口
node scripts/launch-dsh.mjs --tab                      # 本次强制普通标签页
node scripts/launch-dsh.mjs --cli <dsh CLI 入口路径>    # 指定 CLI 入口
```

启动器不会重复启动实例：已有宿主在运行时仅打开窗口；端口有响应但无法获取有效 token 时拒绝启动并输出原因。

## 状态与日志

运行时状态位于 **`$DSH_HOME/storages/dsh-power-switch/`**，不在包目录内：

| 文件 | 内容 |
|---|---|
| `restart-dsh.log` | 插件、重启助手与监督进程共用的诊断日志 |
| `boot.json` | 最近一次宿主的启动命令（启动器与监督进程使用） |
| `token-url.txt` | 宿主记录的本次认证 URL（助手与启动器据此确认服务进程） |
| `node-path.txt` | 宿主当前使用的 node.exe 路径；两个 `.vbs` 外壳读取该文件，因此经 nvm/fnm/volta 或应用商店安装的 Node 也可由快捷方式启动 |
| `dsh-web.<时间戳>.log` | 由本插件启动的各次宿主的 stdout（包含该次运行的 token URL） |
| `shortcut-backup.txt` | 接管前的原始快捷方式，用于还原 |
| `shortcut-result.txt` | 最近一次快捷方式操作的原始结果 |

状态文件置于包外的原因：包可能位于只读存储中；且日志包含认证 token URL 与本机路径，写入包目录等同于写入版本库。

## 配置

卡片配置页，或 loader row 的 `config:`：

| 键 | 默认值 | 说明 |
|---|---|---|
| `launchMode` | `tab` | 下次启动的窗口形态：`tab` / `app` |
| `delayMs` | `1000` | 收到关闭请求后等待多少毫秒再退出（用于先送出响应） |
| `exitCode` | `0` | 进程退出码 |
| `hard` | `false` | 跳过优雅退出，直接结束进程 |

卡片的关闭按钮请求 700ms（使界面更快响应）；`delayMs` 为宿主的默认值。

环境变量：

| 变量 | 说明 |
|---|---|
| `DSH_POWER_SWITCH_NO_WINDOW=1` | 本次启动不打开窗口 |
| `DSH_POWER_SWITCH_WINDOW_HANDLED=1` | 窗口已由其他进程负责；启动器与监督进程会设置该项，插件不再打开第二个窗口 |
| `DSH_POWER_SWITCH_CLI` | 未记录启动命令时，指定 `dsh` 的 CLI 入口 |
| `DSH_POWER_SWITCH_PORT` | 探活端口（默认 3080） |
| `DSH_POWER_SWITCH_LAUNCH_MODE`、`_DELAY`、`_HOST_LOG`、`_HANDSHAKE` | 助手与监督进程之间的内部接口，无需设置 |

## 安全边界

四条路由（`GET /config`、`POST /shutdown`、`POST /restart`、`POST /shortcut`）的共同要求是仅接受本机 loopback 请求：对端必须为 `127.0.0.1`/`::1`；出现任何转发头（`forwarded`、`x-forwarded-for`、`x-real-ip`、`x-forwarded-host`）一律拒绝。

写路由（`shutdown`/`restart`/`shortcut`）额外要求 `Origin` 与 `Host` 完全一致。读路由 `GET /config` 允许缺少 `Origin`（部分宿主自身发起的请求不带该头），但仍要求 loopback 并拒绝转发头；该差异在代码注释中说明。

`POST /shortcut` 是唯一会在包外产生文件的路由，其请求体只接受一个固定动作（`scan` / `install` / `restore`）；目录、文件名、目标与参数均由宿主根据自身安装位置推导，客户端无法指定。

插件不读取凭据、不进行网络请求、不访问会话内容。

## 开发

```sh
npm run build                            # 将 src/ 复制为 lib/（宿主半产物）
node scripts/run-tests.mjs               # 四个测试套件（node:test）
node scripts/verify-client-artifact.mjs  # 经真实 HTTP 获取 client.js 并渲染两个视图
node scripts/verify-live.mjs             # 对运行中的 DSH 做健康检查
```

`client.js` 为手写的 lazy-CJS factory 产物（`window.__ModuleLoader__.load`），无需构建步骤。`tests/` 不随 npm 包发布，因此 `npm test` 需在检出目录中执行。测试套件：`tests/host.test.mjs`（请求围栏、参数解析、调度器、路由、重启用命令）、`tests/host-wiring.test.mjs`（插件装配与 `ctx.appExit`）、`tests/client.test.mjs`（卡片注册与交互）、`tests/package.test.mjs`（产物布局、`src`/`lib` 一致性、生成的监督进程源码编译）。

## 许可证

MIT
