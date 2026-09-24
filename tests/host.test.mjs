/**
 * Tests for the power-switch host half.
 *
 * The route is driven through in-memory request/response doubles rather than a
 * real socket, and the scheduler through injected exits — so no test opens a
 * port and no test asks the runner's own process to leave. Run with
 * `node tests/host.test.mjs`.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  DEFAULT_DELAY_MS,
  MAX_DELAY_MS,
  chooseShortcutAction,
  classifyShortcut,
  createConfigHandler,
  createExitPlan,
  createExitResponder,
  createPowerHandler,
  createRestartHandler,
  createShortcutHandler,
  isTrustedReadRequest,
  isTrustedRequest,
  normalizeLaunchMode,
  parseHelperUrl,
  parseShortcutResult,
  readJsonBody,
  readShutdownRequest,
  relaunchPlan,
  restartHelperEnv,
  schemasteryReferrers,
  shortcutVerdict,
  shouldOpenStartupWindow,
  resolveConfig,
  createSettingsHandler,
  parseSettingsPatch,
} from '../src/host.js'

/** A request double carrying exactly what the handler reads. */
function makeRequest({
  method = 'POST',
  url = '/api/dsh-power-switch/shutdown',
  remoteAddress = '127.0.0.1',
  headers = {},
  body = '',
} = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    socket: { remoteAddress },
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A response double recording what the handler wrote. */
function makeResponse() {
  const state = { status: 0, headers: undefined, body: '', ended: false }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
      return this
    },
    end(chunk) {
      if (chunk !== undefined) state.body += chunk.toString('utf8')
      state.ended = true
      return this
    },
    json() {
      return JSON.parse(state.body)
    },
  }
}

const TRUSTED = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }

/**
 * Drive the shutdown handler once over in-memory doubles.
 *
 * The exit responder is the real one, with its flush shortened, so the tests
 * exercise the SAME escalation the host uses: answer, try graceful, then force.
 * @param options - request shape and the plugin configuration in force.
 * @returns the response double, the recorded exits, the order log, and notes.
 */
async function drive({ config = {}, request = {}, wait = false } = {}) {
  const exits = []
  const order = []
  const notes = []
  let gracefulCalls = 0
  let done
  const settled = new Promise((resolve) => { done = resolve })
  const exitWith = createExitResponder({
    // Short but strictly ordered: flush, then the graceful request, then the
    // watchdog. The graceful route here deliberately NEVER settles, which is
    // what the real `ctx.appExit` looks like while disposal runs -- so the
    // watchdog is exercised rather than stood down.
    flushMs: 1,
    watchdogMs: 5,
    gracefulExit: () => { gracefulCalls += 1; order.push('graceful'); return new Promise(() => {}) },
    forceExit: (code) => { order.push('forced'); exits.push(code); done() },
    note: (message) => { notes.push(message) },
  })
  const handler = createPowerHandler({
    // A tiny hold by default: the ordering is what these tests are about, and
    // the configured hold is asserted from the response, not waited out.
    config: () => resolveConfig({ delayMs: 5, ...config }),
    exitWith,
  })
  const response = makeResponse()
  await handler(makeRequest({ headers: TRUSTED, ...request }), {
    ...response,
    end(chunk) {
      order.push('answered')
      return response.end(chunk)
    },
  })
  if (wait) {
    // Only the tests that assert on the completed escalation pay its cost.
    await Promise.race([settled, new Promise((resolve) => { setTimeout(resolve, 300) })])
  }
  return { response, exits, order, notes, gracefulCalls: () => gracefulCalls, settled }
}

