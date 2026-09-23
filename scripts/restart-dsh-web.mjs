/**
 * Restart the DSH web host, and prove the plugin came up.
 *
 * This runs as a DETACHED process launched by `scripts/restart-dsh-web.vbs`
 * (wscript owns it, so it survives the host it is restarting) and does the
 * whole job with Node alone -- PowerShell child processes were observed being
 * reaped under this environment's sandbox, which left the host stopped with no
 * replacement:
 *
 *   1. wait, so an in-flight answer can be written;
 *   2. stop the node process that LISTENS on the port;
 *   3. wait for the socket to be released;
 *   4. start the same command line again, in the background;
 *   5. read the fresh token URL out of the host log;
 *   6. fetch the boot payload and report whether this plugin's browser half made
 *      it into the client graph.
 *
 * Usage: node scripts/restart-dsh-web.mjs [--delay-seconds N] [--open]
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureStateDir, logPath, openWindow, readBootRecord, readRecordedTokenUrl, resolveLaunchCommand, resolveProbePort, stateDir, tokenUrlPattern } from './restart-shared.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Where this script keeps its state and its log: the harness home, not the package. */
const STATE_DIR = (() => {
  try {
    return ensureStateDir()
  } catch {
    return stateDir()
  }
})()

/** Everything this script can be pointed at. */
const options = {
  /** An explicit `dsh` CLI entry, for a machine with no recorded command. */
  cli: process.env.DSH_POWER_SWITCH_CLI ?? '',
  /** `null` means "derive it": see `resolveProbePort` below. */
  port: null,
  delaySeconds: 3,
  bundleId: 'dsh-power-switch',
  // The same log the plugin's `note()` and the supervisor write, outside the package.
  logFile: logPath(),
  open: false,
  app: false,
  browser: '',
}

for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index]
  const value = process.argv[index + 1]
  if (flag === '--delay-seconds') { options.delaySeconds = Number(value); index += 1 }
  else if (flag === '--port') { options.port = Number(value); index += 1 }
  else if (flag === '--cli') { options.cli = value; index += 1 }
  else if (flag === '--bundle') { options.bundleId = value; index += 1 }
  else if (flag === '--log') { options.logFile = value; index += 1 }
  else if (flag === '--browser') { options.browser = value; index += 1 }
  else if (flag === '--app') { options.open = true; options.app = true }
  else if (flag === '--open') options.open = true
}

/**
 * The port to work on.
 *
 * DERIVED when nothing named one, and that is a fix rather than a nicety: this
 * script is started by a `.vbs` a person double-clicks, so no environment hands
 * it the port the host is serving on. With a hardcoded 3080 the running host was
 * never found on any other port -- the stop step reported "nothing is
 * listening", and the script then started a SECOND host that died on
 * EADDRINUSE. The host's own record answers this, exactly as it does for the
 * desktop launcher; `--port` still overrides everything.
 */
const probe = resolveProbePort({
  explicit: options.port,
  recordedUrl: readRecordedTokenUrl(),
  bootArgs: readBootRecord()?.args ?? [],
})
options.port = probe.port

/**
 * Append one line to the log the person will read afterwards.
 * @param message - the line, timestamped on write.
 */
function log(message) {
  const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false })
  const line = `[${stamp}] ${message}\n`
  process.stdout.write(line)
  try {
    writeFileSync(options.logFile, line, { flag: 'a' })
  } catch {
    // The log is a convenience; losing it must not abort a restart.
  }
}

/**
 * The PID listening on the port, or null.
 *
 * `netstat` is the Windows/POSIX-common surface here and reports the listener
 * rather than every connection, so a browser holding a socket cannot be
 * mistaken for the host.
 * @param port - the TCP port.
 * @returns the owning PID.
 */
function listenerPid(port) {
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!/LISTENING/iu.test(line)) continue
    const columns = line.trim().split(/\s+/u)
    const local = columns[1] ?? ''
    if (!local.endsWith(`:${String(port)}`)) continue
    const pid = Number(columns[columns.length - 1])
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return null
}

/**
 * Whether the port accepts a connection right now.
 * @param port - the TCP port.
 * @returns true when something is listening.
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
 * Stop one process, escalating only if the graceful signal is ignored.
 *
 * `taskkill /T` is used on Windows so the host's own children (sandbox tool
 * runners, terminal sessions) go with it instead of being orphaned.
 * @param pid - the process to stop.
 * @param port - the port it is holding, used to confirm the release.
 * @returns true when the port came free.
 */
async function stopHost(pid, port) {
  const signal = process.platform === 'win32'
    ? ['taskkill', ['/PID', String(pid), '/T']]
    : ['kill', ['-TERM', String(pid)]]
  log(`stopping pid ${String(pid)} (${signal[0]})`)
  spawnSync(signal[0], signal[1], { windowsHide: true, stdio: 'ignore' })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (!(await portAnswers(port))) return true
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }

  const force = process.platform === 'win32'
    ? ['taskkill', ['/PID', String(pid), '/T', '/F']]
    : ['kill', ['-KILL', String(pid)]]
  log(`port ${String(port)} still held after 30 s; forcing (${force[0]})`)
  spawnSync(force[0], force[1], { windowsHide: true, stdio: 'ignore' })
  const hardDeadline = Date.now() + 10_000
  while (Date.now() < hardDeadline) {
    if (!(await portAnswers(port))) return true
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
  return false
}

