/**
 * The two window-mode helpers the restart SUPERVISOR needs.
 *
 * They used to live in `restart-from-inside.mjs` while being called only from
 * inside `supervisorSource()` -- a template string, and therefore a different
 * scope. Both calls threw `ReferenceError` in the generated supervisor, at the
 * one point where the only remaining work was choosing a window: after it had
 * already checked in and spawned the replacement. It died silently, opened no
 * window at all, and the person saw their previous tab reconnect and concluded
 * "the mode did not change".
 *
 * They live in a real module for one reason: code the supervisor runs must be
 * importable, syntax-checkable, and impossible to define in the wrong scope.
 * Nothing here may import the helper.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The DeepSeek Harness home directory.
 *
 * Mirrors the harness's own rule (`@deepseek-ai/dsh-home-paths`): an explicit
 * `$DSH_HOME` wins, a blank one counts as UNSET, and the default is `~/.dsh`.
 * The version this replaces read `USERPROFILE` directly — Windows-only, and
 * wherever that variable is missing it produced the RELATIVE path `.dsh`, so a
 * restart read a settings file that did not exist and silently dropped the
 * stored window mode. `~` is expanded because a user who writes
 * `DSH_HOME=~/.dsh` means their home directory, and the harness expands it.
 * @returns the absolute harness home path.
 */
export function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  if (configured !== undefined && configured !== '') {
    if (configured === '~') return homedir()
    if (configured.startsWith('~/') || configured.startsWith('~\\')) return join(homedir(), configured.slice(2))
    return configured
  }
  return join(homedir(), '.dsh')
}

/**
 * Where this plugin keeps its own runtime state.
 *
 * Deliberately NOT the package directory any more. An installed package lives
 * under `<profile>/node_modules`, which a reinstall replaces and a read-only
 * store may refuse to write at all — and a log written there carries
 * authenticated `?token=…` URLs and the machine's own paths straight into
 * whatever repository happens to hold the checkout.
 * @returns the absolute state directory (it may not exist yet).
 */
export function stateDir() {
  return join(dshHome(), 'storages', 'dsh-power-switch')
}

/** The shared diagnostic log, kept outside the package. */
export function logPath() {
  return join(stateDir(), 'restart-dsh.log')
}

