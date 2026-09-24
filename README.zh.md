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
| Windows 脚本宿主 | 桌面快捷方式层需要 `cscript.exe` / `wscript.exe`。它可能被移除，或被杀毒软件、攻击面缩减（ASR）规则、组策略拦截——受管控的机器上这是真实情形，不是假设。遇到这种情况卡片会明确说明，而关闭进程、设置表单与模式切换本身不受影响。 |

## 安装

你应该先cd到deepseek harness文件夹

下面三条命令完全等价，区别只在"如何调用 DSH"：

```powershell
# ① 已安装 dsh 命令（npm 全局安装或桌面版）
dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch#v1.1.3

# ② 从源码检出运行，且检出已构建（存在 apps/cli/lib/bin.js）
#    需在检出根目录执行
node apps\cli\lib\bin.js plugin --profile web add github:SanYe-SanJiu/dsh-power-switch#v1.1.3

# ③ 从源码检出运行，未构建或希望直接跑 TypeScript 源码
#    需在检出根目录执行；官方开发文档（docs/user/develop/basic/publish.md）
#    对源码检出的写法就是这条
pnpm dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch#v1.1.3
```

三种入口**完全等价**，本文其余命令都可照此替换（把 `dsh` 换成 `node apps\cli\lib\bin.js` 或 `pnpm dsh`）。


其它写法：

```powershell
# 跟随分支：安装时解析当时的 main。pnpm 按 ref 缓存 git 安装，重复 add 也不保证刷新
<入口> plugin --profile web add github:SanYe-SanJiu/dsh-power-switch

# 从本地检出安装（用于开发；link: 保持指向检出目录，不复制）
<入口> plugin --profile web add link:<本包检出的绝对路径>
```

说明：

- `--profile` 为必填项；Web UI 对应的 profile 名为 `web`（`dsh web` 等价于 `dsh --profile web`）。
- `apps/cli/lib/bin.js` 是 `pnpm build` 的产物、不在仓库中，因此刚克隆的检出用 ③。
- `add` 之后的参数原样转发给 pnpm，因此 npm 包名、`github:owner/repo[#ref]`、`link:路径` 与 tarball URL 均可使用。相对路径（`./x`、`../x`、`link:../x`）以执行命令时的工作目录为基准解析，而非以 profile 目录为基准。
- 安装完成后，DSH 会自动将该包加入 profile 的 `dsh.profile.bundles`（该包声明了 `dsh.bundle.patch`），无需手工编辑 JSON。未声明 bundle patch 的包会收到"仅作为普通依赖安装"的提示。
- 仓库中包含构建产物 `lib/`，因此从 GitHub 安装不需要构建步骤，也不会触发 pnpm 的 allowBuilds 拦截。
- 发布遵循**只加不改**：修复以新版本号发布（`1.1.1`、`1.1.2`…），已发布的 tag 绝不移动、删除后重指，因此钉住的安装不会在使用者脚下变化。
- 包自带展示元数据，格式按 DSH 0.1.7 的读法：`package.json.icon`（清单相对路径的 SVG）与 `locale/<语言>.json` 里的 `meta` 块（插件列表显示的标题与简介）。两者都通过 `exports` 导出（`./locale/*.json`）以便解析器取到；更早的 DSH 版本会直接忽略这些字段。

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
- 卸载：`dsh plugin --profile web remove dsh-power-switch`。桌面快捷方式不依赖包，因此无需先做任何还原——但若当前是应用窗口模式，想让原有启动方式立刻回来，就先在卡片里切回普通标签页再卸载。否则下一次双击图标就会自动完成：快捷方式所指的副本发现包已不在，会把原快捷方式放回去并弹窗说明。状态目录中的 `restore-shortcut.vbs` 是同一件事的手动入口。
- 切换回本地检出：先卸载，再执行 `dsh plugin --profile web add link:<本包检出的绝对路径>`；两步均建议附带上述一次性开关。
- 同一 profile 中不要同时安装 GitHub 版本与本地 `link:` 版本：包名相同，后安装者会替换先安装者。

> `dsh plugin` 会写入 `$DSH_HOME/profiles/web/`；若 dsh 运行于沙箱环境，请在普通终端中执行。

## 关闭进程

