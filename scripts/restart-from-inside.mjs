/**
 * Restart the DSH web host from INSIDE the host process.
 *
 * Detached-child experiments from outside turned out to be unreliable in this
 * environment: a child started by the harness's own shell gets reaped, and the
 * two attempts left the host stopped with no replacement. The proven mechanism
 * is the one `dshmarket` uses for its restart button -- the host process itself
 * spawns a detached helper, which therefore is not in the harness's process
 * tree and survives the host's exit.
 *
 * Flow: start the supervisor detached, ask the plugin's own shutdown route for a
 * graceful exit, and let the supervisor relaunch the same command line once the
 * port is released and then prove the plugin's client bundle came up.
 *
 * Usage: node scripts/restart-from-inside.mjs
 */

import { spawn } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureStateDir, logPath, readBootRecord, readRecordedTokenUrl, resolveProbePort, settingsPath, stateDir } from './restart-shared.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * The port to work on: passed down by the host, DERIVED when it was not.
 *
 * The host hands over its own port, and that is the normal path. It can also be
 * missing: the port is recorded inside an async callback that polls the Web
 * server for up to 10 s, so a restart asked for in the first moments of a boot
 * spawns this helper with no `DSH_POWER_SWITCH_PORT`, and the old default here
 * was 3080 — on a machine serving elsewhere that is the wrong port, so the helper
 * would look for a host that is not there and refuse.
 *
 * Deriving it costs nothing and cannot be worse: the boot record and the URL the
 * host wrote about itself are both readable from the state directory.
 */
const envPort = Number(process.env.DSH_POWER_SWITCH_PORT)
const probe = resolveProbePort({
  explicit: Number.isInteger(envPort) && envPort > 0 ? envPort : null,
  recordedUrl: readRecordedTokenUrl(),
  bootArgs: readBootRecord()?.args ?? [],
})
const port = probe.port
const delaySeconds = Number(process.env.DSH_POWER_SWITCH_DELAY ?? 6)
/**
 * How the replacement should be presented: `'app'` opens a browser app window
 * (which may close itself), `'tab'` opens an ordinary tab. The card's
 * launch-mode control passes this through the environment; which is also how
 * the value survives the shutdown it triggers.
 */
const launchMode = process.env.DSH_POWER_SWITCH_LAUNCH_MODE === 'app' ? 'app' : 'tab'
/**
 * The one log every half of this feature writes to: the plugin's own notes, this
 * helper, and the supervisor it spawns.
 *
 * It lives under the harness home (`$DSH_HOME/storages/dsh-power-switch/`), NOT
 * in the package. Two reasons, both learned the hard way: an installed package
 * can sit in a store that refuses writes, and the log this file produces carries
 * authenticated `?token=…` URLs plus the machine's own paths — inside the package
 * those go straight into whatever repository holds the checkout.
 *
 * One rule, one file: whatever a restart does is readable in one place.
 */
const STATE_DIR = (() => {
  try {
    return ensureStateDir()
  } catch {
    return stateDir()
  }
})()
const logFile = logPath()

/**
 * Record what this helper is doing, in the file the plugin also writes.
 *
 * This exists because of a real failure: the helper is spawned DETACHED with
 * `stdio: 'ignore'`, so its stdout goes nowhere. A one-word typo in the token
 * lookup made it die with a `ReferenceError` before its first visible act, and
 * the only symptom anywhere was the host refusing to exit three seconds later --
 * no handshake file, no log line, no way to tell "never started" from "started
 * and crashed". Anything this process decides must land in a file.
 * @param message - the line to append.
 */
const log = (message) => {
  try {
    const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false })
    appendFileSync(logFile, `[${stamp}] helper: ${message}\n`)
  } catch {
    // Diagnostics must never be the reason a restart fails.
  }
}

/*
 * Last-resort reporting. The failure above was an ordinary `unhandledRejection`
 * from top-level await, which by default prints to a stdout nobody reads and
 * exits silently. Both nets turn any such crash into a line in the shared log
 * naming the file and line, which is what the next diagnosis needs.
 */
