# dsh-power-switch

[English](README.md) | 中文

给 DeepSeek Harness（DSH）加一个**一键关闭**按钮，外加**启动方式切换**。

- **侧边栏页脚**里有一个 `⏻` 按钮：点一下（二次确认）关闭本机的 `dsh web` 进程。
  它走 DSH 自己的优雅退出通道（`ctx.appExit`），会话先落盘再退出。
- **设置 → 插件页**的卡片里有**一个切换按钮**：在「应用窗口 / 普通标签页」之间切换下次启动方式。
  点一次会做三件事：保存设置 → 自动改好桌面快捷方式 → 重启 DSH。

两个按钮各管一件事：侧边栏只管关闭，卡片只管切换。

## 平台

**仅 Windows。** `package.json` 的 `os` 就是 `["win32"]`，别的系统直接装不上。

原因很直接：应用窗口那半边依赖桌面快捷方式（Windows Script Host + `.lnk`），
非 Windows 上没有等价实现；关闭进程那半边其实是跨平台的（走 `ctx.appExit`，不碰 shell），
但我们不想让 macOS/Linux 用户装上以后发现核心功能是空的，所以干脆声明不支持。
以后要支持的话，得先补 `open`/`xdg-open`、macOS 浏览器路径和 `.desktop` 等价物。

## 安装

```sh
dsh plugin --profile web add <本包路径>
# 发布到 GitHub 之后：
dsh plugin --profile web add github:<你的名字>/dsh-power-switch
```

装完重启一次 DSH，然后打开 **设置 → 插件**：卡片在列表里（标签「DSH 电源按钮」），
侧边栏页脚也会出现 `⏻`。

> `dsh plugin` 会写 `$DSH_HOME/profiles/<profile>/`；如果 dsh 带着沙箱运行，请在普通终端里执行。
> 本包的 `lib/` 是随仓库一起提交的，所以从 GitHub 安装不需要任何构建步骤。

## 关闭进程

三个入口都能关，效果一样：侧边栏 `⏻`、卡片里的「关闭 DSH 进程」按钮、以及插件自己的
`POST /api/dsh-power-switch/shutdown` 路由。它们都会：

1. 先回答请求，再开始退出（所以页面能收到「已发出关闭请求」，超过 10 秒没有回应则报失败）；
2. 走优雅退出：会话与设置先落盘、插件树先卸载；
3. 万一优雅退出卡住，看门狗会在超时后强制结束进程。

`appExit` 是宿主在启动过程中逐步就绪的。极早期（服务刚起来、它还没注册）按下关闭，
插件会退回 `SIGTERM`——这是在日志里实测到过的（`no appExit service; sending SIGTERM to self`），
下一次读取就到手了。要"一定优雅"的话，等服务起来几秒再按。

**应用窗口**模式下，页面会在进程走后自动关掉自己；**普通标签页**不行——浏览器不允许页面关闭
「你自己打开」的标签页，所以卡片会提示按 **Ctrl+W**。这是浏览器的规则，不是插件没做。

## 启动方式：应用窗口 / 普通标签页

| | 应用窗口 | 普通标签页 |
|---|---|---|
| 打开方式 | Chromium 的 `--app=`（无地址栏、无标签栏） | 默认浏览器的一个标签页 |
| 关闭进程后 | **页面自己消失** | 需要你按 Ctrl+W |

卡片里点一次切换按钮就会：**保存设置 → 改好桌面快捷方式 → 立即重启 DSH**。
设置写进 `$DSH_HOME/settings.yaml` 的 `dsh-power-switch` 段，同时更新组合入口，
所以即使宿主的 settings 服务不可用，重启后也仍然按你选的方式打开。

**"无法安全重启"时它会拒绝，而不是把服务丢下。** 重启助手必须先向宿主证明"有人接手了"，
宿主才肯退出；证明来不了就返回 500 并继续服务。三种拒绝各有一句人话说明（卡片里直接显示）：

- 这个 DSH 不是以 `dsh web` 命令行启动的（例如桌面版）→ 无法重放启动命令；
- 重启助手没启动起来；
- 重启助手启动了但没有确认就位。

无论哪种，**关闭进程功能不受影响**，设置也已经保存下来了。

**桌面快捷方式会自动处理**（不用你手动改）：切到应用窗口时**接管**你已有的那个 DSH 图标
（没有就新建一个 `DSH 启动器`），切回标签页时**还原**成你原来的启动方式。原来的目标、参数、
图标与描述会先记进状态目录里的 `shortcut-backup.txt`，随时可还原。

### 为什么需要桌面快捷方式这一步

`dsh web` 自己会把 URL 交给**默认浏览器**，所以它永远开一个**标签页**：它没有 app 窗口选项，
那个 hand-off 还是用清空环境变量的平台 opener 启动的，插件拦不住。所以「下次启动用什么形态」
只能由**谁启动 dsh** 决定——本包的启动器 `scripts/launch-dsh.mjs`（外壳 `launch-dsh.vbs`）
负责：读设置里的模式 → 没在跑就按**记录下来的启动命令**起服务 → 等宿主打印 token → 按模式开窗口。