/** Read the newest token URL the host printed, or null. */
function tokenUrlFromLog() {
  // The host's own record first (see restart-shared.mjs), then the logs.
  const recorded = readRecordedTokenUrl()
  if (recorded !== null) return recorded
  const candidates = []
  const scan = (dir) => {
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('dsh-web') && entry.endsWith('.log')) candidates.push(join(dir, entry))
      }
    } catch {
      // An unreadable directory just leaves the other candidates.
    }
  }
  scan(STATE_DIR)
  // The host's own working directory, from its boot record.
  const boot = readBootRecord()
  if (boot !== null && boot.cwd !== undefined) scan(boot.cwd)
  candidates.push(join(STATE_DIR, 'dsh-web.log'), join(tmpdir(), 'dsh-web.log'))
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    let text
    try { text = readFileSync(candidate, 'utf8') } catch { continue }
    // Any loopback port, not the one this script guessed: the URL that comes back
    // is the host's own, and it is verified before it is used.
    const found = [...text.matchAll(tokenUrlPattern())].pop()
    if (found !== undefined) return found[0]
  }
  return null
}

const main = async () => {
  log('=== restart requested ===')
  log(`waiting ${String(options.delaySeconds)} s so an in-flight answer can be written`)
  await new Promise((resolve) => { setTimeout(resolve, options.delaySeconds * 1000) })

  const pid = listenerPid(options.port)
  if (pid === null) {
    log(`nothing is listening on ${String(options.port)}`)
  } else if (!(await stopHost(pid, options.port))) {
    log(`FAILED: port ${String(options.port)} is still held by pid ${String(pid)}`)
    process.exit(1)
  } else {
    log(`port ${String(options.port)} released`)
  }

  const command = resolveLaunchCommand({ cli: options.cli, defaultCwd: ROOT, log })
  if (command === null) {
    log('FAILED: there is nothing to start DSH with, and it is stopped now; see the lines above')
    process.exit(1)
  }
  // A per-run log under the harness home: the shared one may still be held by the
  // process just stopped, and the package directory may be read-only.
  const hostLog = join(STATE_DIR, `dsh-web.${new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)}.log`)

  log(`starting (${command.source}): ${command.execPath} ${command.args.join(' ')}`)
  const out = openSync(hostLog, 'a')
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
      // This script opens the window when asked to, so the plugin must not open a
      // second one: the marker is how the host half knows the job is taken.
      env: { ...process.env, DSH_POWER_SWITCH_WINDOW_HANDLED: '1' },
    },
  )
  child.unref()
  closeSync(out)
  log(`started pid ${String(child.pid)}`)

  let url = null
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && url === null) {
    await new Promise((resolve) => { setTimeout(resolve, 500) })
    url = tokenUrlFromLog()
  }
  if (url === null) {
    log('FAILED: no token URL within 120 s; host log tail:')
    try {
      const tail = readFileSync(hostLog, 'utf8').split(/\r?\n/u).slice(-25)
      for (const line of tail) if (line !== '') log(`  ${line}`)
    } catch { /* nothing to show */ }
    process.exit(1)
  }
  log(`dsh web: ${url}`)

  // Prove the plugin's browser half is in the boot graph the host now serves.
  const token = /token=([A-Za-z0-9_-]+)/u.exec(url)[1]
  let cookie = ''
  let verified = false
  for (let attempt = 1; attempt <= 20 && !verified; attempt += 1) {
    try {
      let response = await fetch(`${url}`, { redirect: 'manual' })
      if (response.status === 303) {
        cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
        response = await fetch(url.replace(/\?token=.*$/u, ''), cookie === '' ? {} : { headers: { cookie } })
      }
      const html = await response.text()
      verified = html.includes(`${options.bundleId}/client.js`)
    } catch (error) {
      log(`boot read attempt ${String(attempt)} failed: ${String(error?.message ?? error)}`)
    }
    if (!verified) await new Promise((resolve) => { setTimeout(resolve, 750) })
  }

  log(verified
    ? `VERIFIED: ${options.bundleId}/client.js is in the boot payload`
    : `WARNING: ${options.bundleId} is not in the boot payload; check dsh.profile.bundles`)

  // The window decision is the shared one, so this path cannot drift from the
  // card's switch and the desktop launcher. `--browser` still overrides the
  // executable it uses.
  if (options.open) {
    openWindow(url, options.app ? 'app' : 'tab', log, options.browser === '' ? undefined : options.browser)
  }
  void token
  log(verified ? 'restart complete' : 'restart finished with a warning')
  process.exit(0)
}

// A crash net, matching the siblings: this file alone used to have none, so a
// log or spawn failure escaped top-level await and died with no line anywhere --
// and this is the script a person runs by hand when the UI is already down.
try {
  await main()
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  log(`FAILED (uncaught): ${detail}`)
  process.exit(1)
}