describe('isTrustedRequest', () => {
  it('accepts a same-origin loopback POST', () => {
    assert.equal(isTrustedRequest(makeRequest({ headers: TRUSTED })), true)
  })

  it('accepts IPv6 loopback', () => {
    const headers = { host: '[::1]:3080', origin: 'http://[::1]:3080' }
    assert.equal(isTrustedRequest(makeRequest({ remoteAddress: '::1', headers })), true)
  })

  it('refuses a non-loopback peer', () => {
    assert.equal(isTrustedRequest(makeRequest({ remoteAddress: '192.168.1.20', headers: TRUSTED })), false)
  })

  it('refuses any forwarding trace, because the peer is then a proxy', () => {
    for (const name of ['forwarded', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host']) {
      const headers = { ...TRUSTED, [name]: '10.0.0.1' }
      assert.equal(isTrustedRequest(makeRequest({ headers })), false, name)
    }
  })

  it('refuses a missing Origin, because no browser gesture posts without one', () => {
    assert.equal(isTrustedRequest(makeRequest({ headers: { host: '127.0.0.1:3080' } })), false)
  })

  it('refuses a cross-origin page that can still reach loopback', () => {
    const headers = { host: '127.0.0.1:3080', origin: 'http://evil.example' }
    assert.equal(isTrustedRequest(makeRequest({ headers })), false)
  })

  it('refuses a non-HTTP origin scheme', () => {
    const headers = { host: '127.0.0.1:3080', origin: 'file://127.0.0.1:3080' }
    assert.equal(isTrustedRequest(makeRequest({ headers })), false)
  })
})

describe('isTrustedReadRequest', () => {
  it('accepts a same-origin GET, which carries NO Origin header', () => {
    // MEASURED in Edge: a same-origin POST sends Origin, a same-origin GET does
    // NOT. Requiring one on the read refused the card's own config request, so
    // the mode switch sat disabled forever with "unknown" for the stored mode.
    assert.equal(
      isTrustedReadRequest(makeRequest({ method: 'GET', headers: { host: '127.0.0.1:3080' } })),
      true,
    )
  })

  it('still accepts a GET that does carry a matching Origin', () => {
    assert.equal(isTrustedReadRequest(makeRequest({ method: 'GET', headers: TRUSTED })), true)
  })

  it('refuses a read from a non-loopback peer', () => {
    assert.equal(isTrustedReadRequest(makeRequest({ remoteAddress: '10.0.0.9', headers: {} })), false)
  })

  it('refuses a read with any forwarding trace', () => {
    for (const name of ['forwarded', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host']) {
      const headers = { host: '127.0.0.1:3080', [name]: '10.0.0.1' }
      assert.equal(isTrustedReadRequest(makeRequest({ headers })), false, name)
    }
  })

  it('refuses a read whose Origin is present but foreign', () => {
    const headers = { host: '127.0.0.1:3080', origin: 'http://evil.example' }
    assert.equal(isTrustedReadRequest(makeRequest({ headers })), false)
  })

  it('refuses a read whose Origin cannot be checked against a host', () => {
    assert.equal(isTrustedReadRequest(makeRequest({ headers: { origin: 'http://127.0.0.1:3080' } })), false)
  })

  it('refuses a read with no Host at all', () => {
    // "Cannot be checked" is not "ours": an absent Host leaves nothing to
    // compare an Origin against, so the read is refused.
    assert.equal(isTrustedReadRequest(makeRequest({ headers: {} })), false)
  })
})

describe('readJsonBody', () => {
  it('parses a JSON body', async () => {
    assert.deepEqual(await readJsonBody(makeRequest({ body: '{"delayMs":250}' })), { delayMs: 250 })
  })

  it('returns null for an empty body', async () => {
    assert.equal(await readJsonBody(makeRequest({ body: '' })), null)
  })

  it('returns null for malformed JSON', async () => {
    assert.equal(await readJsonBody(makeRequest({ body: 'not json' })), null)
  })

  it('refuses an oversized body', async () => {
    await assert.rejects(() => readJsonBody(makeRequest({ body: 'x'.repeat(64) }), 16))
  })
})

describe('readShutdownRequest', () => {
  const config = { delayMs: 1000, exitCode: 0, hard: false }

  it('falls back to the configuration for an absent body', () => {
    assert.deepEqual(readShutdownRequest(null, config), { code: 0, delayMs: 1000, hard: false })
  })

  it('falls back for a non-object body', () => {
    assert.deepEqual(readShutdownRequest('nonsense', config), { code: 0, delayMs: 1000, hard: false })
    assert.deepEqual(readShutdownRequest([1, 2], config), { code: 0, delayMs: 1000, hard: false })
  })

  it('honours explicit fields', () => {
    assert.deepEqual(
      readShutdownRequest({ delayMs: 250, code: 7, hard: true }, config),
      { code: 7, delayMs: 250, hard: true },
    )
  })

  it('clamps rather than refusing a nonsensical number', () => {
    assert.equal(readShutdownRequest({ delayMs: -5 }, config).delayMs, 0)
    assert.equal(readShutdownRequest({ delayMs: 10 ** 9 }, config).delayMs, MAX_DELAY_MS)
    assert.equal(readShutdownRequest({ code: 999 }, config).code, 255)
    assert.equal(readShutdownRequest({ delayMs: 'soon' }, config).delayMs, DEFAULT_DELAY_MS)
    assert.equal(readShutdownRequest({ delayMs: Number.NaN }, config).delayMs, DEFAULT_DELAY_MS)
  })

  it('ignores a non-boolean hard flag', () => {
    assert.equal(readShutdownRequest({ hard: 'yes' }, config).hard, false)
  })
})

describe('resolveConfig', () => {
  it('defaults an empty entry', () => {
    assert.deepEqual(
      resolveConfig(undefined, undefined),
      { delayMs: 1000, exitCode: 0, hard: false, launchMode: 'tab' },
    )
  })

  it('prefers the settings section over the loader row', () => {
    assert.deepEqual(
      resolveConfig({ delayMs: 500, exitCode: 3 }, { delayMs: 250 }),
      { delayMs: 250, exitCode: 0, hard: false, launchMode: 'tab' },
    )
  })

  it('reads a stored launch mode, and refuses an unknown one', () => {
    assert.equal(resolveConfig({ launchMode: 'app' }).launchMode, 'app')
    assert.equal(resolveConfig({ launchMode: 'tab' }).launchMode, 'tab')
    // An unconfigured `dsh web` opens a tab, so anything else resolves there.
    assert.equal(resolveConfig({ launchMode: 'kiosk' }).launchMode, 'tab')
    assert.equal(resolveConfig({ launchMode: 7 }).launchMode, 'tab')
  })

  it('clamps an out-of-range stored value', () => {
    assert.equal(resolveConfig({ delayMs: -1 }).delayMs, 0)
    assert.equal(resolveConfig({ exitCode: 1000 }).exitCode, 255)
  })
})

describe('createExitPlan', () => {
  it('puts the force step after the graceful request, not on top of it', () => {
    const plan = createExitPlan({ code: 0, hard: false }, 100, 500)
    assert.equal(plan.hard, false)
    assert.equal(plan.gracefulAtMs, 100)
    assert.equal(plan.forceAtMs, 600)
  })

  it('skips the graceful request for a hard stop but still forces', () => {
    const plan = createExitPlan({ code: 3, hard: true }, 100, 500)
    assert.equal(plan.hard, true)
    assert.equal(plan.gracefulAtMs, null)
    assert.equal(plan.forceAtMs, 100, 'a hard stop leaves only the response flush')
  })

  it('always produces a force moment, which is what makes the exit guaranteed', () => {
    for (const hard of [true, false]) {
      const plan = createExitPlan({ code: 0, hard }, 10, 20)
      assert.equal(typeof plan.forceAtMs, 'number')
      assert.ok(plan.forceAtMs > 0)
    }
  })
})

describe('createExitResponder', () => {
  /** A responder whose timing is short enough to assert on directly. */
  const makeResponder = (overrides = {}) => {
    const reached = []
    const notes = []
    return {
      reached,
      notes,
      run: createExitResponder({
        flushMs: 1,
        watchdogMs: 5,
        gracefulExit: () => { reached.push('graceful') },
        forceExit: (code) => { reached.push(`force:${String(code)}`) },
        note: (message) => { notes.push(message) },
        ...overrides,
      }),
    }
  }

  it('answers first, requests graceful, and does NOT force once it settles', async () => {
    const harness = makeResponder()
    const response = makeResponse()
    // The responder's promise settles when the exit has been handed over, so
    // this test waits on the OUTCOME instead of guessing at a delay.
    const done = harness.run(response, 200, { ok: true }, { code: 0, hard: false })
    // The answer is synchronous: the card always learns before anything dies.
    assert.equal(response.state.status, 200)
    assert.equal(response.json().ok, true)
    assert.deepEqual(harness.reached, [], 'nothing exits in the same tick as the answer')
    const outcome = await done
    assert.equal(outcome, 'stood-down')
    // A graceful request that COMPLETED must not be followed by a forced exit:
    // that is not a rescue, it pre-empts whatever disposal is still running, and
    // in a host whose appExit settles synchronously it kills the caller outright.
    assert.deepEqual(harness.reached, ['graceful'])
    assert.match(harness.notes.join('\n'), /watchdog stands down/u)
  })

  it('still forces when the graceful route throws', async () => {
    // The failure that used to leave the process alive with the page waiting:
    // the watchdog must not depend on the graceful step succeeding. A throw is
    // forced AT ONCE: waiting out a window the graceful route can no longer use
    // would only delay the exit.
    const harness = makeResponder({
      gracefulExit: () => { throw new Error('shutdown controller refused') },
    })
    const outcome = await harness.run(makeResponse(), 200, { ok: true }, { code: 0, hard: false })
    assert.equal(outcome, 'failed')
    assert.deepEqual(harness.reached, ['force:0'])
    assert.match(harness.notes.join('\n'), /graceful exit failed outright/u)
  })

  it('still forces when the graceful route never settles', async () => {
    // The watchdog must fail OPEN: a graceful route that stays pending forever
    // cannot be waited out. The ORDER of the graceful call is asserted by the
    // first test in this group, which is not racing a near-identical window.
    const harness = makeResponder({
      flushMs: 5,
      watchdogMs: 200,
      gracefulExit: () => { return new Promise(() => {}) },
    })
    const outcome = await harness.run(makeResponse(), 200, { ok: true }, { code: 0, hard: false })
    assert.equal(outcome, 'fired')
    assert.ok(harness.reached.includes('force:0'), 'the process was ended anyway')
    assert.match(harness.notes.join('\n'), /watchdog: the graceful request has not settled/u)
  })

  it('ends the process at once when there is no graceful route at all', async () => {
    // "No graceful route" is not "graceful settled": there is nothing to hand
    // over to, so a grace window would be spent waiting for a call that is never
    // made.
    const harness = makeResponder({ gracefulExit: undefined })
    const outcome = await harness.run(makeResponse(), 200, { ok: true }, { code: 7, hard: false })
    assert.equal(outcome, 'hard')
    assert.deepEqual(harness.reached, ['force:7'])
    assert.match(harness.notes.join('\n'), /no graceful exit available/u)
  })

  it('ends the process at once on a hard stop', async () => {
    const harness = makeResponder()
    const outcome = await harness.run(makeResponse(), 200, { ok: true }, { code: 0, hard: true })
    assert.equal(outcome, 'hard')
    assert.deepEqual(harness.reached, ['force:0'])
  })

  it('records the plan before anything irreversible happens', () => {
    const harness = makeResponder()
    void harness.run(makeResponse(), 200, { ok: true }, { code: 0, hard: false })
    assert.match(harness.notes.join('\n'), /exit requested: code=0 hard=false/u)
  })

  it('refuses to arm a second exit for a repeated request', async () => {
    const harness = makeResponder()
    const first = harness.run(makeResponse(), 200, { ok: true }, { code: 0, hard: false })
    const second = harness.run(makeResponse(), 200, { ok: true }, { code: 0, hard: false })
    // The second call answers but never arms anything of its own.
    assert.equal(await second, 'already-scheduled')
    assert.equal(await first, 'stood-down')
    assert.deepEqual(harness.reached, ['graceful'])
  })
})

describe('createPowerHandler', () => {
  it('answers the card before it leaves, and leaves for real', async () => {
    const driven = await drive({ wait: true })
    const { response, order } = driven
    assert.equal(response.state.status, 200)
    const payload = response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.shuttingDown, true)
    // The answer echoes the configured hold, which the card's request may have
    // overridden; this suite configures a tiny one so it does not wait it out.
    assert.equal(payload.delayMs, 5)
    assert.equal(payload.pid, process.pid)
    // And the exit happened even though the graceful route does nothing here:
    // that escalation is what stops a stalled disposal from leaving the page
    // waiting forever. The answer is first, so the card always learns.
    assert.deepEqual(order, ['answered', 'graceful', 'forced'])
    assert.deepEqual(driven.exits, [0])
  })

  it('lets the card ask for a shorter hold and a hard stop', async () => {
    const driven = await drive({ request: { body: '{"delayMs":120,"hard":true}' }, wait: true })
    assert.equal(driven.response.state.status, 200)
    // A hard stop skips the graceful route entirely.
    assert.deepEqual(driven.order, ['answered', 'forced'])
    assert.equal(driven.gracefulCalls(), 0)
  })

  it('routes the loader-row configuration into the answer', async () => {
    const driven = await drive({ config: { delayMs: 250, exitCode: 3 }, wait: true })
    const payload = driven.response.json()
    assert.equal(payload.delayMs, 250)
    assert.equal(payload.code, 3)
    assert.deepEqual(driven.exits, [3])
  })

  it('records the exit decision and the watchdog, for the operator reading the log', async () => {
    const driven = await drive({ wait: true })
    const notes = driven.notes.join('\n')
    // The plan is the diagnosis: it names both moments, so a log that stops
    // after this line means the process was killed rather than exiting.
    assert.match(notes, /exit requested: code=0 hard=false gracefulAt=1ms forceAt=6ms graceful=yes/u)
    assert.match(notes, /watchdog: the graceful request has not settled/u)
  })

  it('refuses a cross-origin caller without exiting', async () => {
    const { response, exits } = await drive({ request: { headers: { ...TRUSTED, origin: 'http://evil.example' } } })
    assert.equal(response.state.status, 403)
    assert.deepEqual(exits, [])
  })

  it('refuses a GET without exiting', async () => {
    const { response, exits } = await drive({ request: { method: 'GET' } })
    assert.equal(response.state.status, 405)
    assert.equal(response.state.headers.allow, 'POST')
    assert.deepEqual(exits, [])
  })

  it('treats an unparseable body as no body', async () => {
    const driven = await drive({ request: { body: 'not json at all' }, wait: true })
    assert.equal(driven.response.state.status, 200)
    assert.deepEqual(driven.exits, [0])
  })

  it('never exits for a refused request', async () => {
    for (const request of [
      { method: 'GET' },
      { headers: { host: '127.0.0.1:3080' } },
      { remoteAddress: '10.1.2.3' },
      { headers: { ...TRUSTED, 'x-forwarded-for': '10.1.2.3' } },
    ]) {
      const { exits } = await drive({ request })
      // Give any wrongly-armed escalation a chance to fire before asserting.
      await new Promise((resolve) => { setTimeout(resolve, 30) })
      assert.deepEqual(exits, [], JSON.stringify(request))
    }
  })
})

describe('createConfigHandler', () => {
  /** Drive the config route once. */
  async function read({ config = {}, request = {} } = {}) {
    const handler = createConfigHandler({ config: () => resolveConfig(config) })
    const response = makeResponse()
    await handler(makeRequest({ method: 'GET', headers: TRUSTED, ...request }), response)
    return response
  }

  it('answers the card own GET, which has no Origin header', async () => {
    // This is the exact shape the browser sends for the card's read, and the
    // one that used to be refused.
    const response = await read({ request: { headers: { host: '127.0.0.1:3080' } } })
    assert.equal(response.state.status, 200)
    assert.equal(response.json().ok, true)
  })

  it('reports the effective configuration to a trusted caller', async () => {
    const response = await read({ config: { launchMode: 'app', delayMs: 250, exitCode: 3, hard: true } })
    assert.equal(response.state.status, 200)
    assert.deepEqual(response.json(), {
      ok: true,
      launchMode: 'app',
      delayMs: 250,
      exitCode: 3,
      hard: true,
    })
  })

  it('defaults to the tab mode a plain launch uses', async () => {
    assert.equal((await read()).json().launchMode, 'tab')
  })

  it('refuses a foreign Origin and a non-GET', async () => {
    assert.equal((await read({ request: { headers: { ...TRUSTED, origin: 'http://evil.example' } } })).state.status, 403)
    assert.equal((await read({ request: { method: 'POST' } })).state.status, 405)
  })
})

describe('createShortcutHandler', () => {
  /** Drive the shortcut route once. */
  async function drive(runner, { body = '{"action":"install"}', request = {} } = {}) {
    const handler = createShortcutHandler({ run: runner })
    const response = makeResponse()
    await handler(makeRequest({ headers: TRUSTED, body, ...request }), response)
    return response
  }

  it('passes the requested action through and reports what happened', async () => {
    const seen = []
    const response = await drive((action) => {
      seen.push(action)
      return { ok: true, action, path: 'C:\\Desktop\\DSH.lnk' }
    }, { body: '{"action":"scan"}' })
    assert.equal(response.state.status, 200)
    assert.deepEqual(seen, ['scan'])
    assert.equal(response.json().action, 'scan')
  })

  it('defaults to install, which is what a bare POST means', async () => {
    const response = await drive(() => ({ ok: true, action: 'created', path: 'C:\\Desktop\\DSH 启动器.lnk' }), { body: '' })
    assert.equal(response.state.status, 200)
    assert.equal(response.json().action, 'created')
  })

  it('refuses an action that is not one of the three', async () => {
    for (const action of ['delete', 'install ', '../scan', '']) {
      const response = await drive(() => ({ ok: true }), { body: JSON.stringify({ action }) })
      // An empty string is a value, not an absence, so it is refused too.
      assert.equal(response.state.status, 400, `${action} must be refused`)
    }
  })

  it('answers a failed operation with the reason, not with a 200', async () => {
    const response = await drive(() => ({ ok: false, error: 'several desktop shortcuts look like DSH', candidates: ['a', 'b'] }))
    assert.equal(response.state.status, 500)
    assert.match(response.json().error, /several/)
    assert.deepEqual(response.json().candidates, ['a', 'b'])
  })

  it('turns a thrown runner into an error answer rather than a dead request', async () => {
    const response = await drive(() => { throw new Error('cscript is missing') })
    assert.equal(response.state.status, 500)
    assert.match(response.json().error, /cscript is missing/)
  })

  it('refuses anything but a trusted POST, because it writes outside the package', async () => {
    assert.equal((await drive(() => ({ ok: true }), { request: { headers: { ...TRUSTED, origin: 'http://evil.example' } } })).state.status, 403)
    assert.equal((await drive(() => ({ ok: true }), { request: { method: 'GET' } })).state.status, 405)
    assert.equal((await drive(() => ({ ok: true }), { request: { remoteAddress: '10.0.0.5' } })).state.status, 403)
  })
})

describe('parseShortcutResult', () => {
  /**
   * One scan row per shortcut, exactly as the helper writes it.
   *
   * There is deliberately no `kind` field here: the `.vbs` helper is mechanical
   * and never decides which icon is the DSH one. That decision lives in
   * `classifyShortcut` / `chooseShortcutAction`, where it can be unit-tested —
   * and a classifier that could not be tested is exactly how a real desktop
   * shortcut got missed.
   */
  const scanOf = (count) => {
    const lines = ['action=scan', `count=${String(count)}`]
    for (let index = 0; index < count; index += 1) {
      lines.push(`lnk${String(index)}=C:\\Users\\a\\Desktop\\icon${String(index)}.lnk`)
      lines.push(`name${String(index)}=icon${String(index)}.lnk`)
      lines.push(`target${String(index)}=C:\\Program Files\\nodejs\\node.exe`)
      lines.push(`args${String(index)}="C:\\x\\start-dsh-web.vbs"`)
    }
    return lines.join('\r\n')
  }

  it('reads every scanned row and leaves the classification to the caller', () => {
    const parsed = parseShortcutResult(scanOf(4))
    assert.equal(parsed.action, 'scan')
    assert.equal(parsed.count, '4')
    assert.equal(parsed.entries.length, 4)
    // No row carries a verdict: filtering is `chooseShortcutAction`'s job.
    assert.equal(parsed.entries.every((entry) => entry.kind === undefined), true)
    assert.match(parsed.entries[1].path, /icon1\.lnk$/)
    assert.equal(parsed.entries[1].name, 'icon1.lnk')
  })

  it('tolerates a BOM, a row with no extras, and an empty result', () => {
    const parsed = parseShortcutResult('\uFEFFaction=scan\r\nlnk0=C:\\a.lnk\r\n')
    assert.equal(parsed.entries.length, 1)
    assert.equal(parsed.entries[0].path, 'C:\\a.lnk')
    assert.equal(parsed.entries[0].name, '')
    assert.deepEqual(parseShortcutResult('').entries, [])
  })

  it('splits on the FIRST equals, so a path containing one survives', () => {
    const parsed = parseShortcutResult('lnk0=C:\\a=b\\x.lnk\r\n')
    assert.equal(parsed.entries[0].path, 'C:\\a=b\\x.lnk')
  })

  it('keeps the candidate list from an ambiguous install', () => {
    const parsed = parseShortcutResult('action=failed\r\ncandidate0=C:\\a.lnk\r\ncandidate1=C:\\b.lnk\r\n')
    assert.deepEqual(parsed.candidates, ['C:\\a.lnk', 'C:\\b.lnk'])
  })
})

describe('classifyShortcut', () => {
  const LAUNCHER = 'G:\\test\\c\\dsh-power-switch\\scripts\\launch-dsh.vbs'
  const entry = (over = {}) => ({
    path: 'C:\\Users\\a\\Desktop\\x.lnk', name: 'x.lnk', target: '', args: '', workdir: '', description: '', ...over,
  })

  it('recognises the real shortcut that the first classifier MISSED', () => {
    // Measured on this machine: DSH's own desktop icon is a .vbs wrapper, so its
    // target is wscript.exe and its arguments say `dsh-web`, not `dsh web`. The old
    // rule wanted the literal text " web", called it "other", and the card then
    // reported that it could not find the shortcut at all. The paths are
    // anonymised; the SHAPE is the measurement that matters.
    const real = entry({
      path: 'C:\\Users\\alice\\Desktop\\DeepSeek Harness.lnk',
      name: 'DeepSeek Harness.lnk',
      target: 'C:\\Windows\\System32\\wscript.exe',
      args: '"D:\\somewhere\\dsh\\start-dsh-web.vbs"',
      workdir: 'D:\\somewhere\\dsh',
      description: '直接打开 DeepSeek Harness Web UI（自动静默启动服务器）',
    })
    assert.equal(classifyShortcut(real, LAUNCHER), 'dsh')
  })

  it('recognises a shortcut that already points at our launcher', () => {
    const ours = entry({ target: 'C:\\Windows\\System32\\wscript.exe', args: `"${LAUNCHER}"` })
    assert.equal(classifyShortcut(ours, LAUNCHER), 'ours')
    // The installed form carries the harness home as a second argument; it is
    // still ours, and it must be recognised as ours or the card would offer to
    // adopt an icon this plugin already wrote.
    const withHome = entry({ target: 'C:\\Windows\\System32\\wscript.exe', args: `"${LAUNCHER}" --home "C:\\Users\\a\\.dsh"` })
    assert.equal(classifyShortcut(withHome, LAUNCHER), 'ours')
  })

  it('recognises the CLI itself and node wrappers', () => {
    assert.equal(classifyShortcut(entry({ target: 'C:\\tools\\dsh.cmd', args: 'web' }), LAUNCHER), 'dsh')
    assert.equal(classifyShortcut(entry({ target: 'C:\\Program Files\\nodejs\\node.exe', args: 'apps/cli/lib/bin.js web' }), LAUNCHER), 'dsh')
  })

  it('leaves unrelated icons alone', () => {
    // The target decides. A browser is not an interpreter, so not even a DeepSeek
    // page is adopted -- only something that can start the CLI is.
    assert.equal(classifyShortcut(entry({ target: 'H:\\miHoYo Launcher\\launcher.exe' }), LAUNCHER), 'other')
    assert.equal(classifyShortcut(entry({ target: 'E:\\VS\\vs\\Common7\\IDE\\devenv.exe' }), LAUNCHER), 'other')
    assert.equal(classifyShortcut(entry({ name: 'DeepSeek 网页.lnk', target: 'C:\\msedge.exe', args: 'https://chat.deepseek.com' }), LAUNCHER), 'other')
    assert.equal(classifyShortcut(entry({ target: '' }), LAUNCHER), 'other')
  })

  it('never claims the Electron desktop app, which is a different product', () => {
    const app = entry({ target: 'C:\\app\\DSH Desktop.exe', args: '--no-open dsh', description: 'DeepSeek Harness desktop-host' })
    assert.equal(classifyShortcut(app, LAUNCHER), 'other')
  })
})

describe('chooseShortcutAction', () => {
  const LAUNCHER = 'G:\\test\\c\\dsh-power-switch\\scripts\\launch-dsh.vbs'
  const scan = (targets) => targets.map((target, index) => ({
    path: `C:\\Users\\a\\Desktop\\i${String(index)}.lnk`,
    name: `i${String(index)}.lnk`,
    target,
    args: '',
    workdir: '',
    description: '',
  }))

  it('adopts the single DSH-looking icon', () => {
    const chosen = chooseShortcutAction(scan(['C:\\msedge.exe', 'C:\\tools\\dsh.cmd', 'E:\\Steam.exe']), LAUNCHER)
    assert.equal(chosen.action, 'adopt')
    assert.match(chosen.path, /i1\.lnk$/)
    // The card is told about that one only.
    assert.deepEqual(chosen.entries.map((e) => e.kind), ['dsh'])
    assert.equal(chosen.others, 2)
  })

  it('creates when nothing looks like DSH', () => {
    const chosen = chooseShortcutAction(scan(['C:\\msedge.exe', 'E:\\Steam.exe']), LAUNCHER)
    assert.equal(chosen.action, 'create')
    assert.deepEqual(chosen.entries, [])
    assert.equal(chosen.others, 2)
  })

  it('refuses to guess between several candidates, and names them', () => {
    const chosen = chooseShortcutAction(scan(['C:\\tools\\dsh.cmd', 'C:\\other\\dsh.exe']), LAUNCHER)
    assert.equal(chosen.action, 'ambiguous')
    assert.equal(chosen.candidates.length, 2)
  })

  it('shows an existing launcher of ours alongside the candidate', () => {
    const entries = scan(['C:\\tools\\dsh.cmd'])
    entries.push({
      path: 'C:\\Users\\a\\Desktop\\DSH 启动器.lnk', name: 'DSH 启动器.lnk', target: 'C:\\wscript.exe',
      args: `"${LAUNCHER}"`, workdir: '', description: '',
    })
    const chosen = chooseShortcutAction(entries, LAUNCHER)
    assert.deepEqual(chosen.entries.map((e) => e.kind).sort(), ['dsh', 'ours'])
    assert.equal(chosen.others, 0)
  })

  it('survives an empty or malformed scan', () => {
    assert.equal(chooseShortcutAction([], LAUNCHER).action, 'create')
    assert.equal(chooseShortcutAction(undefined, LAUNCHER).action, 'create')
  })
})

/**
 * The mapping from a helper run to what the card is told.
 *
 * Windows Script Host can be ABSENT (nothing to fix on this machine) or BLOCKED
 * (a policy the person or their administrator can allow) -- an Attack Surface
 * Reduction rule or a script-host lockdown hits the second. Both used to arrive as
 * `cscript could not be run: <raw node error>`, which names neither.
 */
describe('shortcutVerdict', () => {
  const quiet = () => {}
  const ran = (over = {}) => ({ entries: [], candidates: [], others: 0, ran: true, ...over })
  const failed = (code) => Object.assign(new Error(`spawn cscript.exe ${code}`), { code })

  it('passes a clean run', () => {
    assert.equal(shortcutVerdict('install', { status: 0 }, ran(), quiet), null)
  })

  it('names a script host that is missing', () => {
    const verdict = shortcutVerdict('install', { error: failed('ENOENT') }, ran({ ran: false }), quiet)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.reason, 'wsh-missing')
    assert.match(verdict.error, /cscript could not be run/)
  })

  it('names a script host that policy refuses to start', () => {
    assert.equal(shortcutVerdict('install', { error: failed('EPERM') }, ran({ ran: false }), quiet).reason, 'wsh-blocked')
    assert.equal(shortcutVerdict('install', { error: failed('EACCES') }, ran({ ran: false }), quiet).reason, 'wsh-blocked')
  })

  it('treats a non-zero exit with NO result file as a script that never ran', () => {
    // The helper opens its result file before doing anything else, so silence
    // means policy or a parse failure -- not one of the refusals it reports itself.
    const verdict = shortcutVerdict('install', { status: 1 }, ran({ ran: false }), quiet)
    assert.equal(verdict.reason, 'wsh-blocked')
    assert.equal(verdict.code, 1)
    assert.match(verdict.error, /did not run/)
  })

  it('still reports what the helper said when it ran and refused', () => {
    const verdict = shortcutVerdict('apply', { status: 4 }, ran({ error: 'the shell refused to save the shortcut' }), quiet)
    assert.equal(verdict.reason, undefined)
    assert.equal(verdict.error, 'the shell refused to save the shortcut')
    assert.equal(verdict.code, 4)
  })
})

