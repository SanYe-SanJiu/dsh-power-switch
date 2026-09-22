/**
 * Pure half of the power-switch host plugin: request trust checks, the
 * bounded shutdown scheduler, and the HTTP route body.
 *
 * Every effect enters through an injected function, so the whole thing is
 * testable without a live Cordis tree, a real server, or a real process exit.
 * `index.js` owns only the wiring.
 */

import { join } from 'node:path'

/** Route the card calls. Exact path, POST only. */
export const POWER_ROUTE = '/api/dsh-power-switch/shutdown'

/** Route the card asks to place (or repair) the desktop shortcut from. */
export const SHORTCUT_ROUTE = '/api/dsh-power-switch/shortcut'

/** Default delay between answering the request and leaving. */
export const DEFAULT_DELAY_MS = 1000

/** Upper bound a request may ask for. */
export const MAX_DELAY_MS = 30_000

/** Exit code used when a request names none. */
export const DEFAULT_EXIT_CODE = 0

/** Loopback literals a browser on this machine presents. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Headers that mean the loopback peer is a proxy, not the person. */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host']

/**
 * Whether an Origin URL is the http(s) scheme and exactly this authority.
 * @param origin - the `Origin` header value.
 * @param host - the `Host` header value.
 * @returns true when they name the same authority over http(s).
 */
function sameAuthority(origin, host) {
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/**
 * Whether a READ request came from this Web host on loopback.
 *
 * Deliberately laxer than {@link isTrustedRequest}, because of a MEASURED
 * browser fact: a same-origin `GET` carries NO `Origin` header (only non-GET
 * requests do), so requiring one refused the page's own read every time. What
 * makes the laxer rule safe is that a GET changes nothing: a cross-origin page
 * can still make the browser SEND it, but it cannot read the response, so
 * nothing leaks and nothing happens.
 * @param request - the incoming request.
 * @returns true when the read may be answered.
 */
export function isTrustedReadRequest(request) {
  const address = request.socket?.remoteAddress
  if (!LOOPBACK.has(address)) return false
  for (const name of FORWARDING_HEADERS) {
    if (request.headers[name] !== undefined) return false
  }
  const origin = request.headers.origin
  const host = request.headers.host
  // Absent Origin on a same-origin GET is the normal browser shape. A missing
  // Host is still refused: without it there is nothing to check an Origin
  // against, and "cannot be checked" is not the same as "ours".
  if (host === undefined) return false
  if (origin === undefined) return true
  return sameAuthority(origin, host)
}

/**
 * Whether a process-control request came from this Web host on loopback.
 *
 * Same fence the market's restart route uses: a loopback peer, no forwarding
 * trace, and an `Origin` that matches the `Host` the browser reached us on.
 * A missing Origin is a refusal here — unlike a read, every browser sends one on
 * a same-origin POST, so its absence means a script rather than a person.
 * @param request - the incoming request.
 * @returns true when the request is the person's own browser on this machine.
 */
export function isTrustedRequest(request) {
  const address = request.socket?.remoteAddress
  if (!LOOPBACK.has(address)) return false
  for (const name of FORWARDING_HEADERS) {
    if (request.headers[name] !== undefined) return false
  }
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  return sameAuthority(origin, host)
}

/**
 * Read the process-control body a card may send.
 *
 * Every field is optional and clamped; an absent or malformed field falls back
 * to the configured default rather than refusing, because the button's job is
 * to leave and a wrong number is not worth an error the user cannot act on.
 * @param raw - the parsed request body, or undefined.
 * @param config - the resolved plugin configuration.
 * @returns the exit code, the delay, and whether to skip graceful disposal.
 */
export function readShutdownRequest(raw, config) {
  const body = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const delayMs = clampInteger(body.delayMs, 0, MAX_DELAY_MS, config.delayMs)
  const code = clampInteger(body.code, 0, 255, config.exitCode)
  const hard = typeof body.hard === 'boolean' ? body.hard : config.hard
  return { code, delayMs, hard }
}

/**
 * Clamp one value to an integer range.
 * @param value - the candidate.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @param fallback - value used when the candidate is not a finite number.
 * @returns the clamped integer.
 */
function clampInteger(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const truncated = Math.trunc(value)
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
}

/**
 * Build the bounded shutdown scheduler.
 *
 * SUPERSEDED by {@link createExitResponder} and kept only until the last caller
 * is migrated: the responder fixes what this could not, namely an exit that
 * survives a graceful route which throws, hangs, or never returns. Nothing in
 * `src/` calls this. Do not add a caller back -- the exit must stay one path so
 * the launch mode can only ever change what happens AFTER the process is gone.
 * @deprecated use {@link createExitResponder}.
 * @param deps - the two ways out and an optional delay override.
 * @returns a function that schedules one exit, ignoring further calls.
 */
export function createShutdownScheduler(deps) {
  const { gracefulExit, forceExit, delayMs = DEFAULT_DELAY_MS } = deps
  let scheduled = false

  return (options) => {
    if (scheduled) return false
    scheduled = true
    const hold = options.delayMs ?? delayMs
    const leave = () => {
      try {
        if (options.hard) forceExit(options.code)
        else if (typeof gracefulExit === 'function') gracefulExit(options.code)
        else forceExit(options.code)
      } catch {
        try { forceExit(options.code) } catch { /* the process is already leaving */ }
      }
    }
    const timer = setTimeout(leave, hold)
    timer.ref?.()
    return true
  }
}

/** Minimal JSON response. */
export function sendJson(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  })
  response.end(body)
}

