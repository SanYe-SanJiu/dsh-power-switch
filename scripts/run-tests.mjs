/**
 * Run every test file in one process.
 *
 * Node's own test runner spawns a child per file when given several files, and
 * a sandboxed environment cannot open the pipes that needs. Importing the files
 * in the main process runs the same suites without the child processes.
 *
 * The list is DISCOVERED, not spelled out: a hand-written list means a suite
 * added later is silently never run -- which is how a suite stayed broken here
 * without anybody noticing.
 */

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests')
const suites = readdirSync(testsDir)
  .filter((entry) => entry.endsWith('.test.mjs'))
  .sort()

if (suites.length === 0) throw new Error(`no *.test.mjs suites found in ${testsDir}`)

for (const suite of suites) {
  process.stdout.write(`# ${suite}\n`)
  await import(pathToFileURL(join(testsDir, suite)).href)
}