/** Create the state directory; every writer needs it to exist first. */
export function ensureStateDir() {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Where the running host records the authenticated URL of ITS OWN run.
 *
 * Why this exists, in one failure: the restart helper and the desktop launcher
 * used to find the live host by scavenging whatever log the host's stdout landed
 * in. That file is chosen by whatever STARTED the host, so a person whose own
 * launcher writes it into the checkout got
 * `FAILED: no host token URL in any log, so there is no host to restart` — the
 * switch saved the mode and adopted the shortcut, then refused to restart
 * because it could not prove which process was serving. The host knows its own
 * port and can mint its own URL, so it writes it down and nobody has to guess.
 */
export function tokenRecordPath() {
  return join(stateDir(), 'token-url.txt')
}

/**
 * The authenticated URL the running host recorded, or null.
 *
 * Deliberately NOT trusted as proof of life: it outlives the run that wrote it,
 * so every caller verifies it against the live port before using it.
 * @returns the URL, or null when none was recorded or it is not one.
 */
export function readRecordedTokenUrl() {
  try {
    const text = readFileSync(tokenRecordPath(), 'utf8').trim()
    return /^https?:\/\/[^\s]+\?token=[A-Za-z0-9_-]+$/u.test(text) ? text : null
  } catch {
    return null
  }
}

/**
 * Record this run's authenticated URL for the helper and the launcher.
 * @param url - the URL from `connection.authenticatedUrl(base)`.
 * @returns the path written.
 */
export function writeRecordedTokenUrl(url) {
  const dir = ensureStateDir()
  const file = join(dir, 'token-url.txt')
  writeFileSync(file, `${String(url).trim()}\n`, 'utf8')
  return file
}

/** Whether a value is a usable TCP port number. */
function isPort(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
}

/**
 * A token-URL pattern, optionally scoped to ONE port.
 *
 * The UNSCOPED form is the one a cold start needs, and that is a measured
 * failure rather than a preference: the host hands its own port to the restart
 * helper (`restartHelperEnv`), but the desktop launcher is started by Explorer
 * and inherits no such fact. Scoping that wait to a guessed 3080 meant a DSH on
 * any other port was started correctly and then never got a window -- the
 * launcher waited for a line the host would never print on that port, and the
 * person saw a shortcut that "does nothing".
 *
 * Matching ANY loopback port is safe because every candidate is verified against
 * the live server before it is opened: a token from a stale or foreign run
 * answers nothing and is rejected by the probe.
 * @param port - the port to scope the pattern to, or `null` for any port.
 * @returns a FRESH global regex (a shared `/g` regex carries `lastIndex` state).
 */
export function tokenUrlPattern(port = null) {
  const scope = isPort(port) ? `:${String(port)}` : ':\\d{1,5}'
  return new RegExp(`https?://127\\.0\\.0\\.1${scope}/\\?token=[A-Za-z0-9_-]+`, 'gu')
}

/**
 * The port inside a loopback token URL, or null.
 * @param url - a candidate token URL.
 * @returns the port, or null when the URL is not one.
 */
export function portFromTokenUrl(url) {
  if (typeof url !== 'string') return null
  const match = /^https?:\/\/127\.0\.0\.1:(\d{1,5})\/\?token=/u.exec(url.trim())
  if (match === null) return null
  const port = Number(match[1])
  return isPort(port) ? port : null
}

/**
 * The port a recorded argument list asks for, or null.
 *
 * A host started as `dsh web --port 4000` records exactly that, and the launcher
 * replays it verbatim -- so the port it will serve on is readable from the record
 * before anything is spawned. `--port=N` and the short `-p N` are accepted
 * because the CLI accepts them.
 * @param args - the recorded argument list.
 * @returns the port, or null when the arguments name none.
 */
export function portFromArguments(args) {
  const list = Array.isArray(args) ? args.map((value) => String(value)) : []
  for (let at = 0; at < list.length; at += 1) {
    const inline = /^--port=(\d{1,5})$/u.exec(list[at])
    if (inline !== null) {
      const port = Number(inline[1])
      return isPort(port) ? port : null
    }
    if (list[at] === '--port' || list[at] === '-p') {
      const port = Number(list[at + 1])
      return isPort(port) ? port : null
    }
  }
  return null
}

/**
 * Which port a cold start should probe, and where that answer came from.
 *
 * The order is "most authoritative statement first": an explicit `--port` or
 * `DSH_POWER_SWITCH_PORT` is a deliberate instruction; the port the last host
 * recorded for itself is what this machine actually served on; the port inside
 * the recorded launch command is what the replayed host WILL serve on; and only
 * then the historical default.
 *
 * The probe is a safety check -- "refuse rather than start a second host onto an
 * occupied port" -- so a wrong guess costs the refusal, not the launch: the wait
 * for the token URL is port-agnostic for exactly that reason.
 * @param options - `{ explicit, recordedUrl, bootArgs, fallback }`.
 * @returns `{ port, source }`.
 */
export function resolveProbePort(options = {}) {
  const { explicit = null, recordedUrl = null, bootArgs = [], fallback = 3080 } = options
  if (isPort(explicit)) return { port: explicit, source: 'the --port / DSH_POWER_SWITCH_PORT setting' }
  const fromUrl = portFromTokenUrl(recordedUrl)
  if (fromUrl !== null) return { port: fromUrl, source: 'the port the last host recorded for itself' }
  const fromArgs = portFromArguments(bootArgs)
  if (fromArgs !== null) return { port: fromArgs, source: 'the port in the recorded launch command' }
  return { port: fallback, source: 'the default port' }
}

/**
 * A URL with its token replaced, for anything a person will read.
 *
 * The authenticated URL is a local access credential: whoever holds it can talk
 * to this DSH. The files that MUST hold it are the only two that should -- the
 * host's own stdout log (how a replacement finds the live process) and
 * `token-url.txt` -- so every diagnostic line goes through here first.
 *
 * The launcher is why this exists: a desktop shortcut runs it through a `.vbs`
 * that redirects stdout into `%TEMP%`, so one raw URL in a log line put the token
 * in a second, less obvious place. Diagnostics keep their shape -- the port and
 * the path stay readable -- without the secret.
 * @param value - any text that may contain a token URL.
 * @returns the same text with every token replaced by `***`.
 */
export function redactToken(value) {
  return String(value).replace(/([?&]token=)[A-Za-z0-9_-]+/gu, '$1***')
}

/**
 * Where the host records the Node interpreter it is running on.
 *
 * Read by `launch-dsh.vbs`, which cannot parse JSON and must not guess:
 * nvm-windows, fnm, volta and Store installs have no
 * `%ProgramFiles%\nodejs\node.exe`, and a bare `node.exe` needs a PATH that a
 * shortcut's environment does not always carry. A single line in a text file is
 * something VBScript can read without a JSON parser.
 */
export function nodePathFile() {
  return join(stateDir(), 'node-path.txt')
}

/**
 * Record the interpreter running the host, for the `.vbs` wrappers.
 * @param execPath - `process.execPath` of the host.
 * @returns the path written.
 */
export function writeNodePath(execPath) {
  const dir = ensureStateDir()
  const file = join(dir, 'node-path.txt')
  writeFileSync(file, `${String(execPath).trim()}\n`, 'utf8')
  return file
}

/**
 * The boot invocation of the RUNNING host, recorded by the plugin's host half.
 *
 * This is the whole portable answer to "how do I start DSH again". Nothing has
 * to guess where the CLI lives or what a source checkout looks like, because
 * the host that is running right now writes down exactly how it was started:
 * the launcher uses it for a cold start and the restart supervisor uses it to
 * replace the process. The old code reconstructed `<checkout>/apps/cli/lib/
 * bin.js` instead, a path that exists only in a DSH source checkout.
 * @returns the recorded plan, or null when none was ever written.
 */
export function readBootRecord() {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir(), 'boot.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.execPath !== 'string' || parsed.execPath === '') return null
    if (!Array.isArray(parsed.args) || parsed.args.length === 0) return null
    return {
      execPath: parsed.execPath,
      args: parsed.args.map((value) => String(value)),
      cwd: typeof parsed.cwd === 'string' && parsed.cwd !== '' ? parsed.cwd : undefined,
      recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : null,
    }
  } catch {
    return null
  }
}

