/**
 * Build the host half.
 *
 * The sources are plain ESM JavaScript, so the "build" is the copy that puts
 * them where a profile install resolves them: `lib/index.js` is the package
 * main, and `lib/host.js` is the module it imports next to itself. The browser
 * half is `client.js` at the package root and is shipped verbatim.
 */

import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const from = fileURLToPath(new URL('../src', import.meta.url))
const to = fileURLToPath(new URL('../lib', import.meta.url))

await rm(to, { recursive: true, force: true })
await mkdir(to, { recursive: true })
await cp(from, to, { recursive: true })
console.log(`built ${to} from ${from}`)
void root
