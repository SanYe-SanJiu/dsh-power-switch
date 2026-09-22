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
