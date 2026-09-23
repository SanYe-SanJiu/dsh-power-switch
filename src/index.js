/**
 * dsh-power-switch — host half.
 *
 * Registers three trusted HTTP routes on the composition's `webServer`: one to
 * read the effective configuration, one to shut down, and one to save a launch
 * mode and restart into it. The shutdown asks the launcher to leave through the
 * graceful path it already owns (`ctx.appExit`, provided by
 * `@deepseek-ai/dsh-cmdline` and wired to the CLI's bounded shutdown
 * controller) — the same call the headless and SDK apps use. Nothing here kills
 * a process directly: disposal flushes sessions and settings first, and a
 * stalled disposal still ends in a forced exit after the launcher's grace.
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  dshHome,
  ensureStateDir,
  logPath,
  openWindow,
  settingsPath,
  stateDir,
  storedLaunchMode,
  writeBootRecord,
  writeNodePath,
  writeRecordedTokenUrl,
} from '../scripts/restart-shared.mjs'
import {
  CONFIG_ROUTE,
  POWER_ROUTE,
  RESTART_ROUTE,
  SHORTCUT_ROUTE,
  createConfigHandler,
  createExitResponder,
  createPowerHandler,
  createRestartHandler,
  createShortcutHandler,
  chooseShortcutAction,
  parseShortcutResult,
  relaunchPlan,
  resolveConfig,
  restartHelperEnv,
  schemasteryReferrers,
  shortcutVerdict,
  shouldOpenStartupWindow,
} from './host.js'

/**
 * The shared diagnostic log — under the harness home, NOT in this package.
 *
 * A log inside the installed package is wrong twice over: the package can live
 * in a read-only store, and the file it produces carries authenticated
 * `?token=…` URLs and this machine's paths into whatever repository holds the
 * checkout.
 */
const RESTART_LOG = logPath()

/**
 * This package's own directory, which holds the CODE the helper runs.
 *
 * State no longer lives here (see `stateDir()`); only the `.vbs` wrappers and
 * the helper scripts are read from it, and those are read-only.
 */
const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * How this process was started, captured while it is running.
 *
 * This replaced a hard-coded `<checkout>/apps/cli/lib/bin.js`, which exists only
 * in a DSH source checkout: on any other machine the restart supervisor spawned
 * a path that was not there, and because that failure is asynchronous the host
 * had already exited — taking DSH down with nobody left to bring it back.
 */
const BOOT = {
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv.slice(1),
  cwd: process.cwd(),
}

/**
 * The derived relaunch command, or `{ error }` when this host cannot be replayed.
 * Filled in once per load; read by the restart route.
 */
let launchPlan = null

/**
 * The port this host actually serves on, once the Web server reports it.
 *
 * Handed to the restart helper: it probes the live host on this port and filters
 * the host's recorded URL by it, so a DSH on a non-default port is restarted
 * instead of being reported as "no host found".
 */
let livePort = null

/**
 * The desktop shortcut this plugin places, and what it says.
 *
 * The name is mode-neutral on purpose: the launcher reads the stored mode on
 * every launch, so a name claiming one shape would be wrong half the time. It is
 * deliberately NOT "DSH" either -- overwriting a shortcut the person already made
 * for themselves is not this plugin's business.
 */
const SHORTCUT_NAME = 'DSH 启动器'
const SHORTCUT_DESCRIPTION = '启动 DSH 并按卡片里存着的窗口模式打开（tab / app）。'

/* The route owns one exact path, so it cannot shadow a host surface. */
export const name = 'dsh-power-switch'

/**
 * The `webServer` routes are the whole delivery mechanism; `settings` only adds
 * a configuration page and is optional on purpose, so a deployment without a
 * settings provider still gets a working button.
 */
export const inject = ['webServer']

/** @typedef {{ delayMs?: number, exitCode?: number, hard?: boolean, launchMode?: 'tab'|'app' }} Config */