const reportCrash = (label, error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  log(`FAILED (${label}); nothing was restarted: ${detail}`)
  console.error(`dsh-power-switch restart helper: ${label}: ${detail}`)
  process.exit(1)
}
process.on('uncaughtException', (error) => { reportCrash('uncaught exception', error) })
process.on('unhandledRejection', (error) => { reportCrash('unhandled rejection', error) })

// Recorded before anything else: several later refusals are really "the helper
// was looking at the wrong port", and this line is the only place that says
// which port it used and where that number came from.
log(`port ${String(port)} (${probe.source})`)

/**
 * The log the REPLACEMENT host's stdout goes to, first choice then fallback.
 *
 * A per-run name when the plugin spawned us, because the process being replaced
 * has its own stdout redirected into the shared `dsh-web.log` and holds that
 * file open until it is completely gone. Opening a replacement onto that file
 * failed with EBUSY even after the port went quiet -- the port going quiet is
 * not the moment the old process lets go of its output. A fresh name removes the
 * contention instead of racing it.
 *
 * A MANUAL run gets a fresh name too, not just a plugin-spawned one: with no
 * override in the environment it used to fall straight through to the shared log,
 * which is locked by the very host being replaced -- the same EBUSY, hit by the
 * documented hand-run command instead of by the card.
 *
 * The usual name is the fallback so a wrong override path can never be the
 * reason a restart fails: whichever path actually opens is the one the token URL
 * is read back from.
 */
const manualHostLog = join(
  STATE_DIR,
  `dsh-web.${new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)}.log`,
)
const hostLogCandidates = [
  process.env.DSH_POWER_SWITCH_HOST_LOG,
  process.env.DSH_POWER_SWITCH_HOST_LOG === undefined ? manualHostLog : undefined,
  join(tmpdir(), 'dsh-web.log'),
].filter((candidate) => typeof candidate === 'string' && candidate !== '')

/**
 * The file the HOST waits for before it lets itself exit.
 *
 * Carried to the supervisor two independent ways: through the environment, which
 * is how the plugin hands it over, and baked into the supervisor's own source.
 * The host will not exit until this file exists, so a supervisor that cannot
 * write it turns the switch into a refusal -- safe, but a button that does
 * nothing. One carrier is a single point of failure for the whole restart.
 */
const handshakePath = process.env.DSH_POWER_SWITCH_HANDSHAKE ?? ''

/*
 * `storedLaunchMode()` and `findBrowser()` used to be defined HERE while being
 * called only from the generated supervisor -- which is a different scope. Both
 * calls threw `ReferenceError` inside that generated script, right after it had
 * checked in and spawned the replacement, so it died silently and opened no
 * window: the person saw their old tab reconnect and called it "the mode did not
 * change". They now live in `restart-shared.mjs`, which the supervisor imports,
 * so they cannot drift out of the scope that calls them. Keep it that way: a
 * function this file defines but only the supervisor calls is a latent outage.
 */
/** The module the generated supervisor imports its window helpers from. */
const sharedUrl = new URL('./restart-shared.mjs', import.meta.url).href

/**
 * The settings document, resolved HERE because the template can only interpolate
 * a value. `settingsPath` is a function in this scope, so interpolating it put
 * `undefined` into the generated supervisor and the stored launch mode was
 * silently never read there.
 */
const settingsFile = settingsPath()

/**
 * The command that restarts this host, as the host itself recorded it at boot.
 *
 * The supervisor replays THIS instead of rebuilding a path. The rebuilt version
 * was `<repoRoot>/apps/cli/lib/bin.js` — a DSH *source checkout* layout that no
 * other installation has — and when it was wrong `spawn` failed asynchronously,
 * after the supervisor had already checked in, so the host exited and nothing
 * replaced it. A record that cannot be read is treated as "do not check in":
 * the host then keeps serving and the card says why.
 * @returns the plan, or null when this host cannot be replayed.
 */
const boot = readBootRecord()