/**
 * The advanced settings route: the surface the card writes on a DSH whose
 * settings service has no writable plugin form (0.1.7).
 */
describe('parseSettingsPatch', () => {
  it('accepts each field at its bounds', () => {
    assert.deepEqual(parseSettingsPatch({ delayMs: 0 }).patch, { delayMs: 0 })
    assert.deepEqual(
      parseSettingsPatch({ delayMs: MAX_DELAY_MS, exitCode: 255, hard: true }).patch,
      { delayMs: MAX_DELAY_MS, exitCode: 255, hard: true },
    )
  })

  it('refuses an out-of-range value instead of clamping it', () => {
    // Deliberately unlike the shutdown body, which clamps: there the value is
    // read once by a route that is about to end the process, while here a person
    // typed it and will read it back, so 30001 must not silently become 30000.
    assert.match(parseSettingsPatch({ delayMs: MAX_DELAY_MS + 1 }).error, /delayMs/u)
    assert.match(parseSettingsPatch({ delayMs: 1.5 }).error, /delayMs/u)
    assert.match(parseSettingsPatch({ exitCode: 256 }).error, /exitCode/u)
    assert.match(parseSettingsPatch({ exitCode: -1 }).error, /exitCode/u)
    assert.match(parseSettingsPatch({ hard: 'yes' }).error, /hard/u)
  })

  it('needs at least one field it knows', () => {
    assert.match(parseSettingsPatch({}).error, /at least one/u)
    assert.match(parseSettingsPatch({ unknown: 1 }).error, /at least one/u)
    assert.match(parseSettingsPatch(null).error, /object/u)
    assert.match(parseSettingsPatch([]).error, /object/u)
  })
})

