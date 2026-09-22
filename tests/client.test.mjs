/**
 * Tests for the power-switch browser half.
 *
 * The factory is loaded the way the client module system loads it -- a fake
 * `window.__ModuleLoader__` captures the registration -- and the card is then
 * rendered by a minimal hook runtime that keeps state across re-renders, so
 * the assertions can walk real slots, run real event handlers, observe
 * re-renders, and inspect the real fetch payload.
 *
 * Run with `node scripts/run-tests.mjs` (the sandboxed test runner cannot spawn
 * its per-file children, so the suites are imported into one process).
 */

import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT_FILE = fileURLToPath(new URL('../client.js', import.meta.url))

/** The card's liveness-probe interval, as declared in client.js. */
const PROBE_INTERVAL_MS = 1000

/**
 * A hook runtime that re-renders synchronously on `setState`.
 *
 * Hooks are kept per component function, so a re-render triggered from an event
 * handler observes the same slot values the next render would -- which is what
 * makes the click handlers observable without a full React.
 * @param render - re-renders the active component.
 * @returns the element factory handed to the bundle in place of `react`.
 */
function createHookRuntime(render) {
  const elementSymbol = Symbol('element')
  const perComponent = new WeakMap()
  let cursor = 0
  let active
  return {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({
      $$typeof: elementSymbol,
      type,
      props: {
        ...(props ?? {}),
        ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
      },
    }),
    useState: (initial) => {
      const state = perComponent.get(active) ?? []
      perComponent.set(active, state)
      const at = cursor
      state[at] ??= typeof initial === 'function' ? initial() : initial
      cursor += 1
      return [state[at], (next) => {
        const value = typeof next === 'function' ? next(state[at]) : next
        if (Object.is(value, state[at])) return
        state[at] = value
        cursor = 0
        render()
      }]
    },
    // Same ordered slot list as `useState`: the card calls its hooks
    // unconditionally in a fixed order, which is the contract React relies on.
    // `useEffect` is a no-op because these mounts never unmount, so the card's
    // unmount cleanup is not what any assertion here observes.
    useRef: (initial) => {
      const state = perComponent.get(active) ?? []
      perComponent.set(active, state)
      const at = cursor
      state[at] ??= { current: typeof initial === 'function' ? initial() : initial }
      cursor += 1
      return state[at]
    },
    useEffect: () => {},
    beginRender(component) {
      active = component
      cursor = 0
    },
  }
}

/** A stub primitives module; `Modal: undefined` models an older host. */
function makePrimitives() {
  return {
    Button: function Button() { return null },
    Modal: function Modal() { return null },
  }
}

/**
 * Load the client factory into this process.
 * @returns the registration, the mount entry point, and the captured style tags.
 */
