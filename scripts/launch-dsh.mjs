/**
 * Start DSH from the desktop in the window shape the card stored.
 *
 * WHY THIS EXISTS. The card's "next launch" setting could only ever be honoured
 * by something that opens the window after the host is up. A plain `dsh web`
 * cannot do it: its only browser options are `--no-open` and nothing else, and
 * the hand-off goes through a platform opener started with a SCRUBBED
 * environment, so it always lands in the default browser -- a tab. A plugin
 * cannot intercept that, and a tab can never close itself (measured: only a real
 * app window honours `window.close()`). So the shape has to be chosen by
 * whatever LAUNCHES dsh, which is what this script is for.
 *
 * Point a desktop shortcut at `launch-dsh.vbs` (no console window) or run:
 *
 *     node scripts/launch-dsh.mjs
 *
 * Behaviour:
 *   - a host is already serving       -> open the window only; never a second host
 *   - nothing is running              -> replay the command the last host recorded
 *                                        for itself, wait for the token URL, then
 *                                        open the stored shape
 *   - the port answers without a token -> refuse, and say so, rather than collide
 *
 * HOW DSH IS STARTED is never guessed. The plugin's host half writes down its own
 * invocation (`process.execPath` + argv + cwd) while it runs, and this launcher
 * replays it. The version before this rebuilt `<checkout>/apps/cli/lib/bin.js`,
 * a path that exists only in a DSH source checkout, so on any other machine the
 * shortcut could not start anything.
 *
 * `--app` / `--tab` force a shape for one run; `--port` retargets the probe;
 * `--cli <path-to-dsh-cli-entry>` overrides the recorded command.
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureStateDir,
  logPath,
  openWindow,
  readBootRecord,
  readRecordedTokenUrl,
  redactToken,
  resolveLaunchCommand,
  resolveProbePort,
  settingsPath,
  stateDir,
  storedLaunchMode,
  tokenUrlPattern,
} from './restart-shared.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * An explicit port from the environment, or `null` for "derive it".
 *
 * A port is NOT known here in the normal case, and pretending otherwise is what
 * broke the cold start on another machine: this process is started by Explorer
 * through a `.vbs`, so it inherits whatever the shortcut carries, and nothing
 * guarantees `DSH_POWER_SWITCH_PORT`. The restart helper is handed the port by
 * the live host; this launcher has to derive it (see `resolveProbePort`).
 */
const envPort = (() => {
  const value = Number(process.env.DSH_POWER_SWITCH_PORT)
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null
})()

const options = {
  /** An explicit `dsh` CLI entry point, for a machine with no recorded command. */
  cli: process.env.DSH_POWER_SWITCH_CLI ?? null,
  port: envPort,
  /** `null` means "whatever the card stored". */
  mode: null,
  help: false,
}

const argv = process.argv.slice(2)
for (let at = 0; at < argv.length; at += 1) {
  const flag = argv[at]
  if (flag === '--app') options.mode = 'app'
  else if (flag === '--tab') options.mode = 'tab'
  else if (flag === '--port') { options.port = Number(argv[at + 1]); at += 1 }
  else if (flag === '--cli') { options.cli = argv[at + 1]; at += 1 }
  else if (flag === '--help' || flag === '-h') options.help = true
}

/**
 * The state directory and the one log this feature writes.
 *
 * Under the harness home, not in the package: the log carries authenticated
 * `?token=…` URLs and this machine's paths, and an installed package may live
 * somewhere that cannot be written at all.
 *
 * Parsed AFTER the command line, because the wrapper that a desktop shortcut
 * runs resolves the harness home first and hands it down as `DSH_HOME` -- a
 * machine that sets that variable only in a shell would otherwise leave this
 * launcher reading an empty state directory and refusing to start anything.
 */
const STATE_DIR = (() => {
  try {
    return ensureStateDir()
  } catch {
    return stateDir()
  }
})()
const logFile = logPath()

/** Say what is happening, to the console AND to the shared log. */
const log = (message) => {
  const line = `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] launcher: ${message}\n`
  process.stdout.write(line)
  try {
    appendFileSync(logFile, line)
  } catch {
    // Diagnostics must never be the reason a launch fails.
  }
}