describe('createSettingsHandler', () => {
  const drive = async ({
    method = 'POST',
    headers = TRUSTED,
    body = '{}',
    save = async () => ({ delayMs: 1000, exitCode: 0, hard: false }),
  } = {}) => {
    const handler = createSettingsHandler({ save })
    const response = makeResponse()
    await handler(makeRequest({ method, url: '/api/dsh-power-switch/settings', headers, body }), response)
    return response
  }

  it('saves a valid patch and answers the values the host now uses', async () => {
    let saved = null
    const response = await drive({
      body: '{"delayMs":1500,"hard":true}',
      save: async (patch) => { saved = patch; return { delayMs: 1500, exitCode: 0, hard: true } },
    })
    assert.deepEqual(saved, { delayMs: 1500, hard: true })
    assert.equal(response.state.status, 200)
    assert.deepEqual(response.json().settings, { delayMs: 1500, exitCode: 0, hard: true })
  })

  it('refuses an untrusted request, a wrong method and a bad body', async () => {
    assert.equal((await drive({ headers: { ...TRUSTED, origin: 'http://evil.example' } })).state.status, 403)
    assert.equal((await drive({ headers: { ...TRUSTED, 'x-forwarded-for': '10.0.0.1' } })).state.status, 403)
    assert.equal((await drive({ method: 'GET' })).state.status, 405)
    assert.equal((await drive({ body: '{"delayMs":"soon"}' })).state.status, 400)
    assert.equal((await drive({ body: '{"exitCode":999}' })).state.status, 400)
  })

  it('answers a save failure instead of pretending it was saved', async () => {
    const response = await drive({
      body: '{"hard":true}',
      save: async () => { throw new Error('the state directory is read-only') },
    })
    assert.equal(response.state.status, 500)
    assert.equal(response.json().ok, false)
    assert.match(response.json().error, /read-only/u)
  })
})