/**
 * Why the old file-URL fallback for schemastery is gone.
 *
 * It tried `<this package>/../../node_modules/@deepseek-ai/schemastery/lib/
 * index.mjs`. Measured with `new URL('../../', import.meta.url)`:
 *
 *   dev checkout  -> G:/test/c/node_modules/@deepseek-ai/schemastery/...   exists
 *   profile       -> <profile>/node_modules/node_modules/@deepseek-ai/...  never exists
 *
 * It only ever worked in a developer checkout — the one layout where the package
 * directory is a SIBLING of a `node_modules` — so it was a second chance that
 * could not fire where it was needed. The bare specifier is the only leg now, and
 * its failure is reported instead of swallowed.
 */

/**
 * Mount the power-switch routes.
 *
 * Two launch modes, ONE exit. The mode decides what happens after the process
 * is gone -- the detached helper reopens a tab or an app window -- and never
 * whether it goes: a mode-dependent exit would mean one of the two could stall,
 * which is exactly the failure this plugin has already had once.
 * @param ctx - host plugin context carrying `webServer`.
 * @param config - optional loader-row configuration.
 * @param timings - test seam for the two exit timings; production uses defaults.
 */
export function apply(ctx, config = {}, timings = {}) {
  // Mutable so a settings write reaches the next request without re-registering.
  let current = resolveConfig(config)
  /** The settings scope, once one is attached: lets the card persist a choice. */
  let scope

  /**
   * Append one line to the restart log the relaunch helper also writes.
   *
   * The exit path used to fail silently: the response reached the card, the
   * helper started, and the process simply kept running, which left no evidence
   * anywhere because the helper's own log only began when the port went quiet.
   * This records the decision BEFORE anything irreversible happens, so the next
   * failure is diagnosable from a file instead of from a hung page.
   *
   * Declared BEFORE the settings injection on purpose. That injection can run
   * synchronously — `ctx.inject` calls back the moment the service exists, which
   * is immediately in a host that has one — and passing a `const` declared below
   * it threw `Cannot access 'note' before initialization`.
   * @param message - the line to append.
   */
  const note = (message) => {
    try {
      const line = `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] power-switch: ${message}\n`
      appendFileSync(RESTART_LOG, line)
    } catch {
      // Diagnostics never block an exit.
    }
  }

  ctx.inject(['settings'], (settingsCtx) => {
    installSettingsSection(settingsCtx, ctx, config, (next) => { current = next }, (attached) => { scope = attached }, note)
  })

  /**
   * The mode the NEXT window should use.
   *
   * The settings DOCUMENT wins over the loader row, because that is where the
   * card writes its choice and the loader row carries no `launchMode` at all
   * (it is only ever changed in memory by a switch). Reading it here rather than
   * from `current` also removes a race: the settings section publishes into
   * `current` asynchronously, and a startup window must not depend on winning
   * that race.
   * @returns `'app'` or `'tab'`.
   */
  const startupMode = () => storedLaunchMode(settingsPath()) ?? current.launchMode

  /**
   * Read the launcher's exit callable.
   *
   * The launcher provides it before the tree mounts, so this is normally a hit
   * on the first read. The probe is kept because the only thing worse than no
   * exit is an exit whose availability was never recorded, but it is explicitly
   * bounded and cancelled: an uncancelled poll keeps the event loop alive.
   */
  const exitProbe = { cancelled: false }
  ctx.effect(() => () => { exitProbe.cancelled = true }, 'dsh-power-switch: exit probe lifetime')
  void (async () => {
    const exit = await resolveAppExit(ctx, exitProbe)
    if (exitProbe.cancelled) return
    note(`appExit resolved: ${exit === undefined ? 'absent' : 'available'}`)
  })().catch(() => {})

  /**
   * Record how this host was started, and decide whether a restart is possible.
   *
   * The command is derived from THIS process (`process.execPath` / `argv` /
   * `cwd`), so it is right on any machine and in any install layout, and it is
   * written to the state directory because two other processes need it: the
   * desktop launcher (a cold start) and the restart supervisor (the
   * replacement). It replaced a rebuilt `<checkout>/apps/cli/lib/bin.js` path
   * that only exists in a DSH source checkout.
   *
   * An unusable plan is NOT fatal. The restart route refuses before spawning
   * anything, the supervisor never writes its handshake, and this host keeps
   * serving — which is the difference between "restart is unavailable here" and
   * the failure that replaced it: DSH exiting with nothing left to bring it back.
   */
  launchPlan = relaunchPlan(BOOT, existsSync)
  if (launchPlan.error !== undefined) {
    note(`restart is unavailable in this host: ${launchPlan.error}`)
  } else {
    try {
      writeBootRecord(launchPlan)
      // The interpreter too: `launch-dsh.vbs` runs the desktop launch, and a
      // machine whose Node came from nvm/fnm/volta has no
      // %ProgramFiles%\nodejs\node.exe to fall back on.
      writeNodePath(BOOT.execPath)
      note(`boot command recorded: ${launchPlan.execPath} ${launchPlan.args.join(' ')}`)
    } catch (error) {
      note(`could not record the boot command (${error.message}); the desktop launcher will fall back to dsh on PATH`)
    }
  }

  recordTokenUrl(ctx, note)

  const exitWith = createExitResponder({
    ...timings,
    // The launcher's own bounded controller: disposal flushes sessions and
    // settings, then the process leaves. A graceful exit that throws is not the
    // end of the story -- the responder's watchdog ends the process regardless.
    gracefulExit: (code) => {
      const exit = ctx.get('appExit')
      if (typeof exit === 'function') {
        exit(code)
        return
      }
      note('no appExit service; sending SIGTERM to self')
      process.kill(process.pid, 'SIGTERM')
    },
    forceExit: (code) => { process.exit(code) },
    note,
  })

  /**
   * Persist one launch mode into the settings document.
   *
   * The composition entry is updated FIRST, so the restart supervisor reads the
   * new mode even if the settings provider is absent or its write is refused.
   * @param mode - `'app'` or `'tab'`.
   * @returns whether the settings document also accepted it — `false` when no
   *   provider is attached (the mode then lives only until this process exits).
   */
  const persistLaunchMode = async (mode) => {
    config.launchMode = mode
    // The in-memory switch is not persistence, and this used to be reported as
    // one. `scope` stays undefined until the settings provider resolves — and
    // stays undefined entirely when schemastery could not be loaded — while
    // `scope?.update?.()` neither writes nor throws, so the old `return true`
    // answered "persisted" with no file behind it and the next cold start fell
    // back to the default mode. Awaiting the call also stops a provider that
    // rejects from being reported as a success.
    const update = scope?.update
    if (typeof update !== 'function') return false
    try {
      await update.call(scope, { launchMode: mode })
      return true
    } catch {
      return false
    }
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: POWER_ROUTE,
      handler: createPowerHandler({ config: () => current, exitWith }),
    }),
    'dsh-power-switch: shutdown route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: createConfigHandler({ config: () => current }),
    }),
    'dsh-power-switch: configuration route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: RESTART_ROUTE,
      handler: createRestartHandler({
        config: () => current,
        persist: persistLaunchMode,
        respawn: (mode) => spawnRestartHelper(mode, launchPlan),
        // Naming the reason is what lets the card answer in the reader's own
        // language; the message stays as the diagnostic detail.
        planProblem: () => (launchPlan !== null && launchPlan.error !== undefined
          ? { reason: 'unsupported-host', message: launchPlan.error }
          : null),
        awaitRespawn: awaitHelperHandshake,
        exitWith,
      }),
    }),
    'dsh-power-switch: restart route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: SHORTCUT_ROUTE,
      handler: createShortcutHandler({ run: (action) => runShortcutHelper(action, note) }),
    }),
    'dsh-power-switch: shortcut route',
  )

  sweepOldHandshakes(note)
  installStartupWindow(ctx, startupMode, note)
}