/**
 * The logs that could hold the RUNNING host's token URL, newest first.
 *
 * A restart changes which file the host writes to. The plugin spawns the
 * replacement with a per-run name (`dsh-web.<stamp>.log`) precisely because the
 * shared `dsh-web.log` stays locked by the process being replaced -- so after one
 * successful restart the shared file holds the PREVIOUS run's token. A lookup
 * that reads one fixed name therefore works once and fails the second time,
 * which is why this orders candidates by modification time instead.
 * @returns candidate log paths, most recently written first.
 */
function currentHostLogs() {
  const found = []
  const scan = (dir) => {
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('dsh-web') && entry.endsWith('.log')) {
          const path = join(dir, entry)
          try {
            found.push({ path, at: statSync(path).mtimeMs })
          } catch {
            // Unreadable metadata only costs this candidate its rank.
          }
        }
      }
    } catch {
      // An unreadable directory just leaves the other candidates.
    }
  }
  // Our own per-run logs first.
  scan(STATE_DIR)
  // Then the HOST'S OWN working directory, taken from the boot record instead of
  // guessed: whatever started this host may have redirected its stdout to
  // `<cwd>/dsh-web.log`. That is exactly where this machine's own launcher puts
  // it, and missing it is what produced `no host token URL in any log`.
  if (boot !== null && boot.cwd !== undefined) scan(boot.cwd)
  found.sort((left, right) => right.at - left.at)
  const ordered = found.map((entry) => entry.path)
  for (const fallback of [join(tmpdir(), 'dsh-web.log')]) {
    if (!ordered.includes(fallback)) ordered.push(fallback)
  }
  return ordered
}

/**
 * Every token URL worth trying, best guess first.
 *
 * The host's OWN record comes first: it wrote down the URL it minted for this
 * run, so nothing has to be scavenged from a log whose location depends on
 * whatever started the host. Reading logs is the fallback for a host whose
 * plugin never got far enough to record one.
 *
 * One log accumulates a token per run, so within a file the freshest token is
 * the LAST match -- hence the reverse walk.
 * @returns candidate token URLs, best guess first.
 */
function tokenUrls() {
  const urls = []
  const recorded = readRecordedTokenUrl()
  // Only when it matches the port being probed: a stale record from a run on
  // another port would otherwise burn the whole probe budget.
  if (recorded !== null && recorded.includes(`:${String(port)}/`)) urls.push(recorded)
  const pattern = new RegExp(`https?://127\\.0\\.0\\.1:${String(port)}/\\?token=[A-Za-z0-9_-]+`, 'gu')
  for (const candidate of currentHostLogs()) {
    let text = ''
    try {
      text = readFileSync(candidate, 'utf8')
    } catch {
      continue
    }
    for (const match of [...text.matchAll(pattern)].reverse()) {
      if (!urls.includes(match[0])) urls.push(match[0])
    }
  }
  return urls
}

/** The plugin's own read route: changes nothing, so it is safe to probe with. */
const CONFIG_PATH = '/api/dsh-power-switch/config'

/**
 * How long one candidate token URL has to answer.
 *
 * This budget is spent BEFORE the supervisor checks in, and the host refuses to
 * exit when that check-in does not arrive inside its own wait. A dead host on
 * loopback refuses the connection instantly, so this only bounds the rare
 * "accepted but never answered" case -- and it has to stay small enough that a
 * couple of stale candidates still fit inside the host's patience.
 */
const PROBE_TIMEOUT_MS = 1500

/**
 * Prove a token belongs to a host that is answering RIGHT NOW.
 *
 * A token from an older log is indistinguishable from a live one by inspection,
 * and using it means asking a process that no longer exists to shut down --
 * which looks exactly like "the switch does nothing". The token is a per-run
 * secret the live host validates, so anything but a 200/303 means this URL
 * belongs to a run that is already gone. The plugin's own read route then
 * confirms it, and is allowed to be inconclusive: it changes nothing, so a
 * refusal there is not evidence about the token.
 * @param url - a candidate token URL.
 * @returns the origin and session cookie to use, or null when nothing live answered.
 */