describe('createRestartHandler', () => {
  /** Drive the restart route once, with the real exit responder shortened. */
  async function drive2({
    config = {}, respawn = () => ({ pid: 4242 }), request = {}, persist, planProblem, awaitRespawn,
  } = {}) {
    const persisted = []
    const exits = []
    const order = []
    const handler = createRestartHandler({
      // A tiny hold by default: the ordering is what this suite is about, and
      // the configured values are asserted from the response payload.
      config: () => resolveConfig({ delayMs: 5, ...config }),
      // ASYNC, because the real `persistLaunchMode` is: a synchronous double here
      // is what let a missing `await` at the call site put a Promise in the
      // response and still pass every assertion in this suite.
      persist: async (mode) => { persisted.push(mode); if (persist !== undefined) return persist(mode); return true },
      respawn: (mode) => { persisted.respawnMode = mode; return respawn(mode) },
      ...(planProblem === undefined ? {} : { planProblem }),
      ...(awaitRespawn === undefined ? {} : { awaitRespawn }),
      exitWith: createExitResponder({
        flushMs: 1,
        watchdogMs: 5,
        // Pending for the duration, like the real launcher's exit callable.
        gracefulExit: () => { order.push('graceful'); return new Promise(() => {}) },
        forceExit: (code) => { order.push('forced'); exits.push(code) },
        note: () => {},
      }),
    })
    const response = makeResponse()
    await handler(makeRequest({ headers: TRUSTED, ...request }), {
      ...response,
      end(chunk) {
        order.push('answered')
        return response.end(chunk)
      },
    })
    // Let the short escalation finish before the assertions read it.
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    return { response, persisted, exits, order }
  }

  it('persists the mode, respawns, answers, then leaves', async () => {
    const { response, persisted, exits, order } = await drive2({ request: { body: '{"launchMode":"app"}' } })
    assert.equal(response.state.status, 200)
    const payload = response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.launchMode, 'app')
    // A BOOLEAN, not the `{}` a serialized Promise becomes: the api contract is
    // what tells a consumer whether the settings document accepted the write.
    assert.equal(typeof payload.persisted, 'boolean')
    assert.equal(payload.persisted, true)
    assert.equal(payload.helperPid, 4242)
    assert.deepEqual(persisted.slice(0, 1), ['app'])
    assert.equal(persisted.respawnMode, 'app')
    // The answer precedes every exit attempt, so the card always learns.
    assert.deepEqual(order, ['answered', 'graceful', 'forced'])
    assert.deepEqual(exits, [0])
  })

  it('keeps the configured hold and code for the restart', async () => {
    const { response, exits } = await drive2({
      config: { delayMs: 250, exitCode: 3 },
      request: { body: '{"launchMode":"tab"}' },
    })
    assert.equal(response.json().delayMs, 250)
    assert.deepEqual(exits, [3])
  })

  it('falls back to the stored mode when the body names none', async () => {
    const { response, persisted } = await drive2({ config: { launchMode: 'app' }, request: { body: '{}' } })
    assert.equal(response.json().launchMode, 'app')
    assert.equal(persisted.respawnMode, 'app')
  })

  it('refuses an unknown mode without persisting or leaving', async () => {
    const { response, persisted, exits } = await drive2({ request: { body: '{"launchMode":"kiosk"}' } })
    assert.equal(response.state.status, 400)
    assert.deepEqual(persisted, [])
    assert.deepEqual(exits, [])
  })

  it('reports a settings write that was refused, and still restarts', async () => {
    // The composition entry is always updated, so a refused settings write must
    // not block the restart the person asked for -- it is reported instead.
    const { response, exits } = await drive2({ persist: async () => false, request: { body: '{"launchMode":"app"}' } })
    assert.equal(response.json().persisted, false)
    assert.equal(typeof response.json().persisted, 'boolean')
    assert.equal(response.json().ok, true)
    assert.equal(exits.length, 1)
  })

  it('refuses to leave when nothing would bring the service back', async () => {
    // A shutdown with no helper is a dead DSH, so this must fail loudly and
    // change nothing.
    const { response, exits } = await drive2({ respawn: () => null, request: { body: '{"launchMode":"app"}' } })
    assert.equal(response.state.status, 500)
    assert.equal(response.json().ok, false)
    assert.match(response.json().error, /bring the service back/u)
    // Without a `planProblem` the reason is the generic one, and it still travels:
    // the card must never be left with only an English sentence to show.
    assert.equal(response.json().reason, 'helper-unavailable')
    assert.deepEqual(exits, [], 'no exit may be scheduled without a helper')
  })

  it('names the specific refusal, so the card can answer in the reader\'s language', async () => {
    const { response, exits } = await drive2({
      respawn: () => null,
      request: { body: '{"launchMode":"app"}' },
      planProblem: () => ({ reason: 'unsupported-host', message: 'this host was not started as a dsh web server (chat)' }),
    })
    assert.equal(response.state.status, 500)
    assert.equal(response.json().reason, 'unsupported-host')
    assert.match(response.json().error, /not started as a dsh web server/u)
    assert.deepEqual(exits, [])
  })

  it('names an unconfirmed helper, which is a different refusal from a failed one', async () => {
    const { response, exits } = await drive2({
      respawn: () => ({ pid: 77, handshake: 'C:\\state\\hs.txt' }),
      awaitRespawn: async () => false,
      request: { body: '{"launchMode":"tab"}' },
    })
    assert.equal(response.state.status, 500)
    assert.equal(response.json().reason, 'helper-not-confirmed')
    assert.deepEqual(exits, [], 'a helper that never checked in must not end the host')
  })

  it('refuses an untrusted caller and a non-POST', async () => {
    const untrusted = await drive2({ request: { headers: { ...TRUSTED, origin: 'http://evil.example' } } })
    assert.equal(untrusted.response.state.status, 403)
    assert.deepEqual(untrusted.exits, [])
    const wrongMethod = await drive2({ request: { method: 'GET' } })
    assert.equal(wrongMethod.response.state.status, 405)
    assert.deepEqual(wrongMethod.exits, [])
  })
})