/**
 * The plugin's own state directory, created on first use.
 *
 * Falls back to the un-created path when the harness home is not writable: every
 * writer below already tolerates a write failure, and a plugin that refuses to
 * load because it cannot write its own log would be worse than one without logs.
 */
const STATE_DIR = (() => {
  try {
    return ensureStateDir()
  } catch {
    return stateDir()
  }
})()

/** Where the original shortcut is recorded, so the change can be undone. */
const SHORTCUT_BACKUP = join(STATE_DIR, 'shortcut-backup.txt')

/** Where the helper writes what it did; read back as UTF-16. */
const SHORTCUT_RESULT = join(STATE_DIR, 'shortcut-result.txt')

/**
 * Run the mechanical helper once and read what it reported.
 *
 * Three things about the call are load-bearing:
 *
 *  - the ACTION is the only thing the card chooses. Every path, name and target is
 *    derived here, which is what keeps this from being a "write a shortcut
 *    anywhere" primitive;
 *  - the stdio is IGNORED. This runs inside the host process, and a piped child is
 *    the thing that fails with EPERM in a sandboxed host -- so the verdict travels
 *    by exit code and by a result FILE, not by captured output;
 *  - the result file is UTF-16, because the desktop path and the shortcut name may
 *    both contain non-ASCII characters.
 * @param action - `'scan'`, `'apply'`, `'create'` or `'restore'`.
 * @param targetLnk - the shortcut to adopt, for `'apply'` only.
 * @returns `{ outcome, reported }`.
 */