/** How long to wait for a written response to reach the client before forcing exit. */
export const RESPONSE_FLUSH_MS = 1200

/**
 * How long after the graceful request to allow disposal before exiting anyway.
 *
 * This must sit ABOVE the CLI's own bound, not below it. `dsh` gives its
 * disposal 5000 ms (`PROCESS_SHUTDOWN_TIMEOUT_MS`) before forcing its own exit,
 * and that disposal is where sessions are written to disk. A watchdog that fired
 * first would not "rescue" anything -- it would pre-empt the flush this plugin
 * exists to protect, turning a graceful shutdown into a data-loss shutdown. So
 * it is deliberately the LAST resort, after the CLI's own deadline has passed.
 */
export const EXIT_WATCHDOG_MS = 6500

/**
 * Work out when each step of an exit should run.
 *
 * Pure and synchronous on purpose: the timing was the part that could silently
 * evaporate before, so it is separated from the timers that carry it out.
 *
 * `hard` skips the graceful request entirely. Otherwise the graceful request is
 * followed by a WATCHDOG that runs regardless of what the graceful route did --
 * including a graceful call that throws or never returns, which is exactly the
 * case that used to leave the process alive while the page waited.
 * @param options - the exit code and whether to skip graceful disposal.
 * @param flushMs - grace for the HTTP response to reach the browser.
 * @param watchdogMs - grace for disposal before the process is ended anyway.
 * @returns the moments, in milliseconds from now.
 */
export function createExitPlan(options, flushMs = RESPONSE_FLUSH_MS, watchdogMs = EXIT_WATCHDOG_MS) {
  const hard = options.hard === true
  return {
    hard,
    /** When the graceful request is made, or null when there is none. */
    gracefulAtMs: hard ? null : flushMs,
    /** When the process is ended unconditionally. */
    forceAtMs: flushMs + (hard ? 0 : watchdogMs),
  }
}

/**
 * Answer a request, then end the process.
 *
 * Nothing between the answer and the end is load-bearing: the graceful request
 * gets its window and the force step is on a timer registered BEFORE it, so a
 * graceful route that throws, hangs, or is absent cannot stop it. `forceExit` is
 * a direct `process.exit`, which no plugin disposal can stall.
 *
 * Two modes, one exit: the launch mode decides what happens AFTER the process
 * is gone (the helper reopens a tab or an app window), never whether it goes.
 * @param deps - the two exit routes, a diagnostics sink, and the two timings.
 * @returns a function that answers, then leaves. It returns a promise that
 *   settles once the exit has been handed over (the watchdog stood down, or it
 *   fired); a production caller ignores it, a test awaits it instead of guessing
 *   at timings.
 */