/**
 * Persist the boot invocation for the launcher and the restart supervisor.
 * @param record - `{ execPath, args, cwd, recordedAt }` as `relaunchPlan` built it.
 * @returns the path written.
 */
export function writeBootRecord(record) {
  const dir = ensureStateDir()
  const file = join(dir, 'boot.json')
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return file
}

/**
 * Whether a path is a Windows shell shim that cannot be spawned directly.
 * @param path - the candidate executable path.
 */
function isShellShim(path) {
  return /\.(?:cmd|bat|ps1)$/iu.test(path)
}

/** The first `dsh` executable on PATH, or null. */
function cliOnPath() {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const probe = spawnSync(finder, ['dsh'], { encoding: 'utf8', windowsHide: true })
    if (probe.error !== undefined || probe.status !== 0 || typeof probe.stdout !== 'string') return null
    return probe.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '') ?? null
  } catch {
    return null
  }
}

/**
 * The command that starts DSH, and where that answer came from.
 *
 * In order: an explicit `--cli` / `DSH_POWER_SWITCH_CLI`, then the invocation the
 * last host recorded for ITSELF — the normal case, and the only one that is
 * exactly right, because it is literally how DSH was started on this machine —
 * then `dsh` from PATH. Nothing is rebuilt from a guessed directory layout: the
 * version this replaced reconstructed `<checkout>/apps/cli/lib/bin.js`, which
 * exists only in a DSH source checkout, so a shortcut could not start anything
 * anywhere else.
 *
 * Shared by the desktop launcher and the standalone restart script so the two
 * cannot drift on the one question they both have to answer.
 * @param options - `{ cli, defaultCwd, log }`.
 * @returns `{ execPath, args, cwd, shell, source }`, or null when nothing usable exists.
 */