function callShortcutHelper(action, targetLnk) {
  const launcher = join(WORKSPACE_ROOT, 'scripts', 'launch-dsh.vbs')
  const helper = join(WORKSPACE_ROOT, 'scripts', 'make-shortcut.vbs')
  // The desktop-shortcut feature is Windows Script Host plus `.lnk`, and the
  // manifest declares `os: win32` to match. This is the belt to those braces:
  // without it a non-Windows machine got `spawnSync cscript.exe ENOENT` — a raw
  // Node error — rendered in the card as if the plugin were broken.
  if (process.platform !== 'win32') {
    return {
      outcome: {
        error: new Error('placing a desktop shortcut needs Windows Script Host (cscript.exe), which this platform does not have'),
      },
      reported: {},
    }
  }
  // A stale result would otherwise be read back as this run's answer.
  try {
    rmSync(SHORTCUT_RESULT, { force: true })
  } catch {
    // A result file that cannot be removed only costs us a fresh answer.
  }
  // The harness home rides along so the shortcut can record it: Explorer does not
  // necessarily carry DSH_HOME, and a launcher started from a shortcut without it
  // reads a different state directory, finds no boot record and refuses to start
  // anything -- a shortcut that looks like it does nothing.
  const args = ['//nologo', helper, action, launcher, dshHome(), SHORTCUT_BACKUP, SHORTCUT_RESULT, SHORTCUT_NAME, SHORTCUT_DESCRIPTION]
  if (targetLnk !== undefined) args.push(targetLnk)
  const outcome = spawnSync('cscript.exe', args, { stdio: 'ignore', windowsHide: true })
  return { outcome, reported: readShortcutResult() }
}

/** The shortcut this plugin's previous run took over or created, if any. */
function recordedShortcut() {
  try {
    return parseShortcutResult(readFileSync(SHORTCUT_BACKUP, 'utf16le')).lnk ?? null
  } catch {
    return null
  }
}

/**
 * Check, adopt/create, or restore the desktop shortcut.
 *
 * The interesting property is REVERSIBILITY: adopting the shortcut somebody already
 * uses beats leaving a second icon beside it, but only if the original can be put
 * back. So the helper records the original before it changes anything, and
 * `restore` replays it.
 *
 * The DECISION -- which icon is the DSH one, adopt versus create versus refuse -- is
 * made here, by `chooseShortcutAction`, and not by the helper. That is deliberate: a
 * classifier inside a `.vbs` cannot be unit-tested, and one that could not be tested
 * is exactly how a real desktop shortcut was missed.
 * @param action - `'scan'`, `'install'` or `'restore'`.
 * @param note - the shared log sink.
 * @returns the answer the card shows.
 */