export function createExitResponder(deps) {
  const {
    gracefulExit,
    forceExit,
    note,
    flushMs = RESPONSE_FLUSH_MS,
    watchdogMs = EXIT_WATCHDOG_MS,
  } = deps
  let scheduled = false
  return (response, status, payload, options) => {
    sendJson(response, status, payload)
    if (scheduled) return Promise.resolve('already-scheduled')
    scheduled = true
    const plan = createExitPlan(options, flushMs, watchdogMs)
    // Tell the operator what was decided BEFORE anything irreversible, so the
    // relaunch helper's log records why the death happened.
    note?.(`exit requested: code=${String(options.code)} hard=${String(plan.hard)} gracefulAt=${String(plan.gracefulAtMs)}ms forceAt=${String(plan.forceAtMs)}ms graceful=${typeof gracefulExit === 'function' ? 'yes' : 'no'}`)

    if (plan.gracefulAtMs === null) {
      // Nothing to wait for: the hard stop IS the exit, forced immediately
      // rather than after a window that no longer means anything.
      note?.('hard stop: skipping graceful disposal and ending the process now')
      forceExit(options.code)
      return Promise.resolve('hard')
    }
    if (typeof gracefulExit !== 'function') {
      // No graceful route is not "graceful settled": there is nothing to hand
      // over to, so waiting for it would be waiting for a call that will never
      // be made.
      note?.('no graceful exit available; ending the process now')
      forceExit(options.code)
      return Promise.resolve('hard')
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        const graceful = Promise.resolve()
          .then(() => gracefulExit(options.code))
          .then(() => 'settled', (error) => {
            // A graceful request that THREW did not hand anything over, so this
            // is a failure to escalate, not a settled exit to stand down for.
            note?.(`graceful exit failed: ${String(error?.message ?? error)}`)
            return 'failed'
          })
        void armWatchdog(graceful, options.code, plan, forceExit, note).then(resolve)
      }, plan.gracefulAtMs)
    })
  }
}

/**
 * End the process unless the graceful request settles first.
 *
 * A race, not a timer plus a floating continuation: `Promise.race` settles on
 * whichever finishes first and leaves nothing attached to the pending side. A
 * `.then` on a graceful request that never settles keeps a continuation alive
 * for the lifetime of the process, which is a handle leak in a function whose
 * entire job is to end one.
 *
 * Outcomes: `'stood-down'` (graceful settled in time), `'fired'` (it did not),
 * `'failed'` (it threw, so the exit is forced at once rather than waiting out a
 * window it can no longer use).
 * @param graceful - resolves to `'settled'` or `'failed'`, or never settles.
 * @param code - exit code to force with.
 * @param plan - the moments computed by {@link createExitPlan}.
 * @param forceExit - the direct exit.
 * @param note - diagnostics sink.
 * @returns the outcome of the watchdog.
 */
function armWatchdog(graceful, code, plan, forceExit, note) {
  const windowMs = plan.forceAtMs - plan.gracefulAtMs
  let timer
  const window = new Promise((resolve) => {
    timer = setTimeout(() => { resolve('watchdog') }, windowMs)
  })
  return Promise.race([graceful, window]).then((outcome) => {
    // Clear the loser. A race decides the OUTCOME, not the handles: the timer
    // that lost is still a live handle, and a live handle is exactly what stops
    // a process from exiting -- a strange thing for the function whose job is to
    // end one to leave behind.
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === 'settled') {
      note?.('graceful exit settled; the watchdog stands down')
      return 'stood-down'
    }
    if (outcome === 'failed') {
      note?.('graceful exit failed outright; forcing the exit now')
      forceExit(code)
      return 'failed'
    }
    note?.(`watchdog: the graceful request has not settled after ${String(windowMs)}ms; ending the process`)
    forceExit(code)
    return 'fired'
  })
}

/**
 * Read a request body as JSON, tolerating an absent or malformed one.
 * @param request - the incoming request.
 * @param limitBytes - maximum accepted body size.
 * @returns the parsed body, or null.
 */