export function resolveLaunchCommand(options = {}) {
  const { cli = null, defaultCwd = process.cwd(), log = () => {} } = options
  const explicit = typeof cli === 'string' && cli !== '' ? cli : null
  if (explicit !== null) {
    if (!existsSync(explicit)) {
      log(`FAILED: --cli/DSH_POWER_SWITCH_CLI points at ${explicit}, which does not exist`)
      return null
    }
    return {
      execPath: explicit,
      args: ['web', '--no-open'],
      cwd: defaultCwd,
      shell: isShellShim(explicit),
      source: 'the --cli override',
    }
  }
  const recorded = readBootRecord()
  if (recorded !== null) {
    const entry = recorded.args[0]
    const entryIsScript = typeof entry === 'string' && /\.(?:m|c)?js$/u.test(entry)
    if (!existsSync(recorded.execPath)) {
      log(`the recorded interpreter is gone (${recorded.execPath}); falling back`)
    } else if (entryIsScript && !existsSync(entry)) {
      log(`the recorded entry point is gone (${entry}); falling back`)
    } else {
      return {
        execPath: recorded.execPath,
        args: recorded.args,
        cwd: recorded.cwd ?? defaultCwd,
        shell: false,
        source: `the command this machine recorded (${recorded.recordedAt ?? 'unknown time'})`,
      }
    }
  }
  const onPath = cliOnPath()
  if (onPath !== null) {
    return {
      execPath: onPath,
      args: ['web', '--no-open'],
      cwd: defaultCwd,
      shell: isShellShim(onPath),
      source: 'dsh on PATH',
    }
  }
  log('FAILED: there is no way to start DSH here — nothing was recorded, and there is no dsh on PATH.')
  log('FAILED: start DSH once with this plugin installed, or set DSH_POWER_SWITCH_CLI to the dsh CLI entry point.')
  return null
}

/**
 * Where DSH keeps its settings document.
 *
 * Shared because three processes need the same answer: the plugin's host half (to
 * read the mode it was launched with), the desktop launcher, and the supervisor.
 * Four copies of this rule is how one of them ends up reading a different file
 * than the card writes.
 * @returns the absolute path to `settings.yaml`.
 */
export function settingsPath() {
  return join(dshHome(), 'settings.yaml')
}

/**
 * The launch mode the user stored in DSH's own settings document.
 *
 * Read as TEXT on purpose: this is the only way a relaunching process can see a
 * choice the card made, and a YAML dependency for one scalar is not worth
 * carrying. The namespace block is matched by indentation alone, so a
 * `launchMode` belonging to some other namespace cannot be mistaken for this one.
 * @param settingsFile - the settings document to read.
 * @returns `'app'`, `'tab'`, or null when the document says nothing.
 */