function runShortcutHelper(action, note) {
  const launcher = join(WORKSPACE_ROOT, 'scripts', 'launch-dsh.vbs')
  const helper = join(WORKSPACE_ROOT, 'scripts', 'make-shortcut.vbs')
  if (!existsSync(helper)) return { ok: false, error: `the shortcut helper is missing: ${helper}` }
  if (action !== 'scan' && !existsSync(launcher)) {
    return { ok: false, error: `the packaged launcher is missing: ${launcher}` }
  }

  if (action === 'restore') {
    const { outcome, reported } = callShortcutHelper('restore')
    // Exit 6 is NOT a failure: it means there is no record of this plugin ever
    // changing a shortcut, so the desktop is already in its original state. Reporting
    // that as an error told the person their restore had failed when there was
    // simply nothing to restore.
    if (outcome.status === 6) {
      note('shortcut restore: nothing to undo (no record of a changed shortcut)')
      return { ok: true, action: 'nothing' }
    }
    const failure = shortcutVerdict('restore', outcome, reported, note)
    if (failure !== null) return failure
    const restored = reported.lnk ?? ''
    note(`shortcut restore: ${reported.action ?? 'ok'}${restored === '' ? '' : ` (${restored})`}`)
    return {
      ok: true,
      action: reported.action ?? 'restored',
      path: restored === '' ? null : restored,
    }
  }

  // Both remaining actions start from the same read-only scan.
  const scanned = callShortcutHelper('scan')
  const failure = shortcutVerdict('scan', scanned.outcome, scanned.reported, note)
  if (failure !== null) return failure
  const chosen = chooseShortcutAction(scanned.reported.entries, launcher)

  if (action === 'scan') {
    // Only DSH-related icons reach the card: reading every shortcut is unavoidable,
    // but showing somebody their unrelated icons is not this plugin's business.
    note(`shortcut scan: ${String(chosen.entries.length)} DSH-related, ${String(chosen.others)} other (full list in shortcut-result.txt)`)
    return { ok: true, action: 'scan', entries: chosen.entries, others: chosen.others }
  }

  // An existing record means a previous run is still in charge: re-apply to THAT
  // shortcut rather than scanning again, which would find no candidate (the icon it
  // took over is "ours" now) and create a second one beside it.
  const recorded = recordedShortcut()
  if (recorded !== null) {
    const reapplied = callShortcutHelper('apply', recorded)
    const verdict = shortcutVerdict('apply', reapplied.outcome, reapplied.reported, note)
    if (verdict !== null) return verdict
    note(`shortcut install: already in charge of ${recorded}`)
    return { ok: true, action: 'already', path: recorded }
  }

  if (chosen.action === 'ambiguous') {
    note(`FAILED: shortcut install: ${String(chosen.candidates.length)} shortcuts look like DSH`)
    return {
      ok: false,
      error: 'several desktop shortcuts look like DSH; rename or remove the extras, then try again',
      candidates: chosen.candidates,
      entries: chosen.entries,
    }
  }

  const applied = chosen.action === 'adopt'
    ? callShortcutHelper('apply', chosen.path)
    : callShortcutHelper('create')
  const verdict = shortcutVerdict(chosen.action === 'adopt' ? 'apply' : 'create', applied.outcome, applied.reported, note)
  if (verdict !== null) return verdict
  const where = applied.reported.lnk ?? ''
  note(`shortcut install: ${applied.reported.action ?? 'ok'}${where === '' ? '' : ` (${where})`}`)
  return {
    ok: true,
    action: applied.reported.action ?? chosen.action,
    path: where === '' ? null : where,
    was: applied.reported.was,
    entries: chosen.entries,
  }
}

/**
 * Read the helper's result file and hand it to the pure parser.
 *
 * The file is UTF-16 because the desktop path and the shortcut name may both
 * contain non-ASCII characters.
 *
 * `ran` records whether the file existed at all, and that is what separates "the
 * helper ran and refused" from "the helper never executed": the script opens this
 * file before it does anything else, so a missing one means a policy or a parse
 * failure stopped it (see `shortcutVerdict`).
 * @returns the parsed result, plus `ran`.
 */
function readShortcutResult() {
  try {
    return { ...parseShortcutResult(readFileSync(SHORTCUT_RESULT, 'utf16le')), ran: true }
  } catch {
    return { entries: [], candidates: [], others: 0, ran: false }
  }
}

/**
 * Remove the handshake files earlier restarts left behind.
 *
 * The supervisor writes one per run, named after the moment it started, and the host
 * only ever waits for the file ITS run was promised -- every earlier one is inert, and
 * without this they pile up in the package directory one per restart forever.
 *
 * Boot is the one moment a leftover provably cannot be needed: anything still waiting
 * on a handshake would be the host that this boot replaced, and that host has already
 * exited (that is what started the replacement). So the sweep cannot race the restart
 * that is currently in flight.
 * @param note - the shared log sink.
 */