export async function readJsonBody(request, limitBytes = 8 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new Error('power button: request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Build the shutdown route handler.
 *
 * Answer first, leave second -- and the leaving cannot evaporate: the shared
 * exit responder escalates to a direct `process.exit` after the graceful window,
 * so a plugin whose disposal stalls can no longer keep the process alive while
 * the page waits.
 * @param deps - current configuration and the exit responder.
 * @returns a `webServer` route handler.
 */
export function createPowerHandler(deps) {
  const { config, exitWith } = deps
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!isTrustedRequest(request)) {
      sendJson(response, 403, { ok: false, error: 'untrusted request' })
      return
    }
    let body = null
    try {
      body = await readJsonBody(request)
    } catch {
      sendJson(response, 400, { ok: false, error: 'invalid body' })
      return
    }
    const still = config()
    const request_ = readShutdownRequest(body, still)
    exitWith(response, 200, {
      ok: true,
      shuttingDown: true,
      code: request_.code,
      delayMs: request_.delayMs,
      hard: request_.hard,
      pid: process.pid,
    }, request_)
  }
}

/**
 * Build the restart-handler.
 *
 * Saving a launch mode only matters for the NEXT launch, and the choice is
 * worthless if it means editing a file by hand and running a script -- so this
 * bridge does the whole gesture: persist, start the detached relaunch helper,
 * WAIT for it to prove it is up, answer the card, then leave through the same
 * graceful path the shutdown button uses.
 *
 * The waiting step is the difference between an error and an outage. Starting a
 * detached helper only proves a process was forked; if that helper then fails --
 * a locked log, a wrong path -- the host has already exited and the person is
 * left on a reconnecting page with nothing coming back. So the host refuses to
 * leave until the helper has checked in, and reports a refusal it can act on.
 * @param deps - configuration, persistence, the respawn hook, its handshake
 *   waiter, the exit responder, and `planProblem()` — which names WHY this host
 *   cannot be replaced (`{ reason, message }`), so the card can show localized
 *   copy for a known refusal instead of an English host error.
 * @returns a `webServer` route handler.
 */
export function createRestartHandler(deps) {
  const { config, persist, respawn, awaitRespawn, exitWith, planProblem } = deps
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!isTrustedRequest(request)) {
      sendJson(response, 403, { ok: false, error: 'untrusted request' })
      return
    }
    let body = null
    try {
      body = await readJsonBody(request)
    } catch {
      sendJson(response, 400, { ok: false, error: 'invalid body' })
      return
    }
    const requested = body !== null && typeof body === 'object' ? body.launchMode : undefined
    if (requested !== undefined && requested !== 'app' && requested !== 'tab') {
      sendJson(response, 400, { ok: false, error: 'launchMode must be "app" or "tab"' })
      return
    }
    const mode = normalizeLaunchMode(requested ?? config().launchMode)
    const persisted = persist(mode)
    const started = respawn(mode)
    const pid = started === null ? null : started.pid
    if (pid === null) {
      // A stable CODE travels with the message. The card shows localized copy for
      // the known refusals instead of pasting an English host error at somebody
      // reading a Chinese page, and the message stays as the diagnostic detail.
      const problem = typeof planProblem === 'function' ? planProblem() : null
      sendJson(response, 500, {
        ok: false,
        persisted,
        launchMode: mode,
        reason: problem?.reason ?? 'helper-unavailable',
        error: problem?.message ?? 'the relaunch helper could not be started, so nothing would bring the service back',
      })
      return
    }
    if (started.handshake !== undefined && typeof awaitRespawn === 'function') {
      const confirmed = await awaitRespawn(started.handshake)
      if (!confirmed) {
        sendJson(response, 500, {
          ok: false,
          persisted,
          launchMode: mode,
          reason: 'helper-not-confirmed',
          error: 'the relaunch helper started but never confirmed it was up; NOT restarting, so the service stays available',
        })
        return
      }
    }
    const still = config()
    exitWith(response, 200, {
      ok: true,
      restarting: true,
      launchMode: mode,
      persisted,
      helperPid: pid,
      delayMs: still.delayMs,
      code: still.exitCode,
      hard: still.hard,
    }, { code: still.exitCode, delayMs: still.delayMs, hard: still.hard })
  }
}