async function liveHost(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, PROBE_TIMEOUT_MS)
  try {
    const page = new URL(url)
    // Node's fetch has no cookie jar, so the process token is exchanged once for
    // the signed session cookie -- the same handshake a browser makes.
    const handshake = await fetch(url, { redirect: 'manual', signal: controller.signal })
    if (handshake.status !== 303 && handshake.status !== 200) return null
    const cookie = handshake.status === 303 ? (handshake.headers.get('set-cookie') ?? '').split(';')[0] : ''
    const probe = new URL(page.origin)
    probe.pathname = CONFIG_PATH
    try {
      const response = await fetch(probe, {
        signal: controller.signal,
        ...(cookie === '' ? {} : { headers: { cookie } }),
      })
      const body = response.status === 200 ? await response.json().catch(() => null) : null
      log(body?.ok === true
        ? 'confirmed a live host on ' + page.origin
        : 'the live host did not answer the read route (HTTP ' + String(response.status) + '); using the token anyway')
    } catch {
      log('the read-route probe did not answer; using the token anyway')
    }
    return { page, cookie }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The supervisor source: wait, confirm the port frees, relaunch, verify. */
function supervisorSource() {
  return `
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'

const boot = ${JSON.stringify(boot)}
const port = ${String(port)}
const bundleId = 'dsh-power-switch'
const logFile = ${JSON.stringify(logFile)}
// Candidates, not one baked path: the fallback is chosen at RUN time, so a
// single baked value would leave the token-URL readback pointing at a path that
// was never opened.
const hostLogCandidates = ${JSON.stringify(hostLogCandidates)}
let hostLog = hostLogCandidates[0]
/**
 * The file the host waits for before it lets itself exit.
 *
 * It is touched FIRST, before any step that can fail. The host will not leave
 * until this exists, so its absence is the difference between "the restart is in
 * hand" and "the service is about to be down with nobody bringing it back".
 * Read from the environment first, then from the value baked in at spawn time.
 */
const handshake = process.env.DSH_POWER_SWITCH_HANDSHAKE || ${JSON.stringify(handshakePath)}

const log = (message) => {
  const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false })
  try { appendFileSync(logFile, '[' + stamp + '] supervisor: ' + message + '\\n') } catch {}
}

/**
 * Report a failure instead of dying silently.
 *
 * This process is spawned detached with its stdio IGNORED, exactly like the
 * helper -- and it did die silently: a ReferenceError raised at the one point
 * left after the replacement was already serving produced no line anywhere and
 * opened no window, which took a whole debugging round to find. Any uncaught
 * error must name itself in the shared log.
 */
const reportCrash = (label, error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  log('FAILED (' + label + '), so no window was opened: ' + detail)
  process.exit(1)
}
process.on('uncaughtException', (error) => { reportCrash('uncaught exception', error) })
process.on('unhandledRejection', (error) => { reportCrash('unhandled rejection', error) })

/**
 * The window-mode helpers, imported from a real module.
 *
 * Resolved BEFORE the handshake below, and that order is the point: if the
 * module is missing or broken, nothing has been promised to the host yet, so the
 * host refuses to exit and keeps the service up -- instead of going down with
 * nobody left to bring it back.
 */
const { resolveLaunchMode, openWindow, redactToken } = await import(${JSON.stringify(sharedUrl)})
const settingsFile = ${JSON.stringify(settingsFile)}

/**
 * PRE-FLIGHT — why the plan is checked BEFORE the host is told to leave.
 *
 * The handshake is a promise: "something is now responsible for bringing the
 * service back", and the host exits because of it. This file used to write that
 * promise first and only then rebuild a CLI path, so on a machine where the path
 * did not exist the spawn failed ASYNCHRONOUSLY — after the check-in — and the
 * host exited with nobody left to start it. DSH stayed down for good.
 *
 * Failing here instead keeps the running host alive: the switch becomes a
 * refusal the card can explain, which is the only acceptable outcome.
 */
if (boot === null || typeof boot !== 'object' || typeof boot.execPath !== 'string'
  || !Array.isArray(boot.args) || boot.args.length === 0) {
  log('FAILED: this host recorded no restart command, so there is nothing to replay; refusing to check in')
  process.exit(1)
}
if (!existsSync(boot.execPath)) {
  log('FAILED: the recorded interpreter is gone (' + boot.execPath + '); refusing to check in')
  process.exit(1)
}
if (typeof boot.args[0] === 'string' && /\\.(?:m|c)?js$/u.test(boot.args[0]) && !existsSync(boot.args[0])) {
  log('FAILED: the recorded entry point is gone (' + boot.args[0] + '); refusing to check in')
  process.exit(1)
}

/*
 * PROVE a host log can be opened BEFORE checking in.
 *
 * The handshake is a promise to the host that a replacement is on its way, and
 * the host then exits -- nothing else can bring it back. The replacement's stdout
 * needs a file, and when no candidate could be opened this supervisor gave up
 * after its retries, with the host already gone. That is the audit's "the switch
 * kills the service" path, narrowed by the boot-record pre-flight above but not
 * closed by it.
 *
 * Refusing HERE leaves the host running, so the card reports a refusal it can
 * explain. The file is opened and closed rather than held: the real open happens
 * after the old process has exited and released its own handle.
 */
const logProbe = openHostLog()
if (logProbe.stream === null) {
  log('FAILED: no host log can be opened (' + String(logProbe.error?.code ?? 'unknown') + '), so a replacement would have nowhere to write its output; refusing to check in')
  process.exit(1)
}
try { closeSync(logProbe.stream) } catch {}

if (typeof handshake === 'string' && handshake !== '') {
  try { appendFileSync(handshake, 'pid ' + String(process.pid) + '\\n') } catch (error) {
    log('could not write the handshake file: ' + error.message)
  }
}
log('checked in; my job is to bring the service back on port ' + port)

const answers = () => new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port })
  const done = (value) => { socket.destroy(); resolve(value) }
  socket.setTimeout(700)
  socket.once('connect', () => done(true))
  socket.once('error', () => done(false))
  socket.once('timeout', () => done(false))
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

log('waiting for the port to go quiet before relaunching')
const until = Date.now() + 60000
while (Date.now() < until && await answers()) await sleep(250)

/**
 * Give up rather than start a replacement that cannot bind.
 *
 * The old version waited 40 s and then started anyway. With the port still held
 * the replacement died on EADDRINUSE immediately, while the log said "started
 * pid N" -- spawn success was reported as restart success, which is the most
 * misleading thing this helper has done. Starting into a held port is never
 * useful, so this now stops and says what to do.
 */
if (await answers()) {
  log('FAILED: port ' + port + ' is still held after 60 s, so the old process never exited.')
  log('FAILED: not starting a replacement that cannot bind. Stop the process holding the port and start dsh again.')
  process.exit(1)
}
log('port went quiet; waiting a moment for the socket to settle')
await sleep(400)

/**
 * Start the replacement, retrying while the host log is still locked.
 *
 * Two Windows facts shape this. The first version DELETED the host log and then
 * opened it for append, which failed with EBUSY while the dying process still
 * held the file -- and the failure was terminal, so a restart left the service
 * down. The second version retried, but with NO DELAY: all thirty attempts ran
 * inside one second and all thirty failed, which is what "the switch does not
 * restart" turned out to be. So: append, never delete, and give the retries
 * actual time -- the lock is released when the old process is truly gone, and
 * that moment is not observable from the port.
 * @returns true when the spawn succeeded, false when every attempt failed.
 */
/**
 * Open the ONE log the replacement's stdout goes to.
 *
 * A process has a single stdout, so this cannot tee into several files. The
 * candidates are tried in order and the first that opens wins: the per-run name
 * the plugin chose, then the usual dsh-web.log. The usual one is routinely
 * still locked by the process being replaced, which is the whole reason a
 * per-run name exists.
 * @returns the opened stream and its path, or null when none could be opened.
 *
 * Declared as a FUNCTION, not a const arrow: the pre-flight above calls it
 * before the handshake, and a const binding is in the temporal dead zone until
 * its line runs -- which would have turned the new guard into a crash instead of
 * a refusal.
 */
function openHostLog() {
  let lastError = null
  for (const candidate of hostLogCandidates) {
    try {
      return { stream: openSync(candidate, 'a'), path: candidate }
    } catch (error) {
      lastError = error
    }
  }
  return { stream: null, path: null, error: lastError }
}

const startReplacement = async () => {
  const attempts = 40
  const pauseMs = 500
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const opened = openHostLog()
    if (opened.stream === null) {
      lastError = opened.error
      if (attempt === 1 || attempt % 5 === 0) {
        log('no host log is openable (' + String(lastError?.code ?? 'unknown') + '); retry ' + attempt + '/' + attempts)
      }
      await sleep(pauseMs)
      continue
    }
    try {
      const child = spawn(boot.execPath, boot.args, {
        // The recorded working directory, so a relative path in the original
        // command line resolves exactly where it did the first time.
        cwd: boot.cwd,
        detached: true,
        stdio: ['ignore', opened.stream, opened.stream],
        windowsHide: true,
        // This supervisor opens the window below, so the plugin must not open a
        // second one. The marker is how the host half knows the job is taken.
        env: { ...process.env, DSH_POWER_SWITCH_WINDOW_HANDLED: '1' },
      })
      child.on('error', (error) => log('could not start the replacement: ' + error.message))
      child.unref()
      try { closeSync(opened.stream) } catch {}
      hostLog = opened.path
      log('spawned pid ' + child.pid + ' (spawn is not success; waiting for it to serve)')
      log('the replacement writes its output to ' + hostLog)
      return true
    } catch (error) {
      lastError = error
      try { closeSync(opened.stream) } catch {}
      log('spawn failed: ' + error.message)
      await sleep(pauseMs)
    }
  }
  log('FAILED to start the replacement: ' + (lastError === null ? 'unknown' : lastError.message))
  return false
}

if (!(await startReplacement())) process.exit(1)

let url = null
const deadline = Date.now() + 120000
while (Date.now() < deadline && url === null) {
  await sleep(500)
  try {
    const text = readFileSync(hostLog, 'utf8')
    const found = [...text.matchAll(new RegExp('https?://127\\\\.0\\\\.0\\\\.1:' + port + '/\\\\?token=[A-Za-z0-9_-]+', 'g'))].pop()
    if (found !== undefined) url = found[0]
  } catch {}
}
if (url === null) {
  log('FAILED: no token URL within 120 s')
  try {
    // Redacted: the replacement host log holds this run's token URL, and this
    // tail is copied into the shared log a person may paste somewhere.
    for (const line of readFileSync(hostLog, 'utf8').split(/\\r?\\n/).slice(-20)) log('  ' + redactToken(line))
  } catch {}
  process.exit(1)
}
log('dsh web: ' + redactToken(url))

let cookie = ''
let verified = false
for (let attempt = 1; attempt <= 20 && !verified; attempt += 1) {
  try {
    let response = await fetch(url, { redirect: 'manual' })
    if (response.status === 303) {
      cookie = (response.headers.get('set-cookie') || '').split(';')[0]
      response = await fetch(url.replace(/\\?token=.*$/, ''), cookie === '' ? {} : { headers: { cookie } })
    }
    verified = (await response.text()).includes(bundleId + '/client.js')
  } catch (error) {
    log('boot read attempt ' + attempt + ' failed: ' + error.message)
  }
  if (!verified) await sleep(750)
}
log(verified ? 'VERIFIED: ' + bundleId + '/client.js is in the boot payload' : 'WARNING: ' + bundleId + ' is not in the boot payload')

// The replacement is served; open it the way the launch mode asks. The
// environment carries the mode the card just chose, so it wins; the stored
// setting is the fallback for a hand-run helper.
//
// The window itself is opened by the shared module, NOT here: the desktop
// launcher makes the same choice, and two copies of "what does app mode mean" is
// how a mode works on one path and silently not on another.
const modeFromEnv = process.env.DSH_POWER_SWITCH_LAUNCH_MODE
// Document first, then the plugin's own record: DSH 0.1.7 retired the settings
// document, and a supervisor that read only that file opened a tab for a stored
// "app" -- the same silent downgrade the desktop launcher had.
const modeFromStore = resolveLaunchMode(settingsFile)
const mode = modeFromEnv === 'app' || modeFromEnv === 'tab' ? modeFromEnv : (modeFromStore ?? 'tab')
// Logged unconditionally: the whole decision is three inputs wide, and when it
// goes wrong the question is always "which one won".
log('launch mode: environment=' + String(modeFromEnv) + ' stored=' + String(modeFromStore) + ' using=' + mode)
openWindow(url, mode, log)
log('restart complete')
process.exit(0)
`
}

// Find the host that is running RIGHT NOW, not merely one that once ran. After a
// restart the newest log is a per-run one, so this must not read a fixed name.
const logs = currentHostLogs()
log(`helper started; candidate host logs: ${logs.join(' | ')}`)
const candidates = tokenUrls()
if (candidates.length === 0) {
  log(`FAILED: no host token URL in any log, so there is no host to restart (looked at ${String(logs.length)} log(s))`)
  console.error('could not find a running host token URL; nothing to restart')
  process.exit(1)
}
let url = null
let host = null
for (const candidate of candidates) {
  host = await liveHost(candidate)
  if (host !== null) {
    url = candidate
    break
  }
  log('a token from an earlier run did not answer; trying the next one')
}
if (host === null || url === null) {
  log(`FAILED: none of the ${String(candidates.length)} token URL(s) answered, so no host is serving on port ${String(port)}`)
  console.error('no running DSH host answered; nothing to restart')
  process.exit(1)
}
log(`will restart the host on ${host.page.origin}`)

// A host that recorded no restart command cannot be replaced, and asking it to
// shut down would take the service away with nothing to bring it back. Refuse
// here, before the shutdown request, so the host keeps serving.
if (boot === null) {
  log('FAILED: this host recorded no restart command, so it cannot be replaced')
  console.error('this host did not record how it was started; there is nothing to restart it with')
  process.exit(1)
}

const supervisor = spawn(process.execPath, ['--input-type=module', '-e', supervisorSource()], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  cwd: boot.cwd ?? ROOT,
})
supervisor.unref()
if (supervisor.pid === undefined) {
  log('FAILED: the supervisor process could not be started')
  console.error('could not start the restart supervisor')
  process.exit(1)
}
log(`supervisor started detached (pid ${String(supervisor.pid)})`)