function sweepOldHandshakes(note) {
  let removed = 0
  try {
    for (const entry of readdirSync(STATE_DIR)) {
      // Strictly this plugin's own naming: nothing else in the directory is touched.
      if (!/^restart-handshake-.*\.txt$/u.test(entry)) continue
      try {
        rmSync(join(STATE_DIR, entry), { force: true })
        removed += 1
      } catch {
        // A file that will not go away is not worth failing a boot over.
      }
    }
  } catch {
    // An unreadable state directory simply means there is nothing to sweep.
  }
  if (removed > 0) note(`startup: removed ${String(removed)} stale handshake file(s)`)
}

/**
 * Open this boot's window when the stored mode asks for an app window.
 *
 * `dsh web` hands its URL to the default browser, so DSH itself always produces a
 * TAB: there is no app-window flag, and that hand-off runs a platform opener with
 * a scrubbed environment, so no plugin can influence it. A plugin CAN open a
 * window of its own, and that is what makes the card's "next launch" setting true
 * for a launch the person starts from their desktop -- not only for the switch
 * that restarts DSH.
 *
 * `connection` is injected rather than required: a composition without it must
 * still get the shutdown route and the card, so this feature simply does not
 * happen there. `shouldOpenStartupWindow` decides whether it should happen at all
 * (app mode, no opt-out, nobody else opening this boot's window).
 * @param ctx - the plugin context, which already carries `webServer`.
 * @param mode - reads the effective launch mode at the moment of opening.
 * @param note - the shared log sink.
 */
function installStartupWindow(ctx, mode, note) {
  if (!shouldOpenStartupWindow(mode(), process.env)) {
    // Still worth a line when the mode is app: it is the difference between
    // "the setting is ignored" and "someone else is already opening it".
    if (mode() === 'app') note('startup window: not opening one (handled elsewhere or switched off)')
    return
  }
  ctx.inject(['connection'], (connectionCtx) => {
    void (async () => {
      // Re-read here: the settings section publishes asynchronously, and the
      // gate above ran before the tree finished mounting.
      const wanted = mode()
      if (!shouldOpenStartupWindow(wanted, process.env)) return
      const port = await servingPort(ctx)
      if (port === null) {
        note('startup window: the Web server never reported a port; not opening one')
        return
      }
      const url = connectionCtx.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`)
      if (!(await answers(url))) {
        note('FAILED: the host never answered, so no startup window was opened')
        return
      }
      note(`startup window: opening the stored mode "${wanted}"`)
      openWindow(url, wanted, note)
    })().catch((error) => {
      note(`FAILED: could not open the startup window: ${String(error?.message ?? error)}`)
    })
  })
}

/**
 * Record this run's authenticated URL, so nothing has to scavenge it later.
 *
 * The restart helper and the desktop launcher must both prove WHICH process is
 * serving before they touch it, and they used to do that by reading whatever log
 * the host's stdout landed in — a file chosen by whatever STARTED the host.
 * Measured failure: a person whose own launcher writes that log inside the
 * checkout got `no host token URL in any log`, so the switch saved the mode and
 * adopted the shortcut, then refused to restart. The port and the URL are both
 * knowable right here, so they are written down instead.
 * @param ctx - the plugin context.
 * @param note - the shared log sink. The URL itself is never logged.
 */
function recordTokenUrl(ctx, note) {
  ctx.inject(['connection'], (connectionCtx) => {
    void (async () => {
      const port = await servingPort(ctx)
      if (port === null) {
        note('token record: the Web server never reported a port; the helper will have to read the logs')
        return
      }
      // Remembered for the restart helper's probe, whatever port it is.
      livePort = port
      try {
        writeRecordedTokenUrl(connectionCtx.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`))
        // The URL itself is never logged: a log is readable, a token is not for it.
        note(`token record: stored this run's authenticated URL (port ${String(port)})`)
      } catch (error) {
        note(`token record: could not mint the authenticated URL (${String(error?.message ?? error)})`)
      }
    })().catch(() => {})
  })
}

/**
 * The port the Web server settled on.
 *
 * Polled rather than read once: the tree may still be binding, and a configured
 * `0` means the OS is choosing.
 * @param ctx - the plugin context.
 * @param timeoutMs - how long to wait for a usable port.
 * @returns the port, or null when none appeared.
 */
async function servingPort(ctx, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const port = ctx.get('webServer')?.port
    if (typeof port === 'number' && port > 0) return port
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
  return null
}

