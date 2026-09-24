# dsh-power-switch

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin providing two features:

- **Process shutdown**: a `⏻` button in the sidebar foot (with confirmation) that shuts down the local `dsh web` process through DSH's own graceful exit path, so sessions and settings are flushed first.
- **Launch mode switch**: a switch on the Settings -> Plugins card that selects how the next launch opens — an app window or a normal tab. A single press saves the setting, updates the desktop shortcut and restarts DSH.

## Platform support

Windows only. `package.json` declares `"os": ["win32"]`, so other platforms cannot install it.

App-window mode depends on a desktop shortcut (Windows Script Host and `.lnk`), for which there is no equivalent yet. The shutdown feature itself is platform-independent (it goes through `ctx.appExit` and never calls a shell), but shipping a plugin whose primary feature would silently degrade on macOS/Linux is worse than declaring no support. Adding it later requires `open`/`xdg-open`, macOS browser paths and a `.desktop` equivalent.

## Requirements

| Item | Requirement |
|---|---|
| Operating system | Windows 10 or later |
| DSH | `>=0.1.0-rc.6` (see `engines.dsh` in `package.json`) |
| Node.js | `>=20` |
| Windows Script Host | Required by the desktop-shortcut layer (`cscript.exe` / `wscript.exe`). It can be removed, or blocked by antivirus, Attack Surface Reduction rules or group policy — a locked-down machine is a real case, not a hypothetical one. When that happens the card says so in its own words, and the shutdown feature, the settings section and the mode switch are unaffected. |

## Install

Pin a released tag. The three commands below are exactly equivalent — they differ only in how DSH is invoked:

```powershell
# ① the `dsh` command is installed (npm global install, or the desktop app)
dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch#v1.1.2

# ② running from a source checkout that has been built (apps/cli/lib/bin.js exists)
#    run this from the checkout root
node apps\cli\lib\bin.js plugin --profile web add github:SanYe-SanJiu/dsh-power-switch#v1.1.2

# ③ running from a source checkout that is not built, or you prefer the TypeScript
#    sources — this is the form the upstream development documentation
#    (docs/user/develop/basic/publish.md) gives for a source checkout
#    run this from the checkout root
pnpm dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch#v1.1.2
```

All three entries are **exactly equivalent**, and every other command in this document can be substituted the same way (replace `dsh` with `node apps\cli\lib\bin.js` or `pnpm dsh`).

**Why the tag is part of the command.** A git install fetches the repository and runs the code it finds, and the upstream guide therefore asks authors and users to pin a commit `#<sha>`, "so a later push cannot silently change what runs". A released tag gives the same guarantee here — this project never moves one (see the notes below) — and reads better; substitute `#<commit-sha>` for the strictest form.

Other specs:

```powershell
# track the branch: resolves whatever `main` is at that moment. pnpm caches git
# installs by ref, so a repeated add is not guaranteed to refresh either
<entry> plugin --profile web add github:SanYe-SanJiu/dsh-power-switch

# from a local checkout (for development; link: keeps pointing at the checkout
# instead of copying it)
<entry> plugin --profile web add link:<absolute path to this checkout>
```

Notes:

- `--profile` is required. The Web UI profile is named `web` (`dsh web` is equivalent to `dsh --profile web`).
- `apps/cli/lib/bin.js` is `pnpm build` output and not a file in the repository, so a fresh clone uses form ③.
- The arguments after `add` are forwarded to pnpm verbatim, so an npm package name, a `github:owner/repo[#ref]` spec, a `link:path` and a tarball URL are all accepted. A relative path (`./x`, `../x`, `link:../x`) is resolved against the working directory the command is run from, not against the profile directory.
- Installation registers the bundle automatically: DSH appends the package to the profile's `dsh.profile.bundles` because the package declares `dsh.bundle.patch`, so no JSON editing is needed. A package without a bundle patch is reported as installed only as a plain dependency.
- The built host artifact `lib/` is committed with the repository, so a GitHub install needs no build step and never triggers pnpm's allowBuilds prompt.
- Releases are **append-only**: a fix ships as a new version (`1.1.1`, `1.1.2`, …) and a released tag is never moved, deleted and re-pointed, so a pinned install cannot change under the user's feet.
- The package carries its own display metadata, in the form DSH 0.1.7 reads it: `package.json.icon` (a manifest-relative SVG) and `locale/<language>.json` files whose `meta` block holds the title and description shown in the Plugins list. Both are exported (`./locale/*.json`) so the reader can resolve them; on earlier DSH versions the fields are simply ignored.