/*
 * Nothing here may die silently. When this is started from a desktop shortcut
 * its console is invisible, so an uncaught error would look like "the shortcut
 * does nothing" -- the same blind spot that hid a supervisor crash for two
 * rounds. Every failure must leave a line in the shared log.
 */
const reportCrash = (label, error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  log(`FAILED (${label}): ${detail}`)
  process.exit(1)
}
process.on('uncaughtException', (error) => { reportCrash('uncaught exception', error) })
process.on('unhandledRejection', (error) => { reportCrash('unhandled rejection', error) })

if (options.help) {
  log('usage: node scripts/launch-dsh.mjs [--app|--tab] [--port N] [--cli PATH]')
  process.exit(0)
}

/**
 * The pattern the host prints once it is actually serving.
 *
 * Deliberately NOT scoped to a port this process had to guess: the host is
 * started from a recorded command line and may well serve on another port, and a
 * scoped pattern then waits 120 s for a line that will never appear -- a
 * shortcut that "does nothing" while the host is in fact running. Every
 * candidate is verified against the live server before a window is opened.
 */
const tokenPattern = tokenUrlPattern()

/**
 * Logs that could hold a RUNNING host's token, newest first.
 *
 * Ordered by modification time because the shape of a launch decides the file:
 * a plugin restart and this launcher both give the host a per-run name, so the
 * shared `dsh-web.log` is stale after the first of those.
 * @returns candidate log paths, most recently written first.
 */
function candidateLogs() {
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
  scan(STATE_DIR)
  // The host's own working directory, from its boot record: whatever started the
  // running host may have redirected its stdout to `<cwd>/dsh-web.log`.
  const boot = readBootRecord()
  if (boot !== null && boot.cwd !== undefined) scan(boot.cwd)
  found.sort((left, right) => right.at - left.at)
  const ordered = found.map((entry) => entry.path)
  const temp = join(tmpdir(), 'dsh-web.log')
  if (!ordered.includes(temp)) ordered.push(temp)
  return ordered
}

/**
 * Prove a token belongs to a host that is answering right now.
 *
 * The token is a per-run secret the LIVE host validates, so anything but a
 * 200/303 means that URL belongs to a run that is already gone. Without this the
 * launcher would happily open a window onto a dead token.
 * @param url - a candidate token URL.
 * @returns true when a live host answered.
 */
async function answersAsLiveHost(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 2000)
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal })
    return response.status === 200 || response.status === 303
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The running host's token URL, if there is one.
 * @returns the URL, or null when nothing live answered.
 */
async function liveTokenUrl() {
  // The host's OWN record first: it minted this URL for this run, so a machine
  // whose launcher writes the host log somewhere unusual still works. Verified
  // like every other candidate -- the file outlives the run that wrote it.
  const recorded = readRecordedTokenUrl()
  if (recorded !== null && await answersAsLiveHost(recorded)) return recorded
  for (const candidate of candidateLogs()) {
    let text = ''
    try {
      text = readFileSync(candidate, 'utf8')
    } catch {
      continue
    }
    // Newest last within a file, so walk backwards; a log accumulates a token
    // per run and only the freshest one can belong to a live host.
    for (const match of [...text.matchAll(tokenPattern)].reverse()) {
      if (await answersAsLiveHost(match[0])) return match[0]
    }
  }
  return null
}

/**
 * Whether something is listening on the port.
 *
 * Separate from the token lookup on purpose: a host whose stdout never went to a
 * file answers here but has no discoverable token, and starting a second host
 * onto it would only produce EADDRINUSE.
 * @param port - the port to probe, as `resolveProbePort` chose it.
 * @returns true when the port accepts a connection.
 */
function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (value) => { socket.destroy(); resolve(value) }
    socket.setTimeout(700)
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
    socket.once('timeout', () => { finish(false) })
  })
}

/**
 * Wait for the host to print its token URL.
 *
 * That line is the readiness signal: the bundle prints it only after the server
 * is serving, so the window can open the moment this returns -- no extra
 * verification pass is needed, and none is added, because it would only delay
 * the window the person is waiting for.
 * @param hostLog - the file the new host writes its stdout to.
 * @param timeoutMs - how long to wait.
 * @param from - byte offset to read from; everything before it belongs to an
 *   earlier run (the log is opened for APPEND, never truncated).
 * @returns the authenticated URL, or null on timeout.
 */