async function loadBundle() {
  const source = await readFile(CLIENT_FILE, 'utf8')
  const styleTags = []
  const documentStub = {
    documentElement: { lang: 'zh-CN' },
    baseURI: 'http://127.0.0.1:3080/',
    head: { appendChild(tag) { styleTags.push(tag) } },
    createElement() { return { dataset: {}, textContent: '' } },
    querySelector() { return null },
  }
  let registration
  const windowStub = {
    __ModuleLoader__: { load(value) { registration = value } },
    location: { href: 'http://127.0.0.1:3080/', reload() {} },
    // Forward at CALL time, not capture time: the watch-behaviour tests
    // intercept `globalThis.setTimeout` to catch the card's liveness probe, and
    // a captured reference would keep reaching the real timer instead.
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    confirm: () => true,
    /**
     * The window facts the card's close-strategy detector reads.
     *
     * All three shapes are real, measured on Edge 151:
     *   - a normal tab (`opener` null, not standalone) -> window.close refused
     *   - an app window (`--app=`, standalone true)    -> window.close honoured
     *   - a script-opened popup (`opener` set)         -> window.close honoured
     * Tests set these to pick the branch under assertion.
     */
    opener: {},
    standalone: false,
    name: '',
    matchMedia: (query) => ({
      matches: windowStub.standalone === true && String(query).includes('standalone'),
    }),
    closed: false,
    close() { windowStub.closed = true },
    // Flipped per mount: the card polls while confirming the exit, and most
    // tests want that off so no stray probe fires after they assert.
    __DSH_POWER_SWITCH_NO_REVIVAL__: true,
  }
  const isolation = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  }
  globalThis.window = windowStub
  // eslint-disable-next-line no-new-func -- loading the artifact is the point
  new Function('window', 'document', source)(windowStub, documentStub)

  // Live references: the bundle captures `require('react')` at factory time, so
  // the object it holds must stay stable while the hook runtime is swapped in
  // per mount.
  let runtime
  const reactShim = {
    Fragment: Symbol('Fragment'),
    createElement: (...args) => runtime.createElement(...args),
    useState: (...args) => runtime.useState(...args),
    useRef: (...args) => runtime.useRef(...args),
    useEffect: (...args) => runtime.useEffect(...args),
  }
  const primitives = makePrimitives()
  const moduleFace = registration.factory((specifier) => {
    if (specifier === 'react') return reactShim
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${specifier}`)
  })

  /**
   * Mount the card and expose a re-render-aware tree getter.
   *
   * The translator stub answers only the keys a test supplies and reports every
   * other key as absent, so the card's own copy sheet is what the text
   * assertions see. A stub echoing every key would make those assertions
   * vacuous, and no translator at all would skip the host-translator path.
   * @param view - the view the page asks for.
   * @param fetchImpl - the fetch double the card should use.
   * @param overrides - primitives overrides, the `revival` switch, translations.
   * @returns the registration face and a live tree getter.
   */
  const mount = (view = 'page', fetchImpl = isolation.fetch, overrides = {}) => {
    if ('Modal' in overrides) primitives.Modal = overrides.Modal
    if ('Button' in overrides) primitives.Button = overrides.Button
    // Every mount starts from the SAME window shape, so one test's branch
    // cannot leak into the next: a script-opened window that is not standalone.
    windowStub.opener = 'opener' in overrides ? overrides.opener : {}
    windowStub.standalone = overrides.standalone === true
    windowStub.name = overrides.windowName ?? ''
    windowStub.closed = false
    windowStub.__DSH_POWER_SWITCH_NO_REVIVAL__ = overrides.revival !== true
    const translations = overrides.translations ?? {}
    const registrations = []
    const ctx = {
      locale: {
        register() { return {} },
        bind: () => (key) => translations[key],
      },
      slots: {
        inject(name, register) { registrations.push({ name, register }) },
        register(options, render) { return { ...options, render } },
      },
    }
    moduleFace.apply(ctx)
    globalThis.fetch = fetchImpl
    // TWO seats: the Plugins-page card and the sidebar-foot power button. Pick
    // the card by NAME rather than by position, so the order they happen to be
    // claimed in cannot silently change what these tests inspect.
    assert.equal(registrations.length, 2)
    const cardSeat = registrations.find((entry) => entry.name === 'plugins.item')
    assert.notEqual(cardSeat, undefined, 'the Plugins-page card seat must be claimed')
    const options = cardSeat.register()
    const state = { tree: undefined }
    const render = () => {
      runtime.beginRender(options.render)
      state.tree = options.render({ view, ...options.inject() })
    }
    runtime = createHookRuntime(render)
    render()
    return {
      options,
      primitives,
      get tree() { return state.tree },
    }
  }

  return {
    registration,
    moduleFace,
    styleTags,
    mount,
    /** The window double, so a test can set `opener` and observe `close()`. */
    windowStub,
    restore() {
      globalThis.window = isolation.window
      globalThis.document = isolation.document
      globalThis.fetch = isolation.fetch
    },
  }
}

/**
 * Walk an element tree and collect nodes matching a predicate.
 *
 * It descends every prop, not just `children`, because a slot component may
 * hand elements to a child through a named prop (`footer`, `icon`) and those
 * are as present in the tree as the children are.
 * @param node - the element (or array, or primitive) to walk.
 * @param predicate - matches the elements to collect.
 * @param found - accumulator.
 * @returns every matching element.
 */
function collect(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const value of Object.values(node.props ?? {})) {
    if (value !== null && typeof value === 'object') collect(value, predicate, found)
  }
  return found
}

/** All text content of a subtree, flattened. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const byAction = (tree) => collect(tree, (node) => node.props?.['data-dsh-power-action'] === 'shutdown')[0]
const byConfirm = (tree) => collect(tree, (node) => node.props?.['data-dsh-power-confirm'] === 'true')[0]
const byClose = (tree) => collect(tree, (node) => node.props?.['data-dsh-power-close'] === 'true')[0]
/**
 * The launch-mode switch.
 *
 * Matched by the MODE it targets, not by the attribute's presence: the card's
 * root element carries the same attribute with an empty value, so a mere
 * presence check returns the root and every click assertion then fails on a
 * node with no handler.
 */
const bySwitch = (tree) => collect(tree, (node) => {
  const mode = node.props?.['data-dsh-power-switch']
  return mode === 'app' || mode === 'tab'
})[0]
const statusNode = (tree) => collect(tree, (node) => node.props?.['data-phase'] !== undefined)[0]
const phaseOf = (tree) => statusNode(tree)?.props['data-phase']
/**
 * The dialog elements that are actually showing.
 *
 * The card always renders its Modal element and drives visibility through
 * `open`, exactly as the host's own modal-based dialogs do, so "is the dialog
 * up?" is a question about that prop.
 */
const openDialogs = (tree, primitives) => collect(
  tree,
  (node) => node.type === primitives.Modal && node.props?.open === true,
)

/** Let the microtask queue drain so an awaited fetch chain settles. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0) })

/**
 * Intercept only the card's liveness probe.
 *
 * The card arms it as `setTimeout(fn, PROBE_INTERVAL_MS)`. Everything else --
 * including this file's own `settle()` -- must keep reaching the real timer, or
 * the test runner itself stops making progress.
 * @returns a restore function plus the captured probe callbacks.
 */
function captureProbes() {
  const realSetTimeout = globalThis.setTimeout
  const timers = []
  const seen = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    seen.push(ms)
    if (ms === PROBE_INTERVAL_MS) {
      timers.push(fn)
      return 0
    }
    return realSetTimeout(fn, ms, ...rest)
  }
  return {
    timers,
    seen,
    restore() { globalThis.setTimeout = realSetTimeout },
  }
}

describe('client bundle artifact', () => {
  it('registers under the plugin id the loader serves', async () => {
    const bundle = await loadBundle()
    try {
      assert.equal(bundle.registration.id, 'dsh-power-switch')
    } finally { bundle.restore() }
  })

  it('declares the client services it needs', async () => {
    const bundle = await loadBundle()
    try {
      assert.equal(bundle.moduleFace.name, 'dsh-power-switch')
      // SERVICE names, resolved through the renderer's context. Putting a
      // package name here (or a service name in package.json's
      // `dsh.client.inject`, which is a PACKAGE list) silently loses the card.
      assert.deepEqual(bundle.moduleFace.inject, ['slots', 'locale'])
      assert.equal(typeof bundle.moduleFace.apply, 'function')
    } finally { bundle.restore() }
  })

  it('never names a package row that the boot graph cannot compose', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const rows = manifest.dsh.client.inject ?? []
    // `@deepseek-ai/dsh-client-ui-slots` ships its registry inside the renderer
    // and declares no `dsh.client` of its own, so a row naming it can never be
    // composed -- that mistake silently removed this card's whole bundle entry.
    assert.ok(!rows.includes('@deepseek-ai/dsh-client-ui-slots'))
    for (const row of rows) assert.ok(row.length > 0)
  })

  it('declares the services whose absence would break it, so the host waits', async () => {
    const bundle = await loadBundle()
    try {
      // `slots` and `locale` are both used at apply time, so both must be
      // declared: declaring them is what makes the host defer the mount until
      // they exist, instead of calling apply with a half-built context.
      const registered = []
      bundle.moduleFace.apply({
        locale: { register() {}, bind: () => () => undefined },
        slots: {
          inject(name, register) { registered.push({ name, register }) },
          register(options, render) { return { ...options, render } },
        },
      })
      assert.equal(registered.length, 2)
      assert.deepEqual(
        registered.map((entry) => entry.name).sort(),
        ['plugins.item', 'sidebar.footer.action'],
      )
    } finally { bundle.restore() }
  })

  it('injects one stylesheet tagged with the plugin id', async () => {
    const bundle = await loadBundle()
    try {
      bundle.mount()
      // One stylesheet per seat — the card's, and the sidebar button's — and
      // every one of them is tagged with the plugin id so a composition can tell
      // where it came from.
      assert.ok(bundle.styleTags.length >= 1)
      for (const tag of bundle.styleTags) assert.equal(tag.dataset.plugin, 'dsh-power-switch')
      assert.match(bundle.styleTags.map((tag) => tag.textContent).join('\n'), /dpb-danger/)
    } finally { bundle.restore() }
  })
})

describe('Plugins-page card registration', () => {
  it('claims a slot on the Plugins page, last in the list', async () => {
    const bundle = await loadBundle()
    try {
      const { options } = bundle.mount()
      assert.equal(options.name, 'plugins.item')
      assert.equal(options.id, 'dsh-power-switch')
      assert.equal(options.locale, 'dsh-power-switch')
      assert.ok(options.order >= 1000, 'a power control belongs after the official cards')
      assert.equal(typeof options.label, 'function')
    } finally { bundle.restore() }
  })

  it('renders the one-liner in the summary view', async () => {
    const bundle = await loadBundle()
    try {
      const tree = bundle.mount('summary').tree
      assert.equal(typeof tree, 'string')
      assert.ok(tree.length > 0)
    } finally { bundle.restore() }
  })

  it('names itself first in the summary, so the row is recognisable', async () => {
    const bundle = await loadBundle()
    try {
      const { options } = bundle.mount()
      const summary = options.render({ view: 'summary' })
      // This is the line under the title in the card list: an action sentence
      // here reads like somebody else's row, which is exactly how this card was
      // reported missing while it was rendering all along.
      assert.match(summary, /^dsh-power-switch/)
    } finally { bundle.restore() }
  })

  it('uses the host translator when it serves the namespace', async () => {
    const bundle = await loadBundle()
    try {
      const mounted = bundle.mount('page', undefined, { translations: { title: 'Host title' } })
      assert.equal(mounted.options.label(), 'Host title')
    } finally { bundle.restore() }
  })

  it('falls back to its own copy when the host translator is absent', async () => {
    const bundle = await loadBundle()
    try {
      const { options } = bundle.mount()
      const label = options.label()
      const summary = options.render({ view: 'summary' })
      assert.equal(
        typeof label,
        'string',
        `label=${String(label)} summary=${JSON.stringify(summary)} window=${typeof globalThis.window} document=${typeof globalThis.document} lang=${String(globalThis.document?.documentElement?.lang)}`,
      )
      assert.ok(label.length > 0, 'the card must never register an empty label')
    } finally { bundle.restore() }
  })
})

describe('the power control', () => {
  it('renders a destructive action button and a status line', async () => {
    const bundle = await loadBundle()
    try {
      const tree = bundle.mount().tree
      const button = byAction(tree)
      assert.equal(typeof button.type, 'function')
      assert.equal(button.props.className, 'dpb-danger')
      assert.equal(button.props.disabled, false)
      assert.equal(phaseOf(tree), 'idle')
      assert.equal(byClose(tree), undefined, 'no close button before anything happened')
    } finally { bundle.restore() }
  })

  it('renders no confirmation dialog while idle', async () => {
    const bundle = await loadBundle()
    try {
      const mounted = bundle.mount()
      assert.equal(openDialogs(mounted.tree, mounted.primitives).length, 0)
    } finally { bundle.restore() }
  })

  it('opens the confirmation dialog instead of sending on the first click', async () => {
    const bundle = await loadBundle()
    const requests = []
    try {
      const mounted = bundle.mount('page', async (...args) => {
        requests.push(args)
        return { ok: true, status: 200, json: async () => ({ ok: true, pid: 1 }) }
      })
      byAction(mounted.tree).props.onClick()
      assert.equal(requests.length, 0, 'the first click must not send')
      assert.equal(openDialogs(mounted.tree, mounted.primitives).length, 1)
      assert.equal(phaseOf(mounted.tree), 'idle')
      assert.equal(typeof byConfirm(mounted.tree).props.onClick, 'function')
    } finally { bundle.restore() }
  })

  it('closes the dialog on cancel without sending anything', async () => {
    const bundle = await loadBundle()
    const requests = []
    try {
      const mounted = bundle.mount('page', async (...args) => {
        requests.push(args)
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      })
      byAction(mounted.tree).props.onClick()
      const dialog = openDialogs(mounted.tree, mounted.primitives)[0]
      assert.equal(dialog.props.open, true)
      dialog.props.onClose()
      assert.equal(requests.length, 0)
      assert.equal(openDialogs(mounted.tree, mounted.primitives).length, 0)
      assert.equal(phaseOf(mounted.tree), 'idle')
    } finally { bundle.restore() }
  })

  it('posts the shutdown request once confirmed and reports the pid', async () => {
    const bundle = await loadBundle()
    const requests = []
    try {
      const mounted = bundle.mount('page', async (url, init) => {
        requests.push({ url, init })
        return { ok: true, status: 200, json: async () => ({ ok: true, shuttingDown: true, pid: 4242 }) }
      })
      byAction(mounted.tree).props.onClick()
      byConfirm(mounted.tree).props.onClick()
      await settle()
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, '/api/dsh-power-switch/shutdown')
      assert.equal(requests[0].init.method, 'POST')
      assert.deepEqual(JSON.parse(requests[0].init.body), { delayMs: 700 })
      assert.match(textOf(mounted.tree), /4242/)
      assert.equal(openDialogs(mounted.tree, mounted.primitives).length, 0, 'the dialog closes once the request is away')
      assert.equal(phaseOf(mounted.tree), 'waiting')
      assert.equal(byAction(mounted.tree).props.disabled, true)
    } finally { bundle.restore() }
  })

  it('reports a refused request instead of claiming success', async () => {
    const bundle = await loadBundle()
    try {
      const mounted = bundle.mount('page', async () => ({
        ok: false, status: 403, json: async () => ({ ok: false, error: 'untrusted request' }),
      }))
      byAction(mounted.tree).props.onClick()
      byConfirm(mounted.tree).props.onClick()
      await settle()
      assert.equal(phaseOf(mounted.tree), 'failed')
      assert.match(textOf(statusNode(mounted.tree)), /403/)
      assert.equal(byAction(mounted.tree).props.disabled, false, 'a refusal must leave the button usable')
      // The process is still up, so the page still works: no close advice.
      assert.equal(byClose(mounted.tree), undefined)
    } finally { bundle.restore() }
  })

  it('treats a transport failure as sent, because the socket dies with the server', async () => {
    const bundle = await loadBundle()
    try {
      const mounted = bundle.mount('page', async () => { throw new TypeError('Failed to fetch') })
      byAction(mounted.tree).props.onClick()
      byConfirm(mounted.tree).props.onClick()
      await settle()
      assert.equal(phaseOf(mounted.tree), 'waiting')
    } finally { bundle.restore() }
  })

  it('stops waiting and says so once the process is gone', async () => {
    const bundle = await loadBundle()
    // Capture from the start: the card arms the probe inside the click handler,
    // before any await could install an interceptor.
    const probes = captureProbes()
    try {
      // The POST lands; every later request is the liveness probe, and this
      // stub drops it -- which is what a dead server looks like from the page.
      let posted = false
      const mounted = bundle.mount('page', async (url) => {
        if (String(url).startsWith('/api/')) {
          posted = true
          return { ok: true, status: 200, json: async () => ({ ok: true, shuttingDown: true, pid: 9 }) }
        }
        throw new TypeError('Failed to fetch')
      }, { revival: true })
      byAction(mounted.tree).props.onClick()
      byConfirm(mounted.tree).props.onClick()
      await settle()
      assert.equal(posted, true, 'the shutdown request was sent')
      assert.equal(phaseOf(mounted.tree), 'waiting')
      assert.equal(probes.timers.length, 1, 'the card armed exactly one liveness probe')

      probes.timers[0]()
      await settle()

      // A plain shutdown never comes back, so the watch has to end. The old
      // version polled for 90 seconds and left the button reading "waiting".
      assert.equal(phaseOf(mounted.tree), 'gone')
      assert.equal(byAction(mounted.tree).props.disabled, true)
      assert.notEqual(byClose(mounted.tree), undefined, 'the person gets a way to close the dead page')
      // Clicking it really calls window.close (this stub's opener is set, which
      // is the only shape a browser would honour).
      assert.equal(bundle.windowStub.closed, false)
      assert.doesNotThrow(() => byClose(mounted.tree).props.onClick())
      assert.equal(bundle.windowStub.closed, true, 'the close button reaches window.close()')
      assert.match(textOf(mounted.tree), /\u5173\u95ed\u6b64\u9875\u9762/u)
    } finally {
      probes.restore()
      bundle.restore()
    }
  })

  it('offers the close button in a script-opened window', async () => {
    const bundle = await loadBundle()
    const probes = captureProbes()
    try {
      // Same shape as the measured popup: opener set, not standalone.
      const mounted = bundle.mount('page', async (url) => {
        if (String(url).startsWith('/api/')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, shuttingDown: true, pid: 9 }) }
        }
        throw new TypeError('Failed to fetch')
      }, { revival: true, opener: {} })
      byAction(mounted.tree).props.onClick()
      byConfirm(mounted.tree).props.onClick()
      await settle()
      probes.timers[0]()
      await settle()

      assert.equal(phaseOf(mounted.tree), 'gone')
      assert.notEqual(byClose(mounted.tree), undefined, 'a popup can be closed, so it gets the button')
      assert.equal(bundle.windowStub.closed, false)
      assert.doesNotThrow(() => byClose(mounted.tree).props.onClick())
      assert.equal(bundle.windowStub.closed, true, 'the close button reaches window.close()')
    } finally {
      probes.restore()
      bundle.restore()
    }
  })

  it('closes itself in an app window, without being asked', async () => {
    const bundle = await loadBundle()
    const probes = captureProbes()
    try {
      // The measured app window: display-mode standalone true, opener null.
      const mounted = bundle.mount('page', async (url) => {
        if (String(url).startsWith('/api/')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, shuttingDown: true, pid: 9 }) }
        }
        throw new TypeError('Failed to fetch')
      }, { revival: true, standalone: true, opener: null })
      byAction(mounted.tree).props.onClick()
      byConfirm(mounted.tree).props.onClick()
      await settle()
      probes.timers[0]()
      await settle()

      assert.equal(phaseOf(mounted.tree), 'gone')
      assert.equal(bundle.windowStub.closed, true, 'an app window closes itself with no click')
      // And it offers no button: there is nothing left to click.
      assert.equal(byClose(mounted.tree), undefined)
    } finally {
      probes.restore()
      bundle.restore()
    }
  })

  it('tells a person-opened tab the key to press instead of a dead button', async () => {
    const bundle = await loadBundle()
    const probes = captureProbes()
    try {
      // The measured normal tab: opener null AND not standalone. This is what a
      // plain `dsh web` launch produces, and window.close() is refused there.
      const mounted = bundle.mount('page', async (url) => {
        if (String(url).startsWith('/api/')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, shuttingDown: true, pid: 9 }) }
        }
        throw new TypeError('Failed to fetch')
      }, { revival: true, opener: null, standalone: false })
      byAction(mounted.tree).props.onClick()
      byConfirm(mounted.tree).props.onClick()
      await settle()
      probes.timers[0]()
      await settle()

      assert.equal(phaseOf(mounted.tree), 'gone')
      assert.equal(bundle.windowStub.closed, false, 'nothing pretends it can close a plain tab')
      assert.equal(byClose(mounted.tree), undefined, 'no button that cannot work')
      const hint = collect(mounted.tree, (node) => node.props?.['data-dsh-power-closehint'] === 'true')[0]
      assert.notEqual(hint, undefined, 'the person is told how to close the tab')
      assert.match(textOf(hint), /Ctrl\+W/u)
    } finally {
      probes.restore()
      bundle.restore()
    }
  })

  it('admits the process never went down instead of pretending', async () => {
    const bundle = await loadBundle()
    const realDateNow = Date.now
    const probes = captureProbes()
    try {
      // The POST lands, and every probe still answers: nothing stopped. The
      // watch window is forced past its deadline so the assertion is immediate.
      const mounted = bundle.mount('page', async (url) => {
        if (String(url).startsWith('/api/')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, shuttingDown: true, pid: 9 }) }
        }
        return { ok: true, status: 200, json: async () => ({}) }
      }, { revival: true })
      byAction(mounted.tree).props.onClick()
      byConfirm(mounted.tree).props.onClick()
      await settle()
      assert.equal(phaseOf(mounted.tree), 'waiting')
      assert.equal(probes.timers.length, 1)

      Date.now = () => realDateNow() + 60_000
      try {
        probes.timers[0]()
        await settle()
      } finally {
        Date.now = realDateNow
      }

      assert.equal(phaseOf(mounted.tree), 'failed')
      assert.match(textOf(statusNode(mounted.tree)), /\u4ecd\u5728\u8fd0\u884c/u)
      assert.equal(byAction(mounted.tree).props.disabled, false, 'a retry must be possible')
      // It did NOT stop, so the page is still useful.
      assert.equal(byClose(mounted.tree), undefined)
    } finally {
      probes.restore()
      bundle.restore()
    }
  })

  it('uses the native confirm when the host offers no modal primitive', async () => {
    const bundle = await loadBundle()
    const requests = []
    try {
      const mounted = bundle.mount('page', async (...args) => {
        requests.push(args)
        return { ok: true, status: 200, json: async () => ({ ok: true, pid: 7 }) }
      }, { Modal: undefined })
      byAction(mounted.tree).props.onClick()
      await settle()
      assert.equal(requests.length, 1, 'the native confirm path sends immediately')
      assert.equal(openDialogs(mounted.tree, mounted.primitives).length, 0)
      assert.equal(phaseOf(mounted.tree), 'waiting')
    } finally { bundle.restore() }
  })

  it('explains a NAMED restart refusal in the reader\'s language', async () => {
    // The host refuses rather than risk an outage, and it names why. Pasting its
    // English diagnostic onto a Chinese page was the alternative, and that is the
    // difference this test pins down.
    const bundle = await loadBundle()
    try {
      const mounted = bundle.mount('page', async (url) => {
        const target = String(url)
        if (target.includes('/shortcut')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, action: 'nothing' }) }
        }
        if (target.includes('/restart')) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ ok: false, reason: 'unsupported-host', error: 'this host was not started as a dsh web server' }),
          }
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, launchMode: 'tab' }) }
      })
      await settle()
      bySwitch(mounted.tree).props.onClick()
      await settle()
      const shown = textOf(statusNode(mounted.tree))
      assert.match(shown, /无法自动重启/u, 'the card must explain the refusal itself')
      assert.doesNotMatch(shown, /dsh web server/u, 'and must not paste the host diagnostic at the reader')
      // The switch stays usable: a refusal is not a dead end.
      assert.equal(bySwitch(mounted.tree).props.disabled, false)
    } finally { bundle.restore() }
  })
})