/**
 * Whether the authenticated URL is serving yet.
 *
 * The window must not open onto a server that is still binding, and the URL line
 * DSH prints is not available to this process. A token URL answers 303 while it
 * mints the session cookie, or 200 once the cookie is already held, so either
 * status means the page is there.
 * @param url - the authenticated URL.
 * @param timeoutMs - how long to keep asking.
 * @returns true once the host answered.
 */
async function answers(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.status === 200 || response.status === 303) return true
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
  return false
}

/**
 * Wait briefly for the launcher's exit callable, so the log records whether the
 * graceful route was available at all.
 *
 * The exit path never waits on this: the responder reads the service when it
 * fires and its watchdog ends the process when the service is missing. This is
 * diagnostics only, so it is bounded AND cancellable -- a poll that outlives its
 * owner keeps the event loop alive and can stop a test run from finishing.
 * @param ctx - the plugin context.
 * @param token - cancelled when the owning fiber unloads.
 * @returns the callable, or undefined when the host never provided one.
 */
async function resolveAppExit(ctx, token = { cancelled: false }) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (token.cancelled) return undefined
    const exit = ctx.get('appExit')
    if (typeof exit === 'function') return exit
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  }
  return undefined
}

/**
 * Start the detached supervisor that relaunches DSH after this process leaves.
 *
 * It is the same helper the package ships for manual restarts, spawned
 * DETACHED so it survives the process it is replacing -- a child of this
 * process would be reaped with it.
 *
 * The supervisor gets a PER-RUN host log path, not the shared one. This process
 * was started with its stdout redirected into dsh-web.log, so that file stays
 * locked for as long as this process lives -- and a replacement opened onto it
 * fails with EBUSY. Waiting for the port to free up does not help, because the
 * port going quiet is not the same moment as this process letting go of its own
 * output. A fresh name removes the contention instead of racing it.
 * @param mode - the launch mode the replacement should use.
 * @param plan - the captured relaunch command, or `{ error }` when unavailable.
 * @returns the supervisor's pid, or null when it could not start.
 */
function spawnRestartHelper(mode, plan) {
  // Refuse BEFORE anything is promised to the caller. The route turns this into
  // a 500 with the reason, the host never exits, and the page stays usable --
  // instead of the old path, where a supervisor that could not start its child
  // still counted as "restart in hand" and DSH went down for good.
  if (plan === null || plan === undefined || plan.error !== undefined) {
    return null
  }
  try {
    const helper = new URL('../scripts/restart-from-inside.mjs', import.meta.url)
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
    const hostLog = join(STATE_DIR, `dsh-web.${stamp}.log`)
    const handshake = join(STATE_DIR, `restart-handshake-${stamp}.txt`)
    const child = spawn(process.execPath, [fileURLToPath(helper)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // The PORT travels too: the helper probes for the live host on it and
      // filters the host's recorded URL by it, so a DSH serving on anything but
      // the default would otherwise be told to look at 3080 and refuse.
      env: { ...process.env, ...restartHelperEnv({ mode, hostLog, handshake, port: livePort }) },
    })
    child.unref()
    return { pid: child.pid ?? null, handshake }
  } catch {
    return null
  }
}

/**
 * Wait for the supervisor to prove it is up.
 *
 * Without this, "the supervisor could not start" and "the supervisor started"
 * look identical to the host, which then exits either way -- leaving the person
 * on a reconnecting page with nothing coming back. The supervisor touches this
 * file before it does anything else, so its appearance is the one signal that
 * means "something is now responsible for bringing the service back".
 * @param handshake - the path the supervisor was told to touch.
 * @param timeoutMs - how long to wait for it. The helper spends part of this
 *   window finding the live host before it spawns the supervisor, so this must
 *   stay comfortably larger than that helper's own per-candidate probe budget;
 *   otherwise a slow-but-working restart is reported as a failed one.
 * @returns true when the supervisor checked in.
 */
async function awaitHelperHandshake(handshake, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(handshake)) return true
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
  return false
}