/** The shortcut operations the card may ask for, and nothing else. */
export const SHORTCUT_ACTIONS = ['scan', 'install', 'restore']

/**
 * Build the route that checks, installs or restores the desktop shortcut.
 *
 * The card sends exactly one thing: which of the three operations it wants. It
 * cannot send a path, a name or a target -- the host derives all of those from its
 * own install location -- so this can never become a "write a shortcut to
 * anywhere" primitive. That is the whole security argument for a route whose
 * effect lands outside the package, and it is why the action is checked against a
 * fixed list rather than passed through.
 *
 * `scan` is read-only on purpose, and it is what makes adopting an existing
 * shortcut safe to offer: the person can see which icon was recognised before
 * anything is rewritten.
 * @param deps - the hook that performs the operation.
 * @returns a `webServer` route handler.
 */
export function createShortcutHandler(deps) {
  const { run } = deps
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    // A write, so the strict fence applies: loopback peer, no forwarding headers,
    // and an Origin that matches the Host exactly.
    if (!isTrustedRequest(request)) {
      sendJson(response, 403, { ok: false, error: 'untrusted request' })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch {
      sendJson(response, 400, { ok: false, error: 'invalid body' })
      return
    }
    const requested = body !== null && typeof body === 'object' ? body.action : undefined
    if (requested !== undefined && !SHORTCUT_ACTIONS.includes(requested)) {
      sendJson(response, 400, { ok: false, error: 'action must be "scan", "install" or "restore"' })
      return
    }
    let result
    try {
      result = await run(requested ?? 'install')
    } catch (error) {
      sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
      return
    }
    sendJson(response, result.ok === true ? 200 : 500, result)
  }
}

/** Executables whose command line decides whether a shortcut starts DSH. */
const SCRIPT_HOSTS = new Set([
  'wscript.exe', 'cscript.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'node.exe', 'nodejs.exe',
])

/** Binstubs of the DSH CLI itself. */
const DSH_TARGETS = new Set(['dsh', 'dsh.cmd', 'dsh.exe', 'dsh.ps1', 'dsh.bat'])

/** The file name of a path, lowercased, for comparing an executable. */
function executableName(target) {
  return String(target).split(/[\\/]/u).pop()?.toLowerCase() ?? ''
}

/**
 * Classify one desktop shortcut, for this plugin's purposes only.
 *
 * `'ours'` is a shortcut already pointing at the packaged launcher, `'dsh'` starts
 * DSH some other way and is therefore worth adopting, and `'other'` is none of this
 * plugin's business.
 *
 * The rules are narrow on purpose -- adopting the wrong icon rewrites somebody's
 * unrelated shortcut -- and they were broadened in one place for one MEASURED
 * reason. A real DSH shortcut on this machine looked like
 *
 *     target: wscript.exe
 *     args:   "D:\somewhere\dsh\start-dsh-web.vbs"
 *     name:   DeepSeek Harness.lnk
 *
 * and the old rule, which wanted the literal text `" web"` in the arguments, missed
 * it: the path spells `dsh-web`, not `dsh web`. So now a script host whose command
 * line -- or name, or working directory, or description -- MENTIONS dsh or deepseek
 * counts, while a shortcut to a browser, a game launcher or a chat app still does
 * not, because the target must be an interpreter rather than an application.
 * @param entry - one scan row: `{ path, name, target, args, workdir, description }`.
 * @param launcher - the packaged `launch-dsh.vbs` absolute path.
 * @returns `'ours'`, `'dsh'` or `'other'`.
 */