### When the install fails: two cases

**① `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`**

When the profile contains a plugin version younger than pnpm's release-age policy, pnpm verifies the entire lockfile before any change, which rejects every plugin operation, including uninstalling an unrelated plugin. Allow it for this one command:

```powershell
dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch --config.minimum-release-age=0
```

The spelling must be kebab-case: the camel-case form `--config.minimumReleaseAge=0` is silently ignored by pnpm >= 12.3, so the flag appears to be accepted while the error is unchanged. Running `pnpm clean --lockfile` as the message suggests is not recommended either: it re-resolves the whole profile and changes the other installed plugins with it.

**② A slow network**

A `github:` install fetches the entire repository, which can exceed pnpm's default 60-second fetch timeout. Add a second one-shot flag:

```powershell
dsh plugin --profile web add github:SanYe-SanJiu/dsh-power-switch --config.minimum-release-age=0 --config.fetchTimeout=600000
```

Restart DSH once after installing, then open **Settings -> Plugins**: a card labelled "DSH power button" appears in the list, and the `⏻` button appears in the sidebar foot.

### Verifying and uninstalling

- Verify: the profile's `dsh.profile.bundles` contains this plugin, and `node_modules\dsh-power-switch` is an ordinary directory (a local `link:` install is a symbolic link or junction).
- Uninstall: `dsh plugin --profile web remove dsh-power-switch`.
- Return to a local checkout: uninstall first, then run `dsh plugin --profile web add link:<absolute path to this checkout>`; both steps should carry the one-shot flag above.
- Do not install the GitHub build and a local `link:` build into the same profile: the package name is identical, so the later install replaces the earlier one.

> `dsh plugin` writes into `$DSH_HOME/profiles/web/`. If dsh runs under a sandbox, run it from an ordinary terminal.

## Shutdown

The sidebar `⏻`, the card's "Shut down DSH" button and the `POST /api/dsh-power-switch/shutdown` route behave identically:

1. The response is sent before the exit begins, so the page can report that shutdown was requested; no response within 10 seconds is reported as a failure.
2. The exit is graceful: sessions and settings are flushed, and the plugin tree is disposed.
3. If that disposal stalls, a watchdog forces the process to end when its deadline expires.

The `appExit` service becomes available progressively while the host boots. A shutdown triggered in the first moments, before that service is registered, falls back to `SIGTERM` (measured log line: `no appExit service; sending SIGTERM to self`). Where a graceful exit must be guaranteed, wait a few seconds after startup before shutting down.

In app-window mode the page closes itself once the process is gone. In normal-tab mode a browser refuses to let a page close a tab the user opened, so the card states to press **Ctrl+W**. That is a browser restriction, not a gap in the plugin.

## Launch mode: app window / normal tab

| | App window | Normal tab |
|---|---|---|
| Opened as | Chromium `--app=` (no address bar or tab strip) | a tab in the default browser |
| After a shutdown | the page closes itself | press Ctrl+W |

One press of the card's switch does three things: it saves the setting, updates the desktop shortcut, and restarts DSH. The setting is written to the `dsh-power-switch` section of `$DSH_HOME/settings.yaml` and to the composition entry as well, so the choice survives a restart even when the host serves no settings provider.

### It works on both settings models

DSH 0.1.7 replaced the plugin settings model: `ctx.settings` became a generated-forms service (`describe` / `update`) with no `register` / `installSection`, and `settings.yaml` was retired — it is imported into the active profile once and renamed. Neither change breaks this plugin:

- the persistence path is **detected, not version-sniffed**: a host that still has the registered-namespace API is written through its write scope, and a host that has the newer service is written through `update` for this plugin's own entry, found by its live value rather than by a guessed id;
- the choice is also recorded by the plugin itself, in `launch-mode.txt`, and every process that runs **outside** the host reads that record — the desktop launcher, the restart helper and the supervisor. So the mode survives a cold start even on a host whose settings document is gone, which is exactly the case where "I switched to the app window and the next start was a tab" would otherwise come back;
- the configuration form is the one thing that differs: on 0.1.7 it is the host's generated form for this plugin's entry, and when the host generates none the card's own controls still switch and record the mode.

### It refuses to restart when that cannot be done safely