/**
 * Offer the plugin's own settings section, which is also what gives it a card
 * on the Plugins page: that page dispatches a card for each settings namespace
 * the host serves. Absent schemastery, the button still works — only the
 * configuration form is lost.
 * @param settingsCtx - context carrying the settings provider.
 * @param owner - the plugin context that owns the section's lifetime.
 * @param config - the loader-row configuration.
 * @param publish - sink receiving each newly resolved configuration.
 * @param expose - sink receiving the write scope, so the card can persist.
 * @param note - the shared log sink, so a skipped section is not silent.
 */
function installSettingsSection(settingsCtx, owner, config, publish, expose, note) {
  void (async () => {
    const schema = await buildSchema(note)
    if (schema === undefined) return
    // `register` is the only call that hands back a write scope, and
    // `installSection` is its composition with the entry/base hooks. Register
    // first for the scope, then attach the section so the composition entry
    // stays the base layer and the card can write through `scope.update`.
    const scope = settingsCtx.settings.register('dsh-power-switch', schema, { base: config })
    expose(scope)
    try {
      // The hook hands over a thunk, but a value is accepted too so a host that
      // reads it eagerly cannot silently disable the configuration page.
      settingsCtx.settings.installSection(owner, 'dsh-power-switch', schema, config, {
        setSource: (source) => {
          publish(resolveConfig(typeof source === 'function' ? source() : source, undefined))
        },
        onChange: () => {},
      })
    } catch {
      // A host whose installSection differs still has a working scope above.
      publish(resolveConfig(scope.get(), undefined))
    }
  })().catch(() => {
    // A settings surface is a convenience; failing to mount it must never cost
    // the user the shutdown route itself.
  })
}

/**
 * Load the schema builder the HOST provides.
 *
 * Measured failure this replaces: a plugin installed into the profile's
 * `node_modules` cannot resolve `@deepseek-ai/schemastery` at all — npm does not
 * carry it, the runtime injects it — so `buildSchema` failed, the settings
 * section was skipped, and a switched mode no longer survived a restart. Only the
 * dev `link:` layout could see it, through a junction one directory above the
 * package, which is exactly why "it works on my machine" hid it.
 *
 * The running host's own entry point resolves it in every layout (verified for a
 * node_modules install, a dev link AND the host), so that is the first referrer;
 * the plugin's own location stays as the fallback for a layout that hoists it.
 * @returns the schema builder, or null when no referrer could reach it.
 */
async function loadSchemaBuilder() {
  const referrers = schemasteryReferrers({
    hostEntry: typeof process.argv[1] === 'string' && process.argv[1] !== ''
      ? pathToFileURL(process.argv[1]).href
      : '',
    self: import.meta.url,
  })
  for (const referrer of referrers) {
    try {
      const resolved = createRequire(referrer).resolve('@deepseek-ai/schemastery')
      const loaded = await import(pathToFileURL(resolved).href)
      const z = loaded.default ?? loaded
      if (typeof z?.object === 'function') return z
    } catch {
      // Try the next referrer.
    }
  }
  return null
}

/**
 * Build the section schema, or nothing when schemastery cannot be resolved.
 *
 * When that fails there is no configuration page — but the shutdown button, the
 * card, and the switch itself all keep working, so it is reported and not fatal.
 * It is reported because the failure is otherwise invisible: the only symptom is
 * a mode that does not survive a cold start.
 * @param note - the shared log sink.
 * @returns the schema, or undefined when none could be built.
 */
async function buildSchema(note) {
  const z = await loadSchemaBuilder()
  if (z === null) {
    note('schemastery is not resolvable (neither the host nor this package provides it); the settings section is skipped, so a switched mode is not persisted across a restart')
    return undefined
  }
  return z.object({
    launchMode: z.union([z.const('tab'), z.const('app')]).default('tab')
      .description('下次启动 DSH 时用什么窗口打开这个页面：tab = 普通标签页（关闭时按 Ctrl+W），app = 应用窗口（关闭后页面会自己消失）。'),
    delayMs: z.number().step(1).min(0).max(30_000).default(1000)
      .description('点击「关闭」后、进程真正退出前的等待毫秒数：先把 HTTP 响应送出去，再开始优雅退出。'),
    exitCode: z.number().step(1).min(0).max(255).default(0)
      .description('进程退出码。0 表示正常关闭。'),
    hard: z.boolean().default(false)
      .description('跳过优雅退出，直接强制结束进程。仅在你需要立刻断开时开启。'),
  })
}
