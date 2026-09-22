/**
 * End-to-end check of the browser half over a real HTTP origin.
 *
 * The artifact is fetched from a throwaway local server (the way the client
 * module system fetches it), evaluated with the harness's `__ModuleLoader__`
 * handoff, applied against a fake `ctx`, and rendered in both views. The point
 * is to catch an artifact-shape mistake -- a wrong registration id, a missing
 * wrapper, an import the loader cannot answer -- without touching a running
 * DSH.
 *
 * Usage: node scripts/verify-client-artifact.mjs
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CLIENT_FILE = fileURLToPath(new URL('../client.js', import.meta.url))

const server = createServer((request, response) => {
  if (request.url !== '/client.js') {
    response.writeHead(404)
    response.end()
    return
  }
  void readFile(CLIENT_FILE, 'utf8').then((body) => {
    response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    response.end(body)
  })
})

await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const { port } = server.address()
const origin = `http://127.0.0.1:${String(port)}`

/** Collect every element in a tree, descending named props as well as children. */
function flatten(node, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, found)
    return found
  }
  found.push(node)
  for (const value of Object.values(node.props ?? {})) flatten(value, found)
  return found
}

/** A hook runtime that re-renders synchronously, as the card expects. */
function createHookRuntime(render) {
  const perComponent = new WeakMap()
  let cursor = 0
  let active
  return {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({
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
      return [state[at], () => {}]
    },
    // `useRef` takes a slot in the same ordered list `useState` uses, because the
    // card calls its hooks unconditionally in a fixed order -- exactly the
    // contract React itself relies on. The render is single-shot here, so the
    // mounted `useEffect` never fires and its cleanup is not simulated.
    useRef: (initial) => {
      const state = perComponent.get(active) ?? []
      perComponent.set(active, state)
      const at = cursor
      state[at] ??= { current: typeof initial === 'function' ? initial() : initial }
      cursor += 1
      return state[at]
    },
    useEffect: () => {},
    beginRender(component) { active = component; cursor = 0 },
  }
}

try {
  const bundled = await fetch(`${origin}/client.js`)
  const source = await bundled.text()

  let registration
  const windowStub = {
    __ModuleLoader__: { load(value) { registration = value } },
    location: { href: origin, reload() {} },
    setTimeout: globalThis.setTimeout,
    confirm: () => true,
    __DSH_POWER_SWITCH_NO_REVIVAL__: true,
  }
  const documentStub = {
    documentElement: { lang: 'zh-CN' },
    baseURI: `${origin}/`,
    head: { appendChild() {} },
    createElement() { return { dataset: {}, textContent: '' } },
    querySelector() { return null },
  }
  // eslint-disable-next-line no-new-func -- evaluating the served artifact is the point
  new Function('window', 'document', source)(windowStub, documentStub)
  if (registration === undefined) throw new Error('the artifact never called __ModuleLoader__.load')

  let runtime
  const reactShim = {
    Fragment: Symbol('Fragment'),
    createElement: (...args) => runtime.createElement(...args),
    useState: (...args) => runtime.useState(...args),
    useRef: (...args) => runtime.useRef(...args),
    useEffect: (...args) => runtime.useEffect(...args),
  }
  const primitives = {
    Button: function Button() { return null },
    Modal: function Modal() { return null },
  }
  const face = registration.factory((specifier) => {
    if (specifier === 'react') return reactShim
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${specifier}`)
  })

  const injected = []
  face.apply({
    locale: { register() {}, bind: () => (key) => key },
    slots: {
      inject(name, register) { injected.push({ name, register }) },
      register(options, render) { return { ...options, render } },
    },
  })
  const options = injected[0].register()

  const render = (view) => {
    const state = { tree: undefined }
    const rerun = () => {
      runtime.beginRender(options.render)
      state.tree = options.render({ view, ...options.inject() })
    }
    runtime = createHookRuntime(rerun)
    rerun()
    return state.tree
  }

  const summary = render('summary')
  const page = flatten(render('page'))

  console.log(`served client.js             : HTTP ${String(bundled.status)}, ${String(source.length)} bytes from ${origin}/client.js`)
  console.log(`factory registration id      : ${String(registration.id)}`)
  console.log(`slot registration            : ${injected[0].name} (id=${String(options.id)}, order=${String(options.order)})`)
  console.log(`label                        : ${String(options.label())}`)
  console.log(`summary view                 : ${String(summary)}`)
  console.log(`page view action button      : ${String(page.some(n => n.props?.['data-dsh-power-action'] === 'shutdown'))}`)
  console.log(`page view confirm button     : ${String(page.some(n => n.props?.['data-dsh-power-confirm'] === 'true'))}`)
  console.log('')
  console.log('RESULT: the artifact served over HTTP registers, applies, and renders both views.')
} finally {
  server.close()
}