describe('parseHelperUrl and normalizeLaunchMode', () => {
  it('pulls the token URL out of a helper log', () => {
    const text = '[10:00:00] supervisor: starting\n[10:00:05] dsh web: http://127.0.0.1:3080/?token=abc_DEF-123\n'
    assert.equal(parseHelperUrl(text), 'http://127.0.0.1:3080/?token=abc_DEF-123')
    assert.equal(parseHelperUrl('nothing here'), null)
  })

  it('resolves an unknown launch mode to tab, which is what a plain launch opens', () => {
    assert.equal(normalizeLaunchMode('app'), 'app')
    assert.equal(normalizeLaunchMode('tab'), 'tab')
    assert.equal(normalizeLaunchMode(undefined), 'tab')
    assert.equal(normalizeLaunchMode('APP'), 'tab')
  })
})

/**
 * The startup window is the one place this plugin opens a browser by itself, so
 * every reason NOT to is worth pinning down.
 */
describe('shouldOpenStartupWindow', () => {
  it('opens only for app mode', () => {
    assert.equal(shouldOpenStartupWindow('app', {}), true)
    // Tab mode is already served by DSH's own opener; acting there would produce
    // two tabs, which is worse than doing nothing.
    assert.equal(shouldOpenStartupWindow('tab', {}), false)
  })

  it('stands down when somebody else is opening this boot window', () => {
    // The switch supervisor, the desktop launcher and the standalone restart
    // script all set this: two openers would mean two windows.
    assert.equal(shouldOpenStartupWindow('app', { DSH_POWER_SWITCH_WINDOW_HANDLED: '1' }), false)
  })

  it('honours the per-launch opt-out, whatever the stored mode says', () => {
    assert.equal(shouldOpenStartupWindow('app', { DSH_POWER_SWITCH_NO_WINDOW: '1' }), false)
  })

  it('does not treat any other value as a switch', () => {
    assert.equal(shouldOpenStartupWindow('app', { DSH_POWER_SWITCH_NO_WINDOW: '0' }), true)
    assert.equal(shouldOpenStartupWindow('app', { DSH_POWER_SWITCH_WINDOW_HANDLED: 'yes' }), true)
  })
})

