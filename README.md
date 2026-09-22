# dsh-power-switch

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin that adds a **one-click shutdown** button, plus a
**launch-mode switch**.

- A `⏻` button in the **sidebar foot**: one press (confirmed) shuts this machine's
  `dsh web` process down. It goes through DSH's own graceful exit (`ctx.appExit`), so
  sessions flush to disk first.
- **One switch button** on the **Settings -> Plugins** card toggles how the *next*
  launch opens: app window or normal tab. One press saves the setting, fixes the
  desktop shortcut and restarts DSH.

Two buttons, two jobs: the sidebar only shuts down, the card only switches.

## Platform

**Windows only.** `package.json` declares `"os": ["win32"]`, so nothing else installs it.

The reason is the launch-mode half: app windows depend on a desktop shortcut, which is
Windows Script Host plus `.lnk`, and there is no equivalent here yet. The shutdown half
is genuinely portable (it goes through `ctx.appExit` and never touches a shell), but
shipping a plugin whose headline feature silently degrades on macOS/Linux would be worse
than refusing to install. Supporting them later means adding `open`/`xdg-open`, macOS
browser paths and a `.desktop` equivalent.

## Install

```powershell
# from GitHub (recommended)
dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch

# from a local checkout, when you are editing the code
# (`link:` keeps pointing at the checkout instead of copying it)
dsh plugin --profile web add link:../dsh-power-switch
```

- `--profile` is **required**; the Web UI profile is `web` (`dsh web` means `dsh --profile web`).
- The arguments after `add` are **forwarded to pnpm verbatim**, so an npm name, a
  `github:owner/repo` spec, a `link:path` and a tarball URL all work. A relative path
  (`./x`, `../x`, `link:../x`) is resolved against the directory you RUN the command in,
  not against the profile directory.
- Installation registers the bundle for you: DSH appends the package to the profile's
  `dsh.profile.bundles` because it declares `dsh.bundle.patch`, so **no JSON editing**.
  A package without a bundle patch gets a warning that it is only a plain dependency.
- `lib/` is committed with this repository, so a GitHub install needs **no build step** —
  and therefore never trips pnpm's allowBuilds prompt.

Restart DSH once, then open **Settings -> Plugins**: the card is in the list (labelled
"DSH power button"), and the `⏻` button appears in the sidebar foot.

> Uninstall with `dsh plugin --profile web remove dsh-power-switch`.
> `dsh plugin` writes into `$DSH_HOME/profiles/web/`; if dsh runs under a sandbox, run it
> from an ordinary terminal. And do **not** install the GitHub copy into a profile that
> already links your development checkout — the package name is the same, so the second
> install replaces the first.

## Shutting down

Three entries do the same thing: the sidebar `⏻`, the card's "Shut down DSH" button,
and the plugin's own `POST /api/dsh-power-switch/shutdown` route. All of them:

1. answer the request first and only then start leaving (the page has a 10 s deadline,
   and reports a failure when nothing answers);
2. leave gracefully: sessions and settings flush, the plugin tree disposes;
3. still force an exit if that disposal stalls -- a watchdog ends the process.

`appExit` becomes available as the host boots. Pressing shutdown in the first moments —
before it is registered — falls back to `SIGTERM`; that fallback was measured firing
(`no appExit service; sending SIGTERM to self`), and the next read found the service.
Wait a few seconds after start if a graceful exit has to be guaranteed.

In **app-window** mode the page closes itself once the process is gone. An **ordinary
tab** cannot: a browser refuses to let a page close a tab that YOU opened, so the card
says to press **Ctrl+W**. That is the browser's rule, not a gap here.

## Launch mode: app window / normal tab

| | App window | Normal tab |
|---|---|---|
| Opened as | Chromium `--app=` (no address bar, no tab strip) | a tab in the default browser |
| After a shutdown | **the page disappears by itself** | you press Ctrl+W |

One press of the card's switch does three things: **save the setting, fix the desktop
shortcut, restart DSH**. The setting lands in `dsh-power-switch` under
`$DSH_HOME/settings.yaml` and in the composition entry as well, so the choice survives
even when the host serves no settings provider.

**When it cannot restart safely, it refuses instead of risking an outage.** The helper
must first prove to the host that somebody is taking over, and only then does the host
leave; if that proof never arrives the route answers 500 and the service keeps running.
Three refusals, each explained in the card in your own language:

- this DSH was not started as a `dsh web` command line (the desktop app, for example),
  so there is no command to replay;
- the relaunch helper could not be started;
- the helper started but never confirmed it was up.

In every one of them **shutting down still works**, and the setting is already saved.

**The desktop shortcut is handled for you**: switching to the app window **adopts** the
DSH icon you already have (or creates a `DSH 启动器` when there is none), and switching
back to a tab **restores** your original launch method. The original target, arguments,
icon and description are recorded in `shortcut-backup.txt` in the state directory first.

### Why the shortcut matters

`dsh web` hands its URL to the **default browser**, so it always opens a **tab**: it has
no app-window flag, and that hand-off runs a platform opener with a scrubbed
environment, so no plugin can intercept it. The window shape can therefore only be
chosen by **whatever launches dsh** -- which is this package's launcher,
`scripts/launch-dsh.mjs` (wrapped by `launch-dsh.vbs`). It reads the stored mode, starts
the host with the **recorded launch command** when nothing is running, waits for the
token URL, and opens the window in that mode.

