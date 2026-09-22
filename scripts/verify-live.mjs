/**
 * Live verification against a running DSH: fetch the app, find the boot's
 * plugin combo URL, and report whether this package's client bundle is listed
 * plus what the host answers for the shutdown route.
 *
 * Nothing is shut down: the route is probed with a deliberately untrusted
 * request (no Origin), which must be refused BEFORE any exit is scheduled.
 *
 * The Web host authenticates every request, so this needs either the process
 * token from the launch line or a token in the path it is given.
 *
 * Usage: node scripts/verify-live.mjs [origin-with-or-] [bundle-id] [token]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stateDir } from './restart-shared.mjs'

const rawOrigin = process.argv[2] ?? 'http://127.0.0.1:3080'
const bundleId = process.argv[3] ?? 'dsh-power-switch'
const [origin, tokenFromOrigin] = splitToken(rawOrigin)
const token = process.argv[4] ?? tokenFromOrigin ?? tokenFromLog() ?? ''

/** Split a `url?token=...` argument into the bare origin and the token. */
function splitToken(value) {
  const parsed = new URL(value)
  const found = parsed.searchParams.get('token')
  parsed.search = ''
  return [parsed.origin, found]
}

/** The most recent process token the launcher printed, when its log is readable. */
function tokenFromLog() {
  const candidates = []
  try {
    const dir = stateDir()
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('dsh-web') && entry.endsWith('.log')) candidates.push(join(dir, entry))
    }
    candidates.push(join(dir, 'dsh-web.log'))
  } catch {
    // No state directory yet: the TEMP fallback below still applies.
  }
  candidates.push(join(tmpdir(), 'dsh-web.log'))
  for (const path of candidates) {
    try {
      const text = readFileSync(path, 'utf8')
      const found = [...text.matchAll(/https?:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/gu)].pop()
      if (found !== undefined) return found[1]
    } catch {
      // Try the next candidate; absence is an expected outcome here.
    }
  }
  return undefined
}

/** Append the token when one is known and the URL does not already carry one. */
function withToken(url) {
  if (token === '' || url.includes('token=')) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/**
 * The process token is exchanged for a signed cookie on the first root request,
 * and `fetch` has no cookie jar -- so this holds the cookie the exchange set
 * and replays it, which is exactly what the browser does.
 */
let authCookie = undefined

/**
 * Request a URL the way a browser holding the session cookie would.
 * @param url - the absolute URL.
 * @param init - fetch options.
 * @returns the response, with the session cookie captured or replayed.
 */
async function request(url, init = {}) {
  const headers = { ...(init.headers ?? {}) }
  if (authCookie !== undefined && !url.includes('token=')) headers.cookie = authCookie
  const response = await fetch(withToken(url), { cache: 'no-store', redirect: 'manual', ...init, headers })
  if (response.status === 303) {
    const cookie = response.headers.get('set-cookie')
    if (cookie !== null) authCookie = cookie.split(';')[0]
    return await fetch(url, { cache: 'no-store', ...init, headers: authCookie === undefined ? {} : { ...headers, cookie: authCookie } })
  }
  return response
}

/** Fetch the index through the token exchange. */
async function readIndex() {
  const response = await request(origin)
  return { status: response.status, html: await response.text() }
}

/**
 * Every plugin bundle specifier the app preloads.
 * @param html - the served index.
 * @returns the specifiers, in page order.
 */
function bundleSpecifiers(html) {
  const combo = /\/plugins\/\?\?([^"&<]+)/u.exec(html)
  if (combo === null) return []
  return combo[1].split(',').map(entry => entry.trim()).filter(Boolean)
}

/**
 * Fetch one bundle by rewriting the boot's own combo URL.
 *
 * Taking the URL the page was actually given sidesteps reconstructing its
 * revision, which the host regenerates whenever any bundle changes.
 * @param html - the served index.
 * @param specifier - the `<package>/client.js` specifier to fetch.
 * @returns the response status and byte length.
 */
async function probeBundle(html, specifier) {
  // The boot payload's own graph object carries this package's exact URL and
  // revision (`{"id":"<pkg>","url":"/plugins/??<pkg>/client.js&rev=<session>-<n>"}`).
  // Reading it is exact; reconstructing the revision would be guesswork.
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const id = specifier.replace(/\/client\.js$/u, '')
  const graphUrl = new RegExp(`"id":"${id}"[^}]*?"url":"([^"]+)"`, 'u').exec(html)?.[1]
    ?? new RegExp(`"url":"([^"]*${escaped}[^"]*)"`, 'u').exec(html)?.[1]
    ?? /(?:src|href)="(\/plugins\/\?\?[^"]+)"/u.exec(html)?.[1]
  if (graphUrl === undefined) return { status: 0, bytes: 0, url: '(no bundle URL in the boot payload)' }
  const path = graphUrl.replaceAll('&amp;', '&').replaceAll('\\/', '/')
  const url = path.startsWith('/') ? `${origin}${path}` : path
  const response = await fetch(url, { cache: 'no-store' })
  const body = await response.text()
  return { status: response.status, bytes: body.length, url }
}

/**
 * Probe the shutdown route the way an untrusted page would.
 * @returns the status and body, which must be a refusal.
 */
async function probeRoute() {
  const response = await request(`${origin}/api/dsh-power-switch/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return { status: response.status, body: await response.text() }
}

const index = await readIndex()
const specifiers = bundleSpecifiers(index.html)
const mine = specifiers.filter(specifier => specifier.includes(bundleId))
const reference = specifiers.find(specifier => specifier.includes('dsh-client-ui-settings-plugins'))

console.log(`index                        : HTTP ${String(index.status)}, ${String(index.html.length)} bytes`)
console.log(`plugin bundles in the boot   : ${String(specifiers.length)}`)
console.log(`this package in the boot     : ${mine.length > 0 ? mine.join(', ') : 'ABSENT'}`)
if (reference !== undefined) {
  const probed = await probeBundle(index.html, reference)
  console.log(`bundle route sanity check    : HTTP ${String(probed.status)}, ${String(probed.bytes)} bytes (${reference})`)
}
if (mine.length > 0) {
  const probed = await probeBundle(index.html, mine[0])
  console.log(`this bundle fetch            : HTTP ${String(probed.status)}, ${String(probed.bytes)} bytes`)
}
const route = await probeRoute()
console.log(`untrusted route probe        : HTTP ${String(route.status)} ${route.body.trim()}`)
console.log('')
console.log(mine.length > 0
  ? 'RESULT: the plugin client bundle is being served by this host. Refresh the page and open Settings -> Plugins.'
  : 'RESULT: the plugin is not mounted in this profile yet (no bundle in the boot payload).')