/**
 * The relaunch command is captured from the running process, never rebuilt.
 *
 * This is the fix for the worst failure this plugin had: the supervisor rebuilt
 * `<checkout>/apps/cli/lib/bin.js`, which exists only in a DSH source checkout,
 * so on any other machine `spawn` failed ASYNCHRONOUSLY — after the handshake
 * that makes the host exit. DSH went down with nobody left to start it. Every
 * refusal below is therefore a feature: a refusal happens BEFORE the handshake,
 * so the host keeps serving.
 */
describe('relaunchPlan', () => {
  const boot = (over = {}) => ({
    execPath: 'C:\\nodejs\\node.exe',
    execArgv: [],
    argv: ['C:\\pkg\\apps\\cli\\lib\\bin.js', 'web', '--no-open'],
    cwd: 'C:\\pkg',
    ...over,
  })
  // Both spellings of the CLI entry point are real: `apps/cli/lib/bin.js` in a
  // source checkout, `bin.js` for an installed one. The probe answers for both
  // so each test can exercise the branch it is about.
  const exists = (path) => [
    'C:\\nodejs\\node.exe',
    'C:\\pkg\\apps\\cli\\lib\\bin.js',
    'C:\\pkg\\bin.js',
  ].includes(path)

  it('replays the recorded invocation instead of rebuilding a path', () => {
    const plan = relaunchPlan(boot(), exists)
    assert.equal(plan.error, undefined)
    assert.equal(plan.execPath, 'C:\\nodejs\\node.exe')
    assert.deepEqual(plan.args, ['C:\\pkg\\apps\\cli\\lib\\bin.js', 'web', '--no-open'])
    assert.equal(plan.cwd, 'C:\\pkg')
  })

  it('accepts the alias spelling of the same host', () => {
    const plan = relaunchPlan(boot({ argv: ['C:\\pkg\\bin.js', '--profile', 'web'] }), exists)
    assert.equal(plan.error, undefined)
    assert.deepEqual(plan.args, ['C:\\pkg\\bin.js', '--profile', 'web', '--no-open'])
  })

  it('forces --no-open exactly once, so the replacement opens no tab of its own', () => {
    const withoutFlag = relaunchPlan(boot({ argv: ['C:\\pkg\\bin.js', 'web'] }), exists)
    assert.deepEqual(withoutFlag.args, ['C:\\pkg\\bin.js', 'web', '--no-open'])
    const withFlag = relaunchPlan(boot(), exists)
    assert.equal(withFlag.args.filter((value) => value === '--no-open').length, 1)
  })

  it('keeps node execArgv in front of the script, where node expects them', () => {
    const plan = relaunchPlan(boot({ execArgv: ['--max-old-space-size=4096'] }), exists)
    assert.deepEqual(plan.args.slice(0, 2), ['--max-old-space-size=4096', 'C:\\pkg\\apps\\cli\\lib\\bin.js'])
  })

  it('refuses when the boot script is gone', () => {
    const plan = relaunchPlan(boot({ argv: ['C:\\gone\\bin.js', 'web'] }), exists)
    assert.match(plan.error, /boot script is gone/)
  })

  it('refuses a host that was not started as a dsh web server', () => {
    // A desktop/Electron or TUI host cannot be replaced by replaying its argv;
    // refusing leaves it running, which is strictly better than a dead service.
    const plan = relaunchPlan(boot({ argv: ['C:\\pkg\\bin.js', 'chat'] }), exists)
    assert.match(plan.error, /not started as a dsh web server/)
  })

  it('refuses an empty command line rather than spawning nothing', () => {
    assert.match(relaunchPlan({ execPath: 'C:\\node.exe', argv: [] }, exists).error, /no command line/)
    assert.match(relaunchPlan({ argv: ['C:\\pkg\\bin.js', 'web'] }, exists).error, /no executable path/)
    assert.match(relaunchPlan(null, exists).error, /no executable path/)
  })
})