"Recorded" is the point: while the plugin runs, the host writes down how it was started
(`process.execPath`, argv, cwd) into `boot.json` in the state directory, and the launcher
replays that verbatim. The earlier version *rebuilt* it as
`<checkout>/apps/cli/lib/bin.js`, which exists only in a DSH source checkout and
therefore started nothing on anybody else's machine.

It also runs from a terminal, without any shortcut:

```powershell
node scripts/launch-dsh.mjs          # whatever the setting says
node scripts/launch-dsh.mjs --app    # force an app window for this run
node scripts/launch-dsh.mjs --tab    # force a tab for this run
node scripts/launch-dsh.mjs --cli D:\dsh\apps\cli\lib\bin.js   # name the CLI entry
```

It never starts a duplicate: if a host is already serving it only opens the window, and
if the port answers without a live token it **refuses** and says why instead of starting
a second one.

## State and logs

All runtime state lives in **`$DSH_HOME/storages/dsh-power-switch/`**, never in the
package:

| File | What it holds |
|---|---|
| `restart-dsh.log` | the shared diagnostic log of the plugin, the helper and the supervisor |
| `boot.json` | the running host's launch command (used by the launcher and the supervisor) |
| `token-url.txt` | **the host's own record of this run's authenticated URL** — how the helper and the launcher prove which process is serving |
| `node-path.txt` | **the node.exe the host is running on** — read by both `.vbs` wrappers, so a Node from nvm/fnm/volta/Store can still launch DSH from a shortcut |
| `dsh-web.<stamp>.log` | the stdout of each host this plugin started (it carries that run's token URL) |
| `shortcut-backup.txt` | the original shortcut, so an adopted one can be put back |
| `shortcut-result.txt` | the raw result of the last shortcut operation |

Outside the package for two reasons: an installed package can sit in a store that
refuses writes, and the log carries authenticated `?token=…` URLs and this machine's
paths — inside the package those go straight into the repository.

## Configuration

The card's configuration page, or the loader row's `config:`:

| Key | Default | Meaning |
|---|---|---|
| `launchMode` | `tab` | Window for the next launch: `tab` or `app` |
| `delayMs` | `1000` | Milliseconds to wait after answering before exiting |
| `exitCode` | `0` | Process exit code |
| `hard` | `false` | Skip the graceful path and end the process at once |

The card's shutdown button asks for 700 ms (so the UI reacts sooner); `delayMs` is the
host's own default.

Environment variables:

- `DSH_POWER_SWITCH_NO_WINDOW=1` -- do not open a window for *this* launch;
- `DSH_POWER_SWITCH_WINDOW_HANDLED=1` -- somebody else is opening this launch's window
  (the launcher and the supervisor set it; the plugin then stays quiet);
- `DSH_POWER_SWITCH_CLI` -- the `dsh` CLI entry, for a machine that has no recorded
  launch command yet;
- `DSH_POWER_SWITCH_PORT` -- the port to probe (default 3080).
- Internal, between the helper and the supervisor: `DSH_POWER_SWITCH_LAUNCH_MODE`,
  `_DELAY`, `_HOST_LOG`, `_HANDSHAKE`. Not knobs for users.

## Security boundary

All four routes (`GET /config`, `POST /shutdown`, `POST /restart`, `POST /shortcut`)
share one floor: **loopback only**. The peer must be `127.0.0.1`/`::1`, and any
forwarding header (`forwarded`, `x-forwarded-for`, `x-real-ip`, `x-forwarded-host`) is
refused.

The **write** routes (`shutdown`/`restart`/`shortcut`) go one step further: `Origin` must
equal `Host`. The **read** route `GET /config` accepts a missing `Origin` — some hosts
issue their own requests without one — while still requiring loopback and still refusing
forwarding headers. That difference is deliberate and documented in the code.

`POST /shortcut` is the only route whose effect lands outside the package, so its body
may carry exactly one **fixed action** (`scan` / `install` / `restore`) -- the directory,
file name, target and arguments are all derived by the host from its own install
location, and the card cannot choose any of them.

The plugin reads no credentials, makes no network calls, and never touches session
content.

## Development

```sh
npm run build                            # copies src/ to lib/ (the host-half artifact)
node scripts/run-tests.mjs               # the four suites (node:test)
node scripts/verify-client-artifact.mjs  # serve client.js over HTTP and render both views
node scripts/verify-live.mjs             # health-check a running DSH
```

`client.js` is a hand-written lazy-CJS factory artifact
(`window.__ModuleLoader__.load`) and needs no build step. `tests/` is not published, so
`npm test` runs from a checkout. The suites are `tests/host.test.mjs` (fence, request
parsing, scheduler, routes, relaunch command), `tests/host-wiring.test.mjs` (plugin
assembly and `ctx.appExit`), `tests/client.test.mjs` (card registration and interaction)
and `tests/package.test.mjs` (artifact layout, `src`/`lib` agreement, and compiling the
generated supervisor source).

## License

MIT