export function classifyShortcut(entry, launcher) {
  const target = String(entry?.target ?? '')
  const args = String(entry?.args ?? '')
  const base = executableName(target)
  if (base === '') return 'other'
  if (args.toLowerCase().includes(String(launcher).toLowerCase())) return 'ours'

  const haystack = [target, args, entry?.workdir, entry?.description, entry?.name, entry?.path]
    .map((part) => String(part ?? '').toLowerCase())
    .join(' ')
  // The Electron desktop app is a different product with its own shell; taking over
  // its icon would be worse than doing nothing. Both checks precede the "ours" one
  // below so that a launcher living under a path with these words cannot be lost.
  if (haystack.includes('desktop-host') || haystack.includes('electron')) return 'other'
  if (haystack.includes('dsh-power-switch')) return 'ours'

  if (DSH_TARGETS.has(base)) return 'dsh'
  if ((base === 'node.exe' || base === 'nodejs.exe') && haystack.includes('bin.js')) return 'dsh'
  if (SCRIPT_HOSTS.has(base) && (haystack.includes('dsh') || haystack.includes('deepseek'))) return 'dsh'
  return 'other'
}

/**
 * Decide what to do with the desktop, from one scan.
 *
 * The card is told about DSH-related icons ONLY. Reading every shortcut's target is
 * unavoidable -- no file name says which icon starts DSH -- but listing somebody's
 * unrelated icons is not this plugin's business; the rest are counted, and the full
 * list stays in the result file for a diagnosis.
 * @param entries - the scan rows.
 * @param launcher - the packaged launcher's absolute path.
 * @returns `{ action, path?, candidates, entries, others }`, where `action` is
 *   `'adopt'`, `'create'` or `'ambiguous'`.
 */
export function chooseShortcutAction(entries, launcher) {
  const classified = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ ...entry, kind: classifyShortcut(entry, launcher) }))
  const related = classified.filter((entry) => entry.kind !== 'other')
  const adoptable = classified.filter((entry) => entry.kind === 'dsh')
  const others = classified.length - related.length
  if (adoptable.length === 1) {
    return { action: 'adopt', path: adoptable[0].path, candidates: [], entries: related, others }
  }
  if (adoptable.length === 0) {
    return { action: 'create', candidates: [], entries: related, others }
  }
  // Refuse rather than guess: rewriting the wrong icon is worse than stopping.
  return {
    action: 'ambiguous',
    candidates: adoptable.map((entry) => entry.path),
    entries: related,
    others,
  }
}

/**
 * Parse the shortcut helper's result file.
 *
 * The format is one `key=value` per line, because that is what VBScript can write
 * without a JSON library, and the split is on the FIRST `=` so a path containing
 * The text arrives already decoded from UTF-16.
 *
 * Every row is returned here. The FILTER is the caller's: `chooseShortcutAction`
 * classifies each row and returns only the DSH-related ones, because reading
 * every desktop shortcut's target is unavoidable but putting the person's
 * unrelated icons on the card is not this plugin's business. Keeping the two
 * apart is also what makes the classifier testable — it is JS, not `.vbs`.
 * @param text - the helper's result file contents.
 * @returns the parsed keys, plus every scan row as `entries` and the ambiguous
 *   install candidates as `candidates`.
 */
export function parseShortcutResult(text) {
  const flat = {}
  for (const line of String(text).replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    if (line === '') continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    flat[line.slice(0, at)] = line.slice(at + 1)
  }
  const entries = []
  for (let index = 0; flat[`lnk${String(index)}`] !== undefined; index += 1) {
    entries.push({
      path: flat[`lnk${String(index)}`],
      name: flat[`name${String(index)}`] ?? '',
      target: flat[`target${String(index)}`] ?? '',
      args: flat[`args${String(index)}`] ?? '',
      workdir: flat[`workdir${String(index)}`] ?? '',
      description: flat[`desc${String(index)}`] ?? '',
    })
  }
  const candidates = []
  for (let index = 0; flat[`candidate${String(index)}`] !== undefined; index += 1) {
    candidates.push(flat[`candidate${String(index)}`])
  }
  return { ...flat, entries, candidates }
}

/**
 * Resolve the plugin configuration from an entry and a possible settings layer.
 * @param entry - the `config` block of the loader row.
 * @param section - the resolved settings section, when one is attached.
 * @returns the effective configuration.
 */