/**
 * The helper's environment, which is where the PORT travels.
 *
 * Without it the helper probes 3080 and filters the host's recorded URL by that
 * number, so a DSH configured for another port is reported as "no host found" —
 * safe, and useless to the person who clicked.
 */
describe('restartHelperEnv', () => {
  const base = { mode: 'app', hostLog: 'C:\\state\\dsh-web.log', handshake: 'C:\\state\\hs.txt' }

  it('carries the live port so the helper probes the right one', () => {
    assert.equal(restartHelperEnv({ ...base, port: 3099 }).DSH_POWER_SWITCH_PORT, '3099')
  })

  it('leaves the port out when the host never reported one', () => {
    for (const port of [null, undefined, 0, -1, Number.NaN, '3080']) {
      assert.equal(restartHelperEnv({ ...base, port }).DSH_POWER_SWITCH_PORT, undefined, String(port))
    }
  })

  it('passes the mode and the paths the helper writes', () => {
    const env = restartHelperEnv({ ...base, port: 3080 })
    assert.equal(env.DSH_POWER_SWITCH_LAUNCH_MODE, 'app')
    assert.equal(env.DSH_POWER_SWITCH_HANDSHAKE, base.handshake)
    assert.equal(env.DSH_POWER_SWITCH_HOST_LOG, base.hostLog)
    assert.equal(env.DSH_POWER_SWITCH_DELAY, '1')
  })
})

/**
 * Where the host-provided schema library is looked for.
 *
 * The ORDER is the whole point, and it was measured: a plugin installed into
 * `node_modules` cannot resolve `@deepseek-ai/schemastery` from its own location
 * (npm does not carry it — the runtime injects it), while the running host's entry
 * point resolves it in every layout. Asking the plugin's own location first is what
 * made a GitHub install lose its settings section and its persisted mode.
 */
describe('schemasteryReferrers', () => {
  it('asks the host before the plugin itself', () => {
    assert.deepEqual(
      schemasteryReferrers({ hostEntry: 'file:///host/bin.js', self: 'file:///plugin/lib/index.js' }),
      ['file:///host/bin.js', 'file:///plugin/lib/index.js'],
    )
  })

  it('drops an absent host entry and de-duplicates the two', () => {
    assert.deepEqual(schemasteryReferrers({ hostEntry: '', self: 'file:///plugin/lib/index.js' }), ['file:///plugin/lib/index.js'])
    assert.deepEqual(schemasteryReferrers({ hostEntry: 'file:///x.js', self: 'file:///x.js' }), ['file:///x.js'])
    assert.deepEqual(schemasteryReferrers({}), [])
  })
})