侧边栏 `⏻`、卡片中的「关闭 DSH 进程」按钮，以及 `POST /api/dsh-power-switch/shutdown` 路由，三者行为一致。两个控件都会先弹出确认框，而确认框里同时提供**重启**选项（行为见[重启](#重启)）：

1. 先返回响应，再开始退出（页面因此能收到「已发出关闭请求」；超过 10 秒无响应则报告失败）；
2. 走优雅退出：会话与设置先落盘，插件树先卸载；
3. 若优雅退出停滞，看门狗在超时后强制结束进程。

`appExit` 服务在宿主启动过程中逐步就绪。服务刚启动、该服务尚未注册时触发关闭，插件会退回 `SIGTERM`（实测日志为 `no appExit service; sending SIGTERM to self`）。如需确保优雅退出，可在启动数秒后再执行关闭。

应用窗口模式下，进程退出后页面自动关闭；普通标签页模式下，浏览器不允许页面关闭由用户打开的标签页，因此卡片提示按 **Ctrl+W**。这属于浏览器行为限制。

## 重启

重启是两个电源控件弹出的确认框中的第三个选项（取消 / **重启 DSH** / 关闭），也是"切换启动方式"这一动作的最后一步；当你只想替换掉即将被取代的那次启动时，它同样可以单独使用：

```powershell
# 双击 scripts\restart-dsh-web.vbs，或直接运行脚本
node scripts\restart-dsh-web.mjs --delay-seconds 3
```

确认框里的选项与脚本都走 `POST /api/dsh-power-switch/restart`；确认框**不携带模式**，因此它按当前已配置的模式重启——只替换进程，不碰桌面快捷方式。

手动入口会在宿主**实际服务的端口**上停掉它，按记录的启动命令重新启动，等待该次运行输出的 token URL，然后证明本插件的浏览器半已进入新宿主提供的启动图。`--port N` 可覆盖它工作的端口、`--cli <入口>` 可在没有记录的机器上指定 CLI；`--open` / `--app` 可在之后打开窗口。

两个入口共用一条规则：替代进程必须先**确认自己就位**，宿主才被允许退出；确认不到时宿主继续服务，并在响应里说明原因——明确拒绝永远好过服务再也起不来。"记录的启动命令"指什么、以及哪些情形会直接拒绝，见[启动方式](#启动方式应用窗口--普通标签页)一节，同一套规则适用于这个入口。

## 启动方式：应用窗口 / 普通标签页

| | 应用窗口 | 普通标签页 |
|---|---|---|
| 打开方式 | Chromium `--app=`（无地址栏与标签栏） | 默认浏览器的标签页 |
| 关闭进程后 | 页面自动关闭 | 需按 Ctrl+W |

卡片上的切换按钮一次点击完成三件事：保存设置、更新桌面快捷方式、重启 DSH。设置写入 `$DSH_HOME/settings.yaml` 的 `dsh-power-switch` 段，同时更新组合入口，因此宿主的 settings 服务不可用时，重启后仍按所选方式打开。

### 两代设置模型都能用

DSH 0.1.7 更换了插件设置模型：`ctx.settings` 变成生成式表单服务（`describe` / `update`），不再有 `register` / `installSection`；同时 `settings.yaml` 退役——它会被一次性导入当前 profile 并改名。这两项变化都不会破坏本插件：

- 持久化路径是**探测出来的，不靠版本号猜**：宿主若仍有"注册命名空间"那套 API，就通过其写作用域写入；若只有新服务，则通过 `update` 写入**本插件自己的条目**——该条目按"活动配置的形状"匹配，而不是猜一个 id；
- 选择同时由插件自己记录在 `launch-mode.txt`，而所有**运行在宿主之外**的进程（桌面启动器、重启助手、监督进程）都读这份记录。因此即使宿主的设置文档已不存在，模式依然能跨冷启动保留——否则"切成应用窗口，下次启动却又是标签页"就会重现；
- 唯一有差异的是设置界面：0.1.7 的表单由 Loader 条目声明的 schema 生成，而本插件未声明 schema，因此那里没有属于本插件的原生设置页。插件可配置的一切都在卡片上——启动方式开关与高级设置。

### 无法安全重启时会拒绝执行

重启助手必须先向宿主确认接管，宿主才会退出；确认未到达时，路由返回 500 并继续提供服务。三种拒绝原因分别对应卡片上的一条说明：

- 当前 DSH 不是以 `dsh web` 命令行方式启动（例如桌面版），无法重放启动命令；
- 重启助手未能启动；
- 重启助手已启动但未确认就位。

任一情形下，关闭进程功能不受影响，且设置已经保存。

### 桌面快捷方式

切换到应用窗口时接管已有的 DSH 快捷方式（不存在时新建 `DSH 启动器`），切回普通标签页时还原为原有启动方式。接管前的目标、参数、图标与描述记录在状态目录的 `shortcut-backup.txt` 中，可随时还原。

快捷方式指向的**不是包内的启动器，而是状态目录里的副本** `shortcut-launch.vbs`——它每次启动都会写在那里，与上述记录和 `restore-shortcut.vbs` 放在一起。一个"插件一卸载就失效"的图标不值得放到桌面上，所以图标所指向的文件必须是卸载动不了的那个。双击它时：

1. **插件还在**——harness home 下的某个 profile **在其清单里仍列着它**（`<profile>\package.json` 的 `dsh.profile.bundles`，即宿主加载插件的那个列表），并且该 profile 里存在 `<profile>\node_modules\dsh-power-switch\scripts\launch-dsh.vbs`。副本把本次启动收到的参数原样交给那个启动器、等待并回传其退出码。实际启动路径仍是 `launch-dsh.mjs`（外壳 `launch-dsh.vbs`），因此正常启动毫无变化；旧版本接管过的图标也会在下次启动时被改指到这个副本。
2. **插件已不在**——没有任何 profile 再列着它，于是通过 `restore-shortcut.vbs` 重放记录：快捷方式回到本插件从未碰过它的样子（若是本插件新建的则删除），并弹出一个对话框说明。再双击一次，就按你原来的方式启动 DSH。

判定以**清单**为准，既不是"记录下来的那条路径"，也不是"那个目录还在不在"——这两点都是实测出来的，不是假设。`link:` 安装被卸载时，清单会被改写，但 `node_modules` 里的 junction 会留下来；因此"启动器文件仍能解析"并不能证明插件还装着，把它当成证据正是"图标继续启动一个已卸载的插件、还原永远不发生"的成因。早期版本写下的记录路径有同样的失效方式，所以启动时会把它删掉。

本次启动究竟属于哪个 harness home，**靠查而不是靠选定**：环境变量 `DSH_HOME`、快捷方式携带的 `--home`、默认的 `~/.dsh` 会逐个搜索，看谁的 profile 清单里仍列着本插件，找到的那个即为准，并且**导出的也是它**，这样外壳读到的状态目录与被执行的启动器属于同一个 home。因此"快捷方式建好之后 `DSH_HOME` 又变了"不会让已安装的插件看起来像被卸载，图标也就不会在插件还在时装作插件已消失。

这一层里没有任何写死的路径。`shortcut-launch.vbs` 用的是自身所在目录、上面那个 home、DSH 的 `profiles` 目录（CLI 解析 `--profile` 用的同一个常量）以及 `<profile>\node_modules\<包名>`——即 pnpm 放置直接依赖、且 DSH 明确说明"pnpm 管理的条目保持权威"的位置。`restore-shortcut.vbs` 用的是自身所在目录，其次 `%DSH_HOME%`，再其次 `%USERPROFILE%\.dsh`；它改写的 `.lnk` 就是记录里那一个。`make-shortcut.vbs` 向 shell 询问 `Desktop` 而不是自行拼接（因此重定向过的、非英文的桌面同样可用），写入的目标是 `%SystemRoot%\System32\wscript.exe` 并带回退的裸文件名。这些全部在运行时推导，任何用户名、盘符或目录下的安装行为一致。

这些对话框**用使用者所用 Windows 的语言显示**——因为它就是一个 Windows 对话框：脚本读取 `HKCU\Control Panel\International\LocaleName`，读不到就退回英文；`DSH_POWER_SWITCH_LANG=zh|en` 可覆盖两者。译文放在状态目录的 `shortcut-messages.txt` 里，而不是脚本内部，因为脚本存不下它：wscript 按 ANSI 读取 `.vbs`，中文写进去会变成乱码；而把脚本改成 UTF-16 又会让它在版本库里变成无法审阅的二进制。表里**不重复英文**：英文就是各个调用点里写着的文本，也是键或整个文件缺失时的回退。

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
| `launch-mode.txt` | 下次启动应使用的模式，由插件自身记录。宿主设置文档已不存在时（0.1.7）冷启动读的就是它；设置文档有明确取值时以文档为准 |
| `node-path.txt` | 宿主当前使用的 node.exe 路径；两个 `.vbs` 外壳读取该文件，因此经 nvm/fnm/volta 或应用商店安装的 Node 也可由快捷方式启动 |
| `dsh-web.<时间戳>.log` | 由本插件启动的各次宿主的 stdout（包含该次运行的 token URL） |
| `shortcut-backup.txt` | 接管前的原始快捷方式，用于还原 |
| `shortcut-launch.vbs` | 被接管的快捷方式实际指向的启动器，每次启动刷新。仍有 profile 承载插件时，把启动交给该 profile 的包内启动器；不再有时依据记录还原原快捷方式。放在包外正是关键 |
| `shortcut-messages.txt` | 两个 `.vbs` 辅助脚本的对话框文本（英文之外的语言），格式为 `键.语言=文本`。UTF-16：`.vbs` 按 ANSI 读取，中文写进脚本会变成乱码 |
| `restore-shortcut.vbs` | 修复脚本的副本，每次启动时写入。双击后依据 `shortcut-backup.txt` 还原快捷方式并删除该记录；`shortcut-launch.vbs` 以 `/quiet` 调用它并自行报告结果 |
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

`launchMode` 由卡片切换；其余三项在卡片自带的**高级设置**块里修改，写入状态目录的 `settings.json`。该块存在的原因：在生成式设置表单的 DSH（0.1.7）上，未声明 schema 的插件拿不到任何表单，没有它这三项就只能手改 profile patch。若宿主仍提供"注册命名空间"那套设置 API，同一次保存也会写入设置文档，使两个界面不会各说各话；最终以记录值为准，删除 `settings.json` 即把决定权交回 loader row 的 `config:` 与设置文档。

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

五条路由（`GET /config`、`POST /shutdown`、`POST /restart`、`POST /shortcut`、`POST /settings`）的共同要求是仅接受本机 loopback 请求：对端必须为 `127.0.0.1`/`::1`；出现任何转发头（`forwarded`、`x-forwarded-for`、`x-real-ip`、`x-forwarded-host`）一律拒绝。

写路由（`shutdown`/`restart`/`shortcut`/`settings`）额外要求 `Origin` 与 `Host` 完全一致。读路由 `GET /config` 允许缺少 `Origin`（部分宿主自身发起的请求不带该头），但仍要求 loopback 并拒绝转发头；该差异在代码注释中说明。

`POST /shortcut` 是唯一会在包外产生文件的路由，其请求体只接受一个固定动作（`scan` / `install` / `restore`）；目录、文件名、目标与参数均由宿主根据自身安装位置推导，客户端无法指定。

插件不读取凭据、不进行网络请求、不访问会话内容。

有两条边界应当明确写出，而不是等人踩到：

- **`boot.json` 是一条信任边界。** 重启链路会**原样重放**运行中宿主为自己记录的命令行——这正是设计本身，也是它从不重建安装路径的原因。因此，任何能写入状态目录的人都能让该命令以你的权限执行。这不是权限提升（`settings.yaml`、profile 的插件清单，以及宿主读取的任何其它文件同理），而这恰恰是状态目录位于用户配置文件内、绝不放进包目录的原因。请把"可写 `$DSH_HOME`"视同"可以你的身份执行代码"。还有两个文件同属这条边界：`shortcut-launch.vbs` 与 `restore-shortcut.vbs` 每次启动都从包内刷新，且本就设计为被执行（桌面快捷方式启动的就是前者），因此能写入状态目录的人可以在这两个名下放入别的东西——启动副本只会启动"某个 profile 解析出的那个启动器"，修复副本只会依据记录字段改写 `.lnk`，但仍应按"用户配置文件里的可执行文件"对待。
- **带认证的 `?token=…` URL 是本地访问凭据。** 它只写在两处，都在 `$DSH_HOME/storages/dsh-power-switch/` 下：宿主自身的 stdout 日志（`dsh-web.<时间戳>.log`，替代进程据此确认服务进程）与 `token-url.txt`。任何会重复它的诊断行都脱敏为 `?token=***`——包括桌面快捷方式写入 `%TEMP%` 的外壳日志。请勿将这两个文件贴到公开场合。

## 开发

```sh
npm run build                            # 将 src/ 复制为 lib/（宿主半产物）
node scripts/run-tests.mjs               # tests/ 下的全部套件（node:test），其中一套会在真实的 Windows Script Host 上执行修复脚本
node scripts/verify-client-artifact.mjs  # 经真实 HTTP 获取 client.js 并渲染两个视图
node scripts/verify-live.mjs             # 对运行中的 DSH 做健康检查
```

`client.js` 为手写的 lazy-CJS factory 产物（`window.__ModuleLoader__.load`），无需构建步骤。`tests/` 不随 npm 包发布，因此 `npm test` 需在检出目录中执行。测试套件：`tests/host.test.mjs`（请求围栏、参数解析、调度器、路由、重启用命令）、`tests/host-wiring.test.mjs`（插件装配与 `ctx.appExit`）、`tests/client.test.mjs`（卡片注册与交互）、`tests/package.test.mjs`（产物布局、`src`/`lib` 一致性、生成的监督进程源码编译）。

## 许可证

MIT