export function storedLaunchMode(settingsFile) {
  let text
  try {
    text = readFileSync(settingsFile, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex((line) => /^dsh-power-switch:\s*$/u.test(line))
  if (start < 0) return null
  for (const line of lines.slice(start + 1)) {
    // The block ends at the first line that is not indented under it.
    if (line.trim() !== '' && !/^\s/u.test(line)) break
    const value = /^\s+launchMode:\s*['"]?(app|tab)['"]?\s*$/u.exec(line)?.[1]
    if (value !== undefined) return value
  }
  return null
}

/**
 * The plugin's OWN record of the launch mode, under the state directory.
 *
 * It exists because the launch mode cannot live only in DSH's settings store.
 * DSH 0.1.7 retired the settings document: it is imported once into the active
 * profile and renamed, so `storedLaunchMode(settingsPath())` afterwards answers
 * nothing — and the launcher, the helper and the supervisor would every one of
 * them fall back to a tab, i.e. "I switched to the app window and the next start
 * was a tab again". The host writes this file whenever the choice is made or
 * published, and every reader outside the host prefers the settings document (an
 * explicit edit) and falls back to this.
 * @returns the absolute path to `launch-mode.txt`.
 */
export function launchModePath() {
  return join(stateDir(), 'launch-mode.txt')
}

/**
 * The mode this plugin recorded for the next launch, or null.
 * @returns `'app'`, `'tab'`, or null when nothing usable was recorded.
 */
export function readRecordedLaunchMode() {
  try {
    const text = readFileSync(launchModePath(), 'utf8').trim()
    return text === 'app' || text === 'tab' ? text : null
  } catch {
    return null
  }
}

/**
 * Record the mode for the next launch, for the readers that run outside the host.
 * @param mode - `'app'` or `'tab'`; anything else is recorded as `'tab'`.
 * @returns the path written.
 */
export function writeRecordedLaunchMode(mode) {
  const value = mode === 'app' ? 'app' : 'tab'
  const dir = ensureStateDir()
  const file = join(dir, 'launch-mode.txt')
  writeFileSync(file, `${value}\n`, 'utf8')
  return file
}

/**
 * The launch mode a process OUTSIDE the host should use.
 *
 * The settings document comes first, because that is where an explicit choice
 * lands on a host that still has one — including one made in a form the host
 * generates itself. Then the plugin's own record, which is the only source left
 * on a host whose settings document is gone (DSH 0.1.7) or was never written.
 * @param settingsFile - the settings document to read; the harness one by default.
 * @returns `'app'`, `'tab'`, or null when neither source says anything.
 */
export function resolveLaunchMode(settingsFile = settingsPath()) {
  return storedLaunchMode(settingsFile) ?? readRecordedLaunchMode()
}

/**
 * Where the plugin records the advanced settings the card can change.
 *
 * A second file rather than a field in `launch-mode.txt`: that one is deliberately
 * one plain line, because its readers are Node processes that should not need a
 * JSON parser for the single value a cold start depends on.
 * @returns the absolute path to `settings.json`.
 */
export function recordedSettingsPath() {
  return join(stateDir(), 'settings.json')
}

/**
 * The advanced settings recorded by the card, or an empty object.
 *
 * Every field is optional and re-validated on read: the file lives under the
 * user's home, so a hand-edited or truncated one has to degrade to "no opinion"
 * rather than feed a bad number into an exit.
 * @returns `{ delayMs?, exitCode?, hard? }`.
 */
export function readRecordedSettings() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(recordedSettingsPath(), 'utf8'))
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const recorded = {}
  if (Number.isInteger(parsed.delayMs) && parsed.delayMs >= 0) recorded.delayMs = parsed.delayMs
  if (Number.isInteger(parsed.exitCode) && parsed.exitCode >= 0) recorded.exitCode = parsed.exitCode
  if (typeof parsed.hard === 'boolean') recorded.hard = parsed.hard
  return recorded
}

/**
 * Merge a patch into the recorded advanced settings.
 * @param patch - `{ delayMs?, exitCode?, hard? }`, already validated by the route.
 * @returns the path written.
 */
export function writeRecordedSettings(patch) {
  const merged = { ...readRecordedSettings(), ...patch }
  const dir = ensureStateDir()
  const file = join(dir, 'settings.json')
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return file
}

/**
 * Every Chromium-family executable worth trying, most likely first.
 *
 * PER-USER FIRST, and that is not a nicety: Chrome or Edge installed without
 * admin — which is the default for a non-admin user, and what Edge does for
 * every profile — lives under `%LOCALAPPDATA%`, not under `%ProgramFiles%`. A
 * search that only knew the machine-wide paths found nothing on exactly those
 * machines and quietly fell back to a tab, i.e. the whole app-window feature
 * gone for a reason nobody could see.
 * @param env - environment to read the install roots from.
 * @returns candidate paths, best first.
 */
export function browserCandidates(env = process.env) {
  if (process.platform !== 'win32') {
    return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium']
  }
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']]
    .filter((root) => typeof root === 'string' && root !== '')
  const relatives = [
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ['Chromium', 'Application', 'chrome.exe'],
  ]
  const candidates = []
  for (const relative of relatives) {
    for (const root of roots) candidates.push(join(root, ...relative))
  }
  return candidates
}

/**
 * The first Chromium-family browser on this machine.
 *
 * Chromium is the only family whose `--app=<url>` produces a real standalone
 * window, which is what the app mode promises, so the search is limited to it.
 * @param exists - file-existence probe, injected for tests.
 * @param env - environment to read the install roots from.
 * @returns the executable path, or undefined when none is installed.
 */
export function findBrowser(exists = existsSync, env = process.env) {
  return browserCandidates(env).find((candidate) => exists(candidate))
}

/**
 * Hand the URL to the default browser: tab mode, and every fallback.
 *
 * `cmd /c start` rather than the URL directly, because `start` is what resolves
 * the person's actual default browser instead of guessing one.
 * @param url - the authenticated URL.
 * @param log - sink for one line saying what happened.
 */
export function openAsTab(url, log) {
  const opener = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url.replace(/&/gu, '^&')]]
    : ['xdg-open', [url]]
  const result = spawnSync(opener[0], opener[1], { stdio: 'ignore', windowsHide: true })
  // `spawnSync` does NOT throw when the program is missing: it returns the error
  // in the result. Logging success unconditionally is how a machine without the
  // opener got a "handed the URL to the default browser" line and no window.
  if (result.error !== undefined) {
    log(`FAILED to hand the URL to the default browser: ${result.error.message}`)
    return false
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    log(`FAILED to hand the URL to the default browser: ${opener[0]} exited with ${String(result.status)}`)
    return false
  }
  log('handed the URL to the default browser')
  return true
}