The restart helper must first confirm the takeover to the host, and only then does the host exit; when that confirmation does not arrive, the route answers 500 and keeps serving. Three refusal reasons each have a dedicated line on the card:

- this DSH was not started as a `dsh web` command line (the desktop application, for example), so there is no launch command to replay;
- the restart helper could not be started;
- the restart helper started but never confirmed it was up.

In any of them the shutdown feature is unaffected and the setting has already been saved.

### Desktop shortcut

Switching to the app window adopts the existing DSH shortcut, or creates `DSH 启动器` when none exists; switching back to a normal tab restores the original launch method. The original target, arguments, icon and description are recorded in `shortcut-backup.txt` in the state directory, so the change can be undone at any time.

Why this layer is necessary: `dsh web` hands its URL to the default browser, so it always opens a tab. It has no app-window option, and that hand-off runs a platform opener with a scrubbed environment, so no plugin can intercept it. The window shape for the next launch can therefore only be chosen by whatever launches dsh — which is this package's launcher, `scripts/launch-dsh.mjs` (wrapped by `launch-dsh.vbs`). It reads the stored mode, starts the host with the recorded launch command when no host is running, waits for the token the host prints, and opens the window in that mode.

"Recorded launch command" means the plugin writes its own launch facts (`process.execPath`, argv, cwd) to `boot.json` in the state directory while it runs, and the launcher replays them verbatim. The earlier implementation rebuilt `<checkout>/apps/cli/lib/bin.js`, a path that exists only in a DSH source checkout and therefore failed under every other installation.

Two facts a cold start cannot guess are **derived or recorded, never assumed**. The port is read back from what the host wrote about itself: the authenticated URL of its last run, then a `--port` in the recorded command line, then the documented default; and the wait for the host's readiness line accepts any loopback port, so a DSH that serves on a non-default port is started and opened rather than waited on for two minutes at a port it never used. The harness home is written into the shortcut as `--home <dir>` and handed down as `DSH_HOME` (a variable that is already set wins), so a shortcut double-clicked from Explorer reads the same state directory as the host even when the person's own shell is the only place `DSH_HOME` was ever defined.

A launch that fails says so. The wrapper waits for the launcher, and a non-zero exit opens a message box with the exit code, the last lines of the log and the log path — a shortcut is double-clicked, and a wrapper that exits silently is indistinguishable from a shortcut that was never wired up.

The launcher can also be run directly:

```powershell
node scripts/launch-dsh.mjs                            # the mode from the setting
node scripts/launch-dsh.mjs --app                      # force an app window for this run
node scripts/launch-dsh.mjs --tab                      # force a normal tab for this run
node scripts/launch-dsh.mjs --cli <path to the dsh CLI entry>   # name the CLI entry
```

The launcher never starts a duplicate instance: when a host is already serving it only opens the window, and when the port answers but no live token can be obtained it refuses to start and reports why.

## State and logs

Runtime state lives in **`$DSH_HOME/storages/dsh-power-switch/`**, never inside the package:

| File | Contents |
|---|---|
| `restart-dsh.log` | Diagnostic log shared by the plugin, the restart helper and the supervisor |
| `boot.json` | The most recent host launch command (used by the launcher and the supervisor) |
| `token-url.txt` | The authenticated URL the host recorded for the current run (how the helper and the launcher identify the serving process) |
| `launch-mode.txt` | The mode the next launch should use, recorded by the plugin itself. It is what a cold start reads on a DSH whose settings document no longer exists (0.1.7), and an explicit settings document always wins over it |
| `settings.json` | The advanced settings changed from the card (`delayMs`, `exitCode`, `hard`); they override the loader row's `config:` |
| `node-path.txt` | The node.exe path the host is running on; both `.vbs` wrappers read it, so a Node installed through nvm/fnm/volta or an app store can still launch DSH from the shortcut |
| `dsh-web.<stamp>.log` | The stdout of each host this plugin started, including that run's token URL |
| `shortcut-backup.txt` | The original shortcut recorded before it was adopted, for restoring it |
| `shortcut-result.txt` | The raw result of the most recent shortcut operation |

State is kept outside the package for two reasons: the package may sit in a read-only store, and the log contains authenticated token URLs and local paths, so a log inside the package would be a log inside the repository.

## Configuration

The card's configuration page, or the loader row's `config:`:

| Key | Default | Meaning |
|---|---|---|
| `launchMode` | `tab` | Window for the next launch: `tab` or `app` |
| `delayMs` | `1000` | Milliseconds to wait after answering before exiting |
| `exitCode` | `0` | Process exit code |
| `hard` | `false` | Skip the graceful path and end the process at once |

`launchMode` is switched from the card. The other three are edited from the card's own **Advanced settings** block, which writes them to `settings.json` in the state directory. That block exists because it is the only UI for those three on a DSH that generates settings forms (0.1.7) — a plugin without a declared schema gets no generated form, so without it they would be editable only by hand-editing the profile patch. On a host that still has the registered-namespace settings API, the same save is written to the settings document as well, so the two surfaces cannot disagree; the recorded value is the one that governs, and deleting `settings.json` hands the decision back to the loader row's `config:` and the settings document.

The card's shutdown button requests 700 ms so the interface reacts sooner; `delayMs` is the host's own default.

Environment variables:

| Variable | Meaning |
|---|---|
| `DSH_POWER_SWITCH_NO_WINDOW=1` | Do not open a window for this launch |
| `DSH_POWER_SWITCH_WINDOW_HANDLED=1` | Another process is opening this launch's window; the launcher and the supervisor set it, and the plugin then opens no second window |
| `DSH_POWER_SWITCH_CLI` | The `dsh` CLI entry, for a machine with no recorded launch command |
| `DSH_POWER_SWITCH_PORT` | Port to probe (default 3080) |
| `DSH_POWER_SWITCH_LAUNCH_MODE`, `_DELAY`, `_HOST_LOG`, `_HANDSHAKE` | Internal interface between the helper and the supervisor; no configuration needed |

## Security boundary

All five routes (`GET /config`, `POST /shutdown`, `POST /restart`, `POST /shortcut`, `POST /settings`) share one floor: loopback requests only. The peer must be `127.0.0.1`/`::1`, and any forwarding header (`forwarded`, `x-forwarded-for`, `x-real-ip`, `x-forwarded-host`) is refused.

The write routes (`shutdown`/`restart`/`shortcut`/`settings`) additionally require `Origin` to match `Host` exactly. The read route `GET /config` accepts a missing `Origin`, because some hosts issue their own requests without it, while still requiring loopback and still refusing forwarding headers; that difference is documented in the code.

`POST /shortcut` is the only route that produces a file outside the package, so its body accepts exactly one fixed action (`scan` / `install` / `restore`); the directory, file name, target and arguments are all derived by the host from its own installation location, and the client cannot choose any of them.

The plugin reads no credentials, makes no network requests and never touches session content.

Two boundaries are worth stating plainly rather than leaving to be discovered:

- **`boot.json` is a trust boundary.** The restart replays the command line the running host recorded for itself, verbatim — that is the whole design, and it is why no installation path is ever reconstructed. Anyone who can write the state directory can therefore have that command executed with your privileges. That is not a privilege escalation (the same is true of `settings.yaml`, the profile's plugin list, and every other file the harness reads), and it is exactly why the state directory lives inside your user profile and never inside the package. Treat write access to `$DSH_HOME` as equivalent to running code as yourself.
- **The authenticated `?token=…` URL is a local access credential.** It is written in exactly two places, both under `$DSH_HOME/storages/dsh-power-switch/`: the host's own stdout log (`dsh-web.<stamp>.log`), which is how a replacement host is identified, and `token-url.txt`. Every diagnostic line that would repeat it is redacted to `?token=***` — including the wrapper log in `%TEMP%`, which a desktop shortcut writes. Do not paste those two files anywhere public.

## Development

```sh
npm run build                            # copy src/ to lib/ (the host-half artifact)
node scripts/run-tests.mjs               # the four suites (node:test)
node scripts/verify-client-artifact.mjs  # fetch client.js over real HTTP and render both views
node scripts/verify-live.mjs             # health-check a running DSH
```

`client.js` is a hand-written lazy-CJS factory artifact (`window.__ModuleLoader__.load`) and needs no build step. `tests/` is not published with the npm package, so `npm test` runs from a checkout. The suites are `tests/host.test.mjs` (request fence, argument parsing, scheduler, routes, relaunch command), `tests/host-wiring.test.mjs` (plugin assembly and `ctx.appExit`), `tests/client.test.mjs` (card registration and interaction) and `tests/package.test.mjs` (artifact layout, `src`/`lib` agreement, compiling the generated supervisor source).

## License

MIT