async function waitForToken(hostLog, timeoutMs, from = 0) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 400) })
    try {
      const text = readFileSync(hostLog).subarray(from).toString('utf8')
      const found = [...text.matchAll(tokenPattern)].pop()
      if (found !== undefined) return found[0]
    } catch {
      // The host has not written anything yet.
    }
  }
  return null
}

/**
 * Give a just-spawned detached opener a moment to report a failure.
 *
 * `process.exit()` immediately after a `spawn` would drop an asynchronous ENOENT
 * that the `error` handler exists to log -- and a launcher that fails silently is
 * precisely the failure mode this whole script is written to avoid.
 * @returns a promise that settles after the grace period.
 */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 400) })

log(`harness state: ${STATE_DIR}`)

const stored = storedLaunchMode(settingsPath())
const mode = options.mode ?? stored ?? 'tab'
log(`window mode: using "${mode}" (stored: ${String(stored)}, forced: ${String(options.mode)})`)

// A host already serving needs only a window. Starting a second one would fail
// on the port, and restarting is a different intent -- that is the card's switch.
const existing = await liveTokenUrl()
if (existing !== null) {
  log(`a host is already serving; opening the window only`)
  openWindow(existing, mode, log)
  await settle()
  process.exit(0)
}

// The port to probe is DERIVED, never assumed: a machine whose DSH serves on
// something other than the default used to be probed on the wrong port, so a
// running host could be missed and a second one started onto it.
const probe = resolveProbePort({
  explicit: options.port,
  recordedUrl: readRecordedTokenUrl(),
  bootArgs: readBootRecord()?.args ?? [],
})
log(`probing port ${String(probe.port)} (${probe.source})`)

if (await portAnswers(probe.port)) {
  log(`FAILED: port ${String(probe.port)} answers but no live token URL was found in any log,`)
  log('FAILED: so a host is running whose output is not a file. Not starting a second one.')
  process.exit(1)
}

const command = resolveLaunchCommand({ cli: options.cli, defaultCwd: ROOT, log })
if (command === null) process.exit(1)

// The host log lives in the state directory: it carries a token URL, and the
// package directory may be read-only — or, worse, a repository.
const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
const hostLog = join(STATE_DIR, `dsh-web.${stamp}.log`)
let out
try {
  out = openSync(hostLog, 'a')
} catch (error) {
  log(`FAILED: cannot open the host log ${hostLog}: ${error.message}`)
  process.exit(1)
}
// Everything already in the file belongs to an earlier run: the wait below must
// only ever see what THIS host appends.
let from = 0
try {
  from = statSync(hostLog).size
} catch { /* a fresh file has no size to read */ }
log(`starting (${command.source}): ${command.execPath} ${command.args.join(' ')}`)
// A shell shim needs a single quoted command line: `shell: true` alone joins the
// arguments with spaces and breaks on any path that contains one.
const child = spawn(
  command.shell
    ? `"${command.execPath}" ${command.args.map((value) => `"${value}"`).join(' ')}`
    : command.execPath,
  command.shell ? [] : command.args,
  {
    cwd: command.cwd,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    shell: command.shell,
    // THIS process opens the window, so the plugin must not open a second one.
    // The marker is how the host half knows somebody already took the job.
    env: { ...process.env, DSH_POWER_SWITCH_WINDOW_HANDLED: '1' },
  },
)
child.on('error', (error) => { log(`could not start the host: ${error.message}`) })
child.unref()
try { closeSync(out) } catch { /* the child owns the handle now */ }
log(`started pid ${String(child.pid)}; it writes its output to ${hostLog}`)

const url = await waitForToken(hostLog, 120_000, from)
if (url === null) {
  log('FAILED: no token URL within 120 s; the host never became ready. Its last lines:')
  try {
    // Redacted: this log is ALSO written to %TEMP% by the wrapper a shortcut
    // runs, and the host's last lines include its own token URL.
    for (const line of readFileSync(hostLog, 'utf8').split(/\r?\n/u).slice(-20)) {
      if (line !== '') log(`  ${redactToken(line)}`)
    }
  } catch { /* nothing to show */ }
  process.exit(1)
}
// Redacted for the same reason: the URL is a local access credential, and this
// line reaches %TEMP% through the wrapper's redirect.
log(`dsh web: ${redactToken(url)}`)

openWindow(url, mode, log)
log('launch complete')
await settle()
process.exit(0)