// Ask our own plugin for a graceful exit. The response arrives BEFORE disposal
// starts, which is exactly why the route waits before leaving. The cookie was
// already exchanged by `liveHost`, so this only makes the request.
const endpoint = new URL(host.page.origin)
endpoint.pathname = '/api/dsh-power-switch/shutdown'
try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: host.page.origin,
      ...(host.cookie === '' ? {} : { cookie: host.cookie }),
    },
    body: JSON.stringify({ delayMs: delaySeconds * 1000 }),
  })
  const text = (await response.text()).trim()
  log(`shutdown request: HTTP ${String(response.status)} ${text}`)
  if (response.status !== 200) {
    // The host refusing is a GOOD outcome when it says so: it means the service
    // is still up, which is strictly better than exiting with nobody to bring
    // it back. It is still a failed switch, so it is recorded as one -- and a
    // manual run of this script should exit non-zero to say so.
    process.exitCode = 1
    log('FAILED: the host refused to shut down, so it is still running and the supervisor will find the port held')
    console.error(`the host refused the shutdown request: HTTP ${String(response.status)} ${text}`)
  }
} catch (error) {
  process.exitCode = 1
  log(`FAILED: the shutdown request did not complete: ${error.message}`)
  console.error(`the shutdown request did not complete: ${error.message}`)
}
console.log('the host will dispose and the supervisor will bring it back; watch the log')