/**
 * Open the URL in the requested shape -- the ONE implementation of that choice.
 *
 * It lives here because it is used from three different entry points: the
 * supervisor that relaunches DSH after a switch, the desktop launcher that starts
 * DSH from cold, and the standalone restart script. Two copies of "which window
 * does app mode mean" is exactly how a mode starts working on one path and
 * silently not on another -- which is what happened: the desktop launch had no
 * window decision at all.
 *
 * App mode uses a bare `--app=<url>`: that is the form MEASURED to give a
 * standalone window here (`display-mode: standalone`, and `window.close()`
 * honoured), which is the entire point of the mode -- a page that can take itself
 * down once DSH is gone. A browser that cannot be found, or cannot be started,
 * falls back to the default browser: no window at all is the worst outcome.
 * @param url - the authenticated URL.
 * @param mode - `'app'` or `'tab'`.
 * @param log - sink for one line saying what happened.
 * @param browser - an explicit browser to use for an app window, overriding the search.
 */
export function openWindow(url, mode, log, browser = findBrowser()) {
  if (mode !== 'app') {
    openAsTab(url, log)
    return
  }
  if (browser === undefined) {
    log('no Chromium browser found for an app window; falling back to the default browser')
    openAsTab(url, log)
    return
  }
  try {
    const opener = spawn(browser, [`--app=${url}`, '--no-first-run'], {
      detached: true, stdio: 'ignore', windowsHide: false,
    })
    opener.on('error', (error) => {
      log(`could not open the app window (${error.message}); falling back to the default browser`)
      openAsTab(url, log)
    })
    opener.unref()
    log(`opened an app window: ${browser}`)
  } catch (error) {
    log(`could not open the app window (${error.message}); falling back to the default browser`)
    openAsTab(url, log)
  }
}