export function resolveConfig(entry, section) {
  const source = section ?? entry ?? {}
  const delayMs = clampInteger(source.delayMs, 0, MAX_DELAY_MS, DEFAULT_DELAY_MS)
  const exitCode = clampInteger(source.exitCode, 0, 255, DEFAULT_EXIT_CODE)
  return { delayMs, exitCode, hard: source.hard === true, launchMode: normalizeLaunchMode(source.launchMode) }
}

/** Launch modes the plugin understands. */
export const LAUNCH_MODES = ['tab', 'app']

/** Environment switch that stops the startup window for one launch. */
export const NO_WINDOW_ENV = 'DSH_POWER_SWITCH_NO_WINDOW'

/**
 * Environment marker meaning somebody else is opening this boot's window.
 *
 * Set by the three processes that open a window on purpose: the switch
 * supervisor, the packaged desktop launcher, and the standalone restart script.
 * Without it the plugin would open a SECOND window on those paths.
 */
export const WINDOW_HANDLED_ENV = 'DSH_POWER_SWITCH_WINDOW_HANDLED'

/**
 * Whether this boot needs the plugin to open its own window.
 *
 * DSH's `dsh web` hands its URL to the default browser, so DSH itself always
 * opens a TAB: there is no app-window flag and the hand-off runs with a scrubbed
 * environment, so no plugin can influence it. Opening the window here is what
 * makes the card's "next launch" setting true for a launch the person starts
 * themselves, and not only for the switch that restarts DSH.
 *
 * Deliberately narrow, and both narrowings are load-bearing:
 *
 *  - `'app'` only. Tab mode is already served by DSH's own opener, so acting
 *    there would produce two tabs, which is worse than doing nothing.
 *  - opt-out and marker respected. A script that wants no browser at all sets
 *    the opt-out; the three deliberate openers set the marker.
 *
 * Pure so it can be tested without a context, a server, or a browser.
 * @param mode - the effective launch mode for the next window.
 * @param env - the process environment.
 * @returns true when the plugin should open the startup window itself.
 */
export function shouldOpenStartupWindow(mode, env = {}) {
  if (env[NO_WINDOW_ENV] === '1') return false
  if (env[WINDOW_HANDLED_ENV] === '1') return false
  return mode === 'app'
}

/** Route the card reads the effective configuration from. */
export const CONFIG_ROUTE = '/api/dsh-power-switch/config'

/** Route the card asks to save a launch mode and restart into it. */
export const RESTART_ROUTE = '/api/dsh-power-switch/restart'

/**
 * Pull the token URL out of a restart helper's output.
 *
 * The helper prints `dsh web: <url>` once the replacement is serving. Reading it
 * is the whole point of letting the helper own the relaunch: it waits for the
 * port, so its URL line is the only reliable "the replacement is up" signal.
 * @param text - the helper's captured stdout.
 * @returns the URL, or null when the helper has not announced one yet.
 */