"按记录下来的启动命令"是关键：插件运行时会把自己是怎么被启动的（`process.execPath`、
argv、cwd）写进状态目录的 `boot.json`，启动器原样重放。早期版本是**拼**出来的
（`<检出目录>/apps/cli/lib/bin.js`），那只在源码检出里存在，别人机器上必然起不来。

也可以在命令行直接用（不经过快捷方式）：

```powershell
node scripts/launch-dsh.mjs          # 按设置里的模式
node scripts/launch-dsh.mjs --app    # 这次强制应用窗口
node scripts/launch-dsh.mjs --tab    # 这次强制标签页
node scripts/launch-dsh.mjs --cli D:\dsh\apps\cli\lib\bin.js   # 指定 CLI 入口
```

它不会重复启动：已经有宿主在跑就只开窗口；端口有人应答但找不到活着的 token 就**拒绝启动**
并说明原因，而不是硬起第二个。

## 状态与日志

运行时状态全部放在 **`$DSH_HOME/storages/dsh-power-switch/`**（不在包目录里）：

| 文件 | 内容 |
|---|---|
| `restart-dsh.log` | 插件、重启助手与监督进程共用的诊断日志 |
| `boot.json` | 最近一次宿主的启动命令（启动器与监督进程都用它） |
| `token-url.txt` | **宿主自己记下的本次认证 URL**——helper 与启动器靠它确认"哪个进程正在服务" |
| `node-path.txt` | **宿主正在用的 node.exe 路径**——两个 `.vbs` 外壳读它，所以 nvm/fnm/volta/Store 装的 Node 也能双击启动 |
| `dsh-web.<时间>.log` | 每次接管的宿主自己的 stdout（里面有本次的 token URL） |
| `shortcut-backup.txt` | 接管前的原始快捷方式，用于还原 |
| `shortcut-result.txt` | 最近一次快捷方式操作的原始结果 |

放在包外有两个原因：包可能装在只读的 store 里；而这份日志**带 token URL 和本机路径**，
写在包目录就等于写进版本库。

## 配置

卡片配置页，或 loader row 的 `config:`：

| 键 | 默认 | 说明 |
|---|---|---|
| `launchMode` | `tab` | 下次启动用什么窗口：`tab` / `app` |
| `delayMs` | `1000` | 收到关闭请求后等多少毫秒再退出（先把响应送出去） |
| `exitCode` | `0` | 进程退出码 |
| `hard` | `false` | 跳过优雅退出，直接强制结束 |

卡片按关闭按钮时请求的是 700ms（比默认更快让 UI 有反应），`delayMs` 是宿主的默认值。

环境变量：

- `DSH_POWER_SWITCH_NO_WINDOW=1`：让**这一次**启动不开窗口；
- `DSH_POWER_SWITCH_WINDOW_HANDLED=1`：表示窗口已由别人负责（启动器与监督进程会设它，
  插件看到就不再开第二个）；
- `DSH_POWER_SWITCH_CLI`：本机没记录过启动命令时，指向 `dsh` 的 CLI 入口；
- `DSH_POWER_SWITCH_PORT`：探活的端口（默认 3080）。
- 内部使用（助手与监督进程之间）：`DSH_POWER_SWITCH_LAUNCH_MODE`、`_DELAY`、`_HOST_LOG`、
  `_HANDSHAKE`。这些不是给你调的。

## 安全边界

四条路由（`GET /config`、`POST /shutdown`、`POST /restart`、`POST /shortcut`）的共同底线是
**只接受本机 loopback 请求**：对端必须是 `127.0.0.1`/`::1`，出现任何转发头（`forwarded`、
`x-forwarded-for`、`x-real-ip`、`x-forwarded-host`）一律拒绝。

**写**路由（`shutdown`/`restart`/`shortcut`）更严一档：`Origin` 必须与 `Host` 完全一致。
**读**路由 `GET /config` 允许缺 `Origin`（有些宿主自己发起请求时不带），但同样要求 loopback
且拒绝转发头——这一点与写路由不同，代码注释里写明了原因。

`POST /shortcut` 是唯一会在包外落文件的路由，所以它的请求体只允许一个**固定动作**
（`scan` / `install` / `restore`）——目录、文件名、目标与参数全部由宿主从自己的安装位置推导，
卡片一个都指定不了。

插件不读凭据、不联网、不访问会话内容。

## 开发

```sh
npm run build                            # 把 src/ 拷成 lib/
node scripts/run-tests.mjs               # 四个套件（node:test）
node scripts/verify-client-artifact.mjs  # 经真实 HTTP 取出 client.js 并渲染两个视图
node scripts/verify-live.mjs             # 给正在运行的 DSH 做体检
```

`client.js` 是手写的 lazy-CJS factory 产物（`window.__ModuleLoader__.load`），不需要构建步骤。
`tests/` 不随 npm 包发布，所以 `npm test` 要在检出目录里跑。四个套件：
`tests/host.test.mjs`（围栏、参数解析、调度器、路由、重启用命令）、
`tests/host-wiring.test.mjs`（插件装配与 `ctx.appExit`）、
`tests/client.test.mjs`（卡片注册与交互）、
`tests/package.test.mjs`（产物布局、`src`/`lib` 一致性、把生成的监督进程源码编译一遍）。

## 许可证

MIT
