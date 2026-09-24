/**
 * Integration test for the host half's wiring.
 *
 * A fake Cordis context records what the plugin registers and gives the route
 * back, so the test can drive the registered handler end to end without a live
 * harness — and with an injected `appExit`, so nothing asks this process to
 * leave.
 *
 * Run with `node tests/host-wiring.test.mjs`.
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { POWER_ROUTE } from '../src/host.js'
import { apply, inject, name } from '../src/index.js'
import { readRecordedLaunchMode, writeRecordedLaunchMode } from '../scripts/restart-shared.mjs'

/**
 * Mounting this plugin WRITES state: it records the launch mode for the next
 * cold start, and it records the node interpreter it is running on. A test run
 * must never overwrite the real machine's records — that would change which
 * window the next launch opens, and which node a desktop shortcut starts — so
 * every test in this file runs against a throwaway harness home.
 */
let wiringHome
let previousHome
before(async () => {
  previousHome = process.env.DSH_HOME
  wiringHome = await mkdtemp(join(tmpdir(), 'dpb-wiring-'))
  process.env.DSH_HOME = wiringHome
})
after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (wiringHome !== undefined) await rm(wiringHome, { recursive: true, force: true })
})

/**
 * Whether the HOST-provided schema library is reachable from here.
 *
 * `@deepseek-ai/schemastery` is an optional peer dependency that npm does not
 * carry: the harness injects it, so a plain checkout can have an EMPTY
 * `node_modules/@deepseek-ai/schemastery` directory (observed), or none at all.
 * The plugin then skips the settings section BY DESIGN and still registers every
 * route — but the two tests that assert the section would fail with `0 !== 1`,
 * a message that names the symptom and not the cause. They are skipped instead,
 * so a red suite means a real regression.
 *
 * The probe mirrors `loadSchemaBuilder`'s referrers: the running entry point
 * first, then this package.
 */
const schemasteryAvailable = (() => {
  const referrers = [
    typeof process.argv[1] === 'string' && process.argv[1] !== '' ? pathToFileURL(process.argv[1]).href : '',
    new URL('../src/index.js', import.meta.url).href,
  ].filter((referrer) => referrer !== '')
  return referrers.some((referrer) => {
    try {
      createRequire(referrer).resolve('@deepseek-ai/schemastery')
      return true
    } catch {
      return false
    }
  })
})()

/** Skip reason shared by the two tests that need the settings section. */
const NO_SCHEMASTERY = '@deepseek-ai/schemastery is not installed here; the plugin skips the settings section by design'

/**
 * A context double recording registrations, effects, and injected services.
 *
 * `inject` resolves like Cordis does for its common shape: the callback runs
 * once every named service is available, and receives a context that carries
 * them as properties.
 */
function makeContext(services = {}) {
  const registered = []
  const effects = []
  const state = {
    routes: registered,
    effects,
    provided: services,
  }
  const scoped = { ...services }
  const ctx = {
    /**
     * Cordis' effect contract: the callback runs NOW and returns the disposer,
     * which is called LATER (at unload). The double used to call the callback
     * and store its result, which happened to work only for effects whose
     * callback returns a disposer -- an effect whose callback returns a plain
     * value was therefore executed at registration and never cleaned up.
     */
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose: typeof dispose === 'function' ? dispose : () => {} })
    },
    inject(names, callback) {
      if (names.some((service) => state.provided[service] === undefined)) return
      callback(scoped)
    },
    get(service) {
      return state.provided[service]
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
  }
  Object.assign(scoped, ctx)
  return { ctx, state }
}

/** A request double carrying exactly what the fence reads. */
function makeRequest({ method = 'POST', remoteAddress = '127.0.0.1', headers = {}, body = '' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    socket: { remoteAddress },
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A response double recording the answer. */
function makeResponse() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) { state.status = status; return this },
    end(chunk) { if (chunk !== undefined) state.body += chunk.toString('utf8'); return this },
    json() { return JSON.parse(state.body) },
  }
}

const TRUSTED = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }

/** The registered shutdown route, found by path rather than by position. */
const shutdownRoute = (state) => state.routes.find((route) => route.path === POWER_ROUTE)

describe('host plugin wiring', () => {
  it('announces the plugin name and its one required service', () => {
    assert.equal(name, 'dsh-power-switch')
    assert.deepEqual(inject, ['webServer'])
  })

  it('keeps the recorded mode when the host generates no form for this plugin', async () => {
    // The 0.1.7 shape exactly: no `register`, only `describe`/`update`, and no form
    // for this plugin because its row declares no `config:`. That branch publishes the
    // RAW LOADER ROW — and mirroring it overwrote the record on every host start, so a
    // mode set to `app` reverted to `tab`: it survived the switch (which also passes
    // the mode down as an environment variable) and never a cold start.
    const { ctx } = makeContext({ settings: { describe: () => [], update: () => {} } })
    writeRecordedLaunchMode('app')
    apply(ctx, {})
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    assert.equal(readRecordedLaunchMode(), 'app', 'the row default must not clobber a recorded choice')
  })

  it('still follows a form value the host does track for this entry', async () => {
    // The other side of the same flag: a generated form (or a 0.1.6 settings section)
    // IS a user layer, so the record follows it — that is the only reason the mirror
    // exists.
    const { ctx } = makeContext({
      settings: {
        describe: () => [{ ns: 'power-switch', value: { launchMode: 'app' } }],
        update: () => {},
      },
    })
    writeRecordedLaunchMode('tab')
    apply(ctx, {})
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    assert.equal(readRecordedLaunchMode(), 'app')
  })

  it('registers the shutdown, configuration, restart, shortcut and settings routes', () => {
    const { ctx, state } = makeContext()
    apply(ctx, {})
    assert.equal(state.routes.length, 5)
    assert.deepEqual(
      state.routes.map((route) => route.path).sort(),
      [
        '/api/dsh-power-switch/config',
        '/api/dsh-power-switch/restart',
        '/api/dsh-power-switch/settings',
        '/api/dsh-power-switch/shortcut',
        '/api/dsh-power-switch/shutdown',
      ],
    )
    for (const route of state.routes) {
      assert.equal(route.kind, 'exact')
      assert.equal(typeof route.handler, 'function')
    }
  })

  it('registers each route inside its own labelled effect, so unloading retracts it', () => {
    const { ctx, state } = makeContext()
    apply(ctx, {})
    // Five routes plus the exit-probe lifetime effect.
    assert.equal(state.effects.length, 6)
    const labels = state.effects.map((effect) => effect.label).join('\n')
    assert.match(labels, /shutdown route/)
    assert.match(labels, /configuration route/)
    assert.match(labels, /restart route/)
    assert.match(labels, /shortcut route/)
    assert.match(labels, /settings route/)
    assert.match(labels, /exit probe lifetime/)
    for (const effect of state.effects) assert.equal(typeof effect.dispose, 'function')
  })

  it('asks the launcher to leave through ctx.appExit, never through a raw kill', async () => {
    const codes = []
    const { ctx, state } = makeContext({ appExit: (code) => { codes.push(code) } })
    // Shrink the two exit timings so the grace windows do not have to be waited
    // out; production uses the defaults.
    apply(ctx, { delayMs: 5 }, { flushMs: 1, watchdogMs: 5 })
    const response = makeResponse()
    await shutdownRoute(state).handler(makeRequest({ headers: TRUSTED, body: '{}' }), response)
    assert.equal(response.state.status, 200)
    assert.deepEqual(codes, [], 'the exit runs after the response flush, not inline')
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    assert.deepEqual(codes, [0])
  })

  it('carries the loader-row configuration into the exit', async () => {
    const codes = []
    const { ctx, state } = makeContext({ appExit: (code) => { codes.push(code) } })
    apply(ctx, { delayMs: 5, exitCode: 3 }, { flushMs: 1, watchdogMs: 5 })
    await shutdownRoute(state).handler(makeRequest({ headers: TRUSTED, body: '{}' }), makeResponse())
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    assert.deepEqual(codes, [3])
  })

  it('a refusal never reaches appExit', async () => {
    const codes = []
    const { ctx, state } = makeContext({ appExit: (code) => { codes.push(code) } })
    apply(ctx, { delayMs: 5 }, { flushMs: 1, watchdogMs: 5 })
    const response = makeResponse()
    await shutdownRoute(state).handler(
      makeRequest({ headers: { ...TRUSTED, origin: 'http://evil.example' } }),
      response,
    )
    assert.equal(response.state.status, 403)
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    assert.deepEqual(codes, [])
  })

  it('still answers and leaves when the host has no settings service', async () => {
    const codes = []
    const { ctx, state } = makeContext({ appExit: (code) => { codes.push(code) } })
    apply(ctx, { delayMs: 5 }, { flushMs: 1, watchdogMs: 5 })
    // All five routes exist; only the host-generated configuration form is lost
    // without a settings provider (the advanced settings are recorded by the
    // plugin itself, so they stay editable).
    assert.equal(state.routes.length, 5)
    await shutdownRoute(state).handler(makeRequest({ headers: TRUSTED, body: '{}' }), makeResponse())
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    assert.deepEqual(codes, [0])
  })

  it('mounts a settings section and keeps a write scope for the card', (t) => {
    if (!schemasteryAvailable) return t.skip(NO_SCHEMASTERY)
    const sections = []
    const registrations = []
    const { ctx } = makeContext({
      settings: {
        // `register` is the call that hands back a write scope; the section is
        // then attached over it so the card can persist a launch mode.
        register(ns, schema, options) {
          registrations.push({ ns, schema, options })
          return { get: () => options.base, update: (patch) => { registrations.patch = patch } }
        },
        installSection(owner, ns, schema, entry, hooks) {
          sections.push({ owner, ns, schema, entry, hooks })
        },
      },
    })
    apply(ctx, {})
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(registrations.length, 1)
        assert.equal(registrations[0].ns, 'dsh-power-switch')
        assert.equal(sections.length, 1)
        assert.equal(sections[0].ns, 'dsh-power-switch')
        assert.equal(typeof sections[0].hooks.setSource, 'function')
        assert.equal(typeof sections[0].hooks.onChange, 'function')
        resolve()
      }, 20)
    })
  })

  it('persists the mode into the composition entry, and refuses to leave when it cannot restart', async (t) => {
    if (!schemasteryAvailable) return t.skip(NO_SCHEMASTERY)
    let patch
    const codes = []
    const { ctx, state } = makeContext({
      appExit: (code) => { codes.push(code) },
      settings: {
        register: (ns, schema, options) => ({
          get: () => options.base,
          update: (next) => { patch = next },
        }),
        installSection: () => {},
      },
    })
    const config = { delayMs: 5, launchMode: 'tab' }
    apply(ctx, config, { flushMs: 1, watchdogMs: 5 })
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    const restart = state.routes.find((route) => route.path === '/api/dsh-power-switch/restart')
    const response = makeResponse()
    await restart.handler(makeRequest({ headers: TRUSTED, body: '{"launchMode":"app"}' }), response)

    assert.equal(response.json().launchMode, 'app')
    // The entry is the supervisor's fallback, so it must carry the new mode even
    // if the settings service refused or never mounted.
    assert.equal(config.launchMode, 'app')
    assert.deepEqual(patch, { launchMode: 'app' })

    // This test runner is NOT a `dsh web` host, so the plugin has no recorded
    // command it could replay. It must then REFUSE the restart and stay alive:
    // exiting here is precisely the failure that once left DSH down for good with
    // nobody to bring it back. The leaving path is covered by
    // `createRestartHandler`'s own suite, which injects a working respawn.
    assert.equal(response.state.status, 500)
    // The refusal NAMES itself, which is what lets the card answer in the reader's
    // language instead of pasting a host diagnostic at them.
    assert.equal(response.json().reason, 'unsupported-host')
    assert.match(response.json().error, /not started as a dsh web server/)
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    assert.deepEqual(codes, [], 'a refused restart must never reach appExit')
  })
})