export function parseHelperUrl(text) {
  return /https?:\/\/[^\s"']+\?token=[A-Za-z0-9_-]+/u.exec(text)?.[0] ?? null
}

/**
 * Coerce a stored launch-mode value.
 * @param value - the candidate.
 * @returns `'app'` or `'tab'`; anything else resolves to `'tab'`, which is what
 *   an unconfigured `dsh web` does.
 */
export function normalizeLaunchMode(value) {
  return value === 'app' ? 'app' : 'tab'
}

/**
 * Build the configuration route handler.
 *
 * The card needs to know the mode the NEXT launch should use, and it cannot
 * read the settings document itself: that surface is the host's. This exposes
 * exactly the three fields the card reasons about, and nothing else.
 * @param deps - current configuration.
 * @returns a `webServer` route handler.
 */
export function createConfigHandler(deps) {
  const { config } = deps
  return (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    if (!isTrustedReadRequest(request)) {
      sendJson(response, 403, { ok: false, error: 'untrusted request' })
      return
    }
    const current = config()
    sendJson(response, 200, {
      ok: true,
      launchMode: current.launchMode,
      delayMs: current.delayMs,
      exitCode: current.exitCode,
      hard: current.hard,
    })
  }
}

/**
 * CRITICAL LESSON — why the relaunch command is captured, never guessed.
 *
 * The first version rebuilt it: `<repoRoot>/apps/cli/lib/bin.js` plus a literal
 * `web --no-open`, with `repoRoot` defaulting to the author's checkout. On any
 * other machine that file does not exist, `spawn` fails asynchronously, the
 * supervisor had ALREADY written its handshake — so the host exited believing a
 * replacement was coming, and DSH stayed down for good. Deriving the command
 * from the live process removes both the guess and the failure mode.
 */

/**
 * The environment the detached restart helper is spawned with.
 *
 * The PORT is the one this host actually serves on, not a default. The helper
 * probes for the live host on it and filters the host's own recorded URL by it,
 * so a DSH configured for another port would otherwise be told to look at 3080,
 * find nothing, and refuse — safe, but useless to the person clicking.
 *
 * Pure, so this plumbing is testable without spawning a process.
 * @param options - `{ mode, hostLog, handshake, port }`.
 * @returns the environment overrides (the caller merges them over `process.env`).
 */
export function restartHelperEnv(options) {
  const { mode, hostLog, handshake, port } = options
  const env = {
    DSH_POWER_SWITCH_LAUNCH_MODE: mode,
    DSH_POWER_SWITCH_DELAY: '1',
    DSH_POWER_SWITCH_HOST_LOG: hostLog,
    DSH_POWER_SWITCH_HANDSHAKE: handshake,
  }
  if (typeof port === 'number' && Number.isFinite(port) && port > 0) {
    env.DSH_POWER_SWITCH_PORT = String(port)
  }
  return env
}

/**
 * Whether an argument list looks like the `dsh` web server entry point.
 *
 * Deliberately loose about the spelling (`dsh web`, `dsh --profile web`,
 * `dsh web --host …`) and strict about the conclusion: a host that was NOT
 * started as a CLI web server cannot be replaced by re-running its own argv.
 * That is the Electron/desktop case, and refusing there is correct — the
 * handshake is withheld and the running host keeps serving.
 * @param rest - the arguments after the script path.
 * @returns true when re-running them should start the same web server.
 */
export function looksLikeDshWeb(rest) {
  return rest.includes('web') || rest.includes('--profile')
}

/**
 * The command that restarts this exact host, from the host's own process facts.
 *
 * `--no-open` is forced on (and de-duplicated) because the caller — the
 * supervisor or the desktop launcher — opens the window itself: letting the
 * replacement hand the URL to the default browser would produce a second tab
 * on top of the chosen shape.
 *
 * Pure apart from the injected `exists` probe, so the whole decision is testable
 * without spawning anything.
 * @param boot - `{ execPath, execArgv, argv, cwd }` as read from the live process.
 * @param exists - file-existence probe, injected for tests.
 * @returns `{ execPath, args, cwd }`, or `{ error }` describing why it is unusable.
 */
export function relaunchPlan(boot, exists = () => true) {
  const execPath = typeof boot?.execPath === 'string' ? boot.execPath : ''
  if (execPath === '') return { error: 'the running host reported no executable path' }
  const argv = Array.isArray(boot?.argv)
    ? boot.argv.filter((value) => typeof value === 'string' && value !== '')
    : []
  if (argv.length === 0) return { error: 'the running host reported no command line' }
  const script = argv[0]
  if (!exists(script)) return { error: `the boot script is gone: ${script}` }
  const rest = argv.slice(1)
  if (!looksLikeDshWeb(rest)) {
    return { error: `this host was not started as a dsh web server (${rest.join(' ')}), so it cannot be restarted by replaying its own command line` }
  }
  const execArgv = Array.isArray(boot?.execArgv)
    ? boot.execArgv.filter((value) => typeof value === 'string')
    : []
  const args = [...execArgv, script, ...rest.filter((value) => value !== '--no-open'), '--no-open']
  const cwd = typeof boot?.cwd === 'string' && boot.cwd !== '' ? boot.cwd : undefined
  return { execPath, args, cwd }
}
