/**
 * Artifact and layout tests for the power-switch host half.
 *
 * Loads the built artifact the way a profile loader does -- by path -- so a
 * broken `lib/` layout or a stray source-only import fails here rather than in
 * someone's running harness.
 */

import { strict as assert } from 'node:assert'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)

/** Resolve a package-relative path for filesystem reads. */
const at = (relative) => fileURLToPath(new URL(relative, ROOT))

/** Resolve a package-relative URL for dynamic import. */
const url = (relative) => new URL(relative, ROOT)

describe('built package layout', () => {
  it('declares the main and client entry points it ships', async () => {
    const manifest = JSON.parse(await readFile(at('package.json'), 'utf8'))
    assert.equal(manifest.name, 'dsh-power-switch')
    assert.equal(manifest.main, './lib/index.js')
    assert.equal(manifest.exports['./client'], './client.js')
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(manifest.dsh.client.platform, 'web')
    for (const file of manifest.files) {
      await access(at(file))
    }
  })

  it('imports the built host half by the path the loader will use', async () => {
    const built = await import(url('lib/index.js'))
    assert.equal(built.name, 'dsh-power-switch')
    assert.deepEqual(built.inject, ['webServer'])
    assert.equal(typeof built.apply, 'function')
  })

  it('keeps the built half identical to the source it was built from', async () => {
    for (const file of ['index.js', 'host.js']) {
      const source = await readFile(at(`src/${file}`), 'utf8')
      const built = await readFile(at(`lib/${file}`), 'utf8')
      assert.equal(built, source, `${file} is stale; run the build`)
    }
  })

  it('routes the host half to a module that exists beside it', async () => {
    const built = await readFile(at('lib/index.js'), 'utf8')
    assert.match(built, /from '\.\/host\.js'/)
    await access(at('lib/host.js'))
  })

  it('ships a bundle patch that inserts exactly this package once', async () => {
    const patch = await readFile(at('cordis.patch.yml'), 'utf8')
    const names = [...patch.matchAll(/name:\s*(\S+)/gu)].map((match) => match[1])
    assert.deepEqual(names, ['dsh-power-switch'])
  })

  it('ships a client artifact in the loader registration shape', async () => {
    const client = await readFile(at('client.js'), 'utf8')
    assert.match(client, /window\.__ModuleLoader__\.load\(/)
    assert.match(client, /id: 'dsh-power-switch'/)
    assert.match(client, /factory: \(require\) =>/)
    assert.match(client, /require\('react'\)/)
    assert.match(client, /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/)
  })
})

/**
 * The relaunch supervisor is BUILT AS A STRING and run with `node -e`, so a
 * mistake inside `supervisorSource()` is invisible to every other check here:
 * `node --check` on the helper only ever sees a valid file, because the broken
 * code sits inside a template literal. That is not hypothetical. Two functions
 * called from a scope that never defined them, and a stray backtick in a comment,
 * each reached a running machine from exactly this blind spot.
 *
 * So these assertions do what the shell cannot: they compile and call the
 * generator, then inspect the text it produces.
 */
describe('generated relaunch supervisor', () => {
  /**
   * The free variables the template interpolates, in the order it uses them.
   *
   * Adding an interpolation to `supervisorSource()` means adding it here; the
   * failure if you forget names the missing identifier.
   */
  const PARAMS = ['boot', 'port', 'logFile', 'hostLogCandidates', 'handshakePath', 'sharedUrl', 'settingsFile']

  /** Pull `function supervisorSource() { ... }` out by counting braces. */
  const extract = (text) => {
    const start = text.indexOf('function supervisorSource() {')
    assert.notEqual(start, -1, 'restart-from-inside.mjs no longer defines supervisorSource()')
    let depth = 0
    for (let at = text.indexOf('{', start); at < text.length; at += 1) {
      if (text[at] === '{') depth += 1
      else if (text[at] === '}') {
        depth -= 1
        if (depth === 0) return text.slice(start, at + 1)
      }
    }
    throw new Error('unbalanced braces in supervisorSource()')
  }

  /** Build the supervisor source the helper would hand to `node -e`. */
  const build = async () => {
    const helper = await readFile(at('scripts/restart-from-inside.mjs'), 'utf8')
    const body = extract(helper)
    let make
    try {
      make = new Function(...PARAMS, `${body}\nreturn supervisorSource()`)
    } catch (error) {
      // A stray backtick inside the template lands here: it truncates the string
      // and leaves the rest of the module as bare syntax.
      throw new Error(`the generated supervisor does not compile: ${error.message}`)
    }
    try {
      return make(
        { execPath: 'C:\\nodejs\\node.exe', args: ['C:\\pkg\\bin.js', 'web', '--no-open'], cwd: 'D:\\checkout' },
        3080, 'G:\\pkg\\restart-dsh.log', ['G:\\repo\\dsh-web.log'],
        'G:\\pkg\\restart-handshake.txt', new URL('scripts/restart-shared.mjs', ROOT).href, 'C:\\settings.yaml',
      )
    } catch (error) {
      throw new Error(`supervisorSource() needs a parameter PARAMS does not list: ${error.message}`)
    }
  }

  it('generates a complete script, not a truncated one', async () => {
    const generated = await build()
    assert.match(generated, /checked in; my job is to bring the service back/)
    assert.match(generated, /restart complete/)
    assert.match(generated, /process\.exit\(0\)/)
  })

  it('reports its own crashes, since its stdio is ignored', async () => {
    const generated = await build()
    assert.match(generated, /process\.on\('uncaughtException'/)
    assert.match(generated, /process\.on\('unhandledRejection'/)
  })

  it('imports the window-mode helpers instead of assuming they are in scope', async () => {
    const generated = await build()
    assert.match(generated, /const \{ resolveLaunchMode, openWindow, redactToken \} = await import\(/)
    const shared = await import(url('scripts/restart-shared.mjs'))
    assert.equal(typeof shared.resolveLaunchMode, 'function')
    assert.equal(typeof shared.storedLaunchMode, 'function')
    assert.equal(typeof shared.findBrowser, 'function')
    assert.equal(typeof shared.openWindow, 'function')
    assert.equal(typeof shared.redactToken, 'function')
  })

  it('reads the launch mode through the shared resolver, never the settings document alone', async () => {
    // DSH 0.1.7 imports `settings.yaml` into the profile once and renames it, so a
    // reader that knows only that file answers nothing afterwards -- and a stored
    // "app" silently becomes a tab. Both outside readers take the resolver, which
    // falls back to the plugin's own record.
    for (const file of ['scripts/launch-dsh.mjs', 'scripts/restart-from-inside.mjs']) {
      const text = await readFile(at(file), 'utf8')
      assert.match(text, /resolveLaunchMode\(/, `${file} must fall back to the plugin's own record`)
      assert.doesNotMatch(text, /= storedLaunchMode\(/, `${file} must not read only the settings document`)
    }
  })

  it('does not re-implement the window decision it shares with the other entry points', async () => {
    const generated = await build()
    // The app-window spawn form belongs to restart-shared.mjs alone. If it
    // reappears anywhere else then the switch path, the manual restart and the
    // desktop launch can drift apart -- and "app mode works there but not here"
    // is exactly the complaint that prompted sharing this decision.
    assert.doesNotMatch(generated, /--app=/)
    for (const file of ['scripts/launch-dsh.mjs', 'scripts/restart-dsh-web.mjs', 'scripts/restart-from-inside.mjs']) {
      assert.doesNotMatch(await readFile(at(file), 'utf8'), /--app=/, `${file} must defer to restart-shared.mjs`)
    }
    const shared = await readFile(at('scripts/restart-shared.mjs'), 'utf8')
    // The window is opened on the plugin's own hand-over page, which fills the work
    // area as its FIRST action and then replaces itself with the authenticated URL.
    // Measured: that arrives already filled (the window was at the filled size by the
    // first sample, 165 ms after launch), where resizing from inside DSH's boot
    // flashed the half-width window for as long as the app took to render.
    assert.match(shared, /\[`--app=\$\{appWindowUrl\(url\)\}`/)
    assert.match(shared, /export function appWindowUrl\(url\)/)
    assert.match(shared, /const APP_WINDOW_ROUTE = '\/api\/dsh-power-switch\/app-window'/)
    // The marker both halves know: the hand-over page adds it, the app reads it and
    // tries again if the browser refused the first resize.
    assert.match(shared, /export const APP_WINDOW_HASH = '#dsh-power-switch-app'/)
    const host = await readFile(at('src/host.js'), 'utf8')
    assert.match(host, /export const APP_WINDOW_ROUTE = '\/api\/dsh-power-switch\/app-window'/)
    assert.match(host, /export const APP_WINDOW_HASH = '#dsh-power-switch-app'/)
    assert.match(host, /export function createAppWindowHandler\(\)/)
    assert.match(host, /window\.resizeTo\(window\.screen\.availWidth, window\.screen\.availHeight\)/)
    const client = await readFile(at('client.js'), 'utf8')
    assert.match(client, /const APP_WINDOW_HASH = '#dsh-power-switch-app'/, 'the page must know the marker the launcher sets')
    assert.match(client, /String\(window\.location\?\.hash \?\? ''\)\.includes\(APP_WINDOW_HASH\)/)
    assert.match(client, /window\.resizeTo\(width, height\)/)
  })

  it('gives the desktop launcher the same shared decision', async () => {
    const launcher = await readFile(at('scripts/launch-dsh.mjs'), 'utf8')
    // The launcher imports several helpers now; what matters is that it TAKES the
    // shared window decision instead of re-implementing it.
    assert.match(launcher, /import \{[\s\S]*?\bopenWindow\b[\s\S]*?\} from '\.\/restart-shared\.mjs'/)
    // A launcher that starts a second host on an occupied port is worse than one
    // that refuses, so the refusal has to be there.
    assert.match(launcher, /answers but no live token URL was found/)
  })

  /**
   * A cold start must never ASSUME the port it will serve on.
   *
   * Measured failure this replaces: the launcher scoped both its probe and its
   * wait for the host's token line to `DSH_POWER_SWITCH_PORT ?? 3080`. The
   * restart helper is handed the live host's port (`restartHelperEnv`), but the
   * launcher is started by Explorer and inherits no such fact -- so on a machine
   * whose DSH serves on another port, switching to app mode worked while the
   * desktop shortcut started the host and then waited 120 s for a line that
   * could never appear, i.e. a shortcut that "does nothing".
   */
  it('reads the port back from what the host recorded, and waits on ANY port', async () => {
    const shared = await import(url('scripts/restart-shared.mjs'))
    // Unscoped accepts every loopback port; scoped still honours an instruction.
    assert.equal(shared.tokenUrlPattern().test('http://127.0.0.1:4000/?token=aa_BB-1'), true)
    assert.equal(shared.tokenUrlPattern(4000).test('http://127.0.0.1:4000/?token=aa_BB-1'), true)
    assert.equal(shared.tokenUrlPattern(3080).test('http://127.0.0.1:4000/?token=aa_BB-1'), false)
    // The port of the host's own record, and of the recorded command line.
    assert.equal(shared.portFromTokenUrl('http://127.0.0.1:4173/?token=x'), 4173)
    assert.equal(shared.portFromTokenUrl('http://127.0.0.1/?token=x'), null)
    assert.equal(shared.portFromTokenUrl('https://example.com:9/?token=x'), null)
    assert.equal(shared.portFromArguments(['web', '--port', '4100']), 4100)
    assert.equal(shared.portFromArguments(['web', '--port=4200']), 4200)
    assert.equal(shared.portFromArguments(['web', '-p', '4300']), 4300)
    assert.equal(shared.portFromArguments(['web']), null)
    // Precedence: an explicit instruction, then the port the last host served on,
    // then the port the replayed command line asks for, then the default.
    assert.equal(
      shared.resolveProbePort({ explicit: 3000, recordedUrl: 'http://127.0.0.1:4173/?token=x', bootArgs: ['web', '--port', '4100'] }).port,
      3000,
    )
    assert.equal(shared.resolveProbePort({ recordedUrl: 'http://127.0.0.1:4173/?token=x' }).port, 4173)
    assert.equal(shared.resolveProbePort({ bootArgs: ['web', '--port', '4100'] }).port, 4100)
    assert.equal(shared.resolveProbePort({}).port, 3080)
  })

  it('derives that port in the launcher instead of defaulting to 3080 there', async () => {
    const launcher = await readFile(at('scripts/launch-dsh.mjs'), 'utf8')
    assert.match(launcher, /tokenUrlPattern\(\)/)
    assert.match(launcher, /resolveProbePort\(/)
    // A literal port in this file IS the bug: nothing hands this process a port.
    assert.doesNotMatch(launcher, /3080/)
    // And the wait only ever reads what THIS run appended to the host log.
    assert.match(launcher, /waitForToken\(hostLog, 120_000, from\)/)
    assert.match(launcher, /from = statSync\(hostLog\)\.size/)
  })

  it('derives that port in the restart helper too, instead of defaulting to 3080', async () => {
    const helper = await readFile(at('scripts/restart-from-inside.mjs'), 'utf8')
    assert.match(helper, /resolveProbePort\(/)
    // The old form was `process.env.DSH_POWER_SWITCH_PORT ?? 3080`. The host can
    // legitimately fail to pass the port -- it is recorded inside an async
    // callback that polls the Web server for up to 10 s -- and then a default of
    // 3080 makes the helper look for a host that is not there.
    assert.doesNotMatch(helper, /DSH_POWER_SWITCH_PORT \?\? 3080/)
    // It also states which port it used: otherwise "wrong port" and "no host
    // running" are the same refusal in the log.
    assert.match(helper, /log\(`port \$\{String\(port\)\} \(\$\{probe\.source\}\)`\)/)
  })

  it('never writes the token into a log a person may share', async () => {
    const shared = await import(url('scripts/restart-shared.mjs'))
    assert.equal(shared.redactToken('http://127.0.0.1:3080/?token=abc_DEF-123'), 'http://127.0.0.1:3080/?token=***')
    assert.equal(shared.redactToken('a http://127.0.0.1:9/?x=1&token=zzz b'), 'a http://127.0.0.1:9/?x=1&token=*** b')
    // Text without a token is returned untouched, so a diagnostic stays readable.
    assert.equal(shared.redactToken('no url here'), 'no url here')
    // Every entry point that logs a URL, or dumps the host log tail that contains
    // one, goes through it. The launcher matters most: a shortcut runs it through
    // a wrapper that redirects stdout into %TEMP%, so one raw line put the token
    // in a second place nobody thinks of as a secret store.
    for (const file of ['scripts/launch-dsh.mjs', 'scripts/restart-dsh-web.mjs', 'scripts/restart-from-inside.mjs']) {
      const text = await readFile(at(file), 'utf8')
      assert.match(text, /redactToken/, `${file} must redact token URLs in its diagnostics`)
      assert.doesNotMatch(text, /log\(`dsh web: \$\{url\}`\)/, `${file} must not log a raw token URL`)
      assert.doesNotMatch(text, /log\('dsh web: ' \+ url\)/, `${file} must not log a raw token URL`)
    }
  })

  it('marks the host that a deliberate opener started, so no second window appears', async () => {
    // Three processes open this boot's window on purpose. Each must tell the host
    // half that the job is taken: without the marker the plugin opens ANOTHER
    // window on that path, which is how "one switch" becomes two windows.
    for (const file of ['scripts/launch-dsh.mjs', 'scripts/restart-dsh-web.mjs', 'scripts/restart-from-inside.mjs']) {
      assert.match(await readFile(at(file), 'utf8'), /DSH_POWER_SWITCH_WINDOW_HANDLED/, `${file} must mark the host it starts`)
    }
    const host = await readFile(at('src/host.js'), 'utf8')
    assert.match(host, /WINDOW_HANDLED_ENV = 'DSH_POWER_SWITCH_WINDOW_HANDLED'/)
  })

  it('resolves the helpers before it checks in, so a broken module cannot take the host down', async () => {
    const generated = await build()
    const imported = generated.indexOf('await import(')
    const checkedIn = generated.indexOf("appendFileSync(handshake")
    assert.notEqual(imported, -1)
    assert.notEqual(checkedIn, -1)
    assert.ok(imported < checkedIn, 'the handshake must not be written before the helper module resolves')
  })

  it('proves a host log is writable before it checks in', async () => {
    const generated = await build()
    // The check-in is the promise that lets the host exit, and the replacement's
    // stdout needs a file. Opening that file only after checking in is the audit's
    // "the switch kills the service" path: the host is gone, and the supervisor
    // then gives up on an unopenable log with nobody left to bring it back.
    const probed = generated.indexOf('const logProbe = openHostLog()')
    const checkedIn = generated.indexOf("appendFileSync(handshake")
    assert.notEqual(probed, -1, 'the supervisor must probe for an openable host log')
    assert.notEqual(checkedIn, -1)
    assert.ok(probed < checkedIn, 'a check-in promises a replacement, so it must have somewhere to write first')
    // The probe needs a HOISTED declaration: a `const` arrow is in its temporal
    // dead zone at that call site, which would turn the new guard into a crash.
    assert.match(generated, /function openHostLog\(\)/)
  })

  it('reads the launch mode from the settings document it was pointed at', async () => {
    const shared = await import(url('scripts/restart-shared.mjs'))
    // Another namespace declares its own launchMode FIRST in this fixture, so a
    // key-name match would answer 'tab' here and silently switch the wrong way.
    assert.equal(shared.storedLaunchMode(at('tests/fixtures/settings-app.yaml')), 'app')
    // Same shape, but this plugin has no block: the answer is "no opinion".
    assert.equal(shared.storedLaunchMode(at('tests/fixtures/settings-other.yaml')), null)
    // A missing document is also "no opinion", not a crash. The name below is
    // deliberately one that does not exist — do NOT "fix" this by creating it.
    assert.equal(shared.storedLaunchMode(at('tests/fixtures/settings-absent-on-purpose.yaml')), null)
  })

  /**
   * The plugin's own mode record, which is what keeps a cold start honest on a
   * host with no settings document.
   *
   * DSH 0.1.7 retired `settings.yaml`: it is imported into the active profile
   * once and renamed, so a reader that knows only that file answers nothing and a
   * stored "app" silently opens a tab on the next launch. The plugin writes its
   * own record, and every outside reader prefers an explicit document over it.
   */
  it('records the launch mode itself, and lets an explicit document win', async () => {
    const shared = await import(url('scripts/restart-shared.mjs'))
    const home = await mkdtemp(join(tmpdir(), 'dpb-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      assert.equal(shared.readRecordedLaunchMode(), null, 'nothing recorded yet')
      const file = shared.writeRecordedLaunchMode('app')
      assert.match(file, /storages[/\\]dsh-power-switch[/\\]launch-mode\.txt$/u)
      assert.equal(await readFile(file, 'utf8'), 'app\n')
      assert.equal(shared.readRecordedLaunchMode(), 'app')
      // Anything that is not a mode is not a mode.
      await writeFile(file, 'kiosk\n', 'utf8')
      assert.equal(shared.readRecordedLaunchMode(), null)
      // A document with an opinion wins; the record answers when there is none.
      await writeFile(file, 'app\n', 'utf8')
      await writeFile(shared.settingsPath(), 'dsh-power-switch:\n  launchMode: tab\n', 'utf8')
      assert.equal(shared.resolveLaunchMode(), 'tab')
      await rm(shared.settingsPath(), { force: true })
      assert.equal(shared.resolveLaunchMode(), 'app')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })

  it('records the advanced settings itself, and ignores what it cannot validate', async () => {
    const shared = await import(url('scripts/restart-shared.mjs'))
    const home = await mkdtemp(join(tmpdir(), 'dpb-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      assert.deepEqual(shared.readRecordedSettings(), {}, 'nothing recorded yet')
      assert.match(shared.recordedSettingsPath(), /storages[/\\]dsh-power-switch[/\\]settings\.json$/u)
      shared.writeRecordedSettings({ delayMs: 1500 })
      assert.deepEqual(shared.readRecordedSettings(), { delayMs: 1500 })
      // A patch MERGES: the card sends one field per save, not the whole form.
      shared.writeRecordedSettings({ hard: true })
      assert.deepEqual(shared.readRecordedSettings(), { delayMs: 1500, hard: true })
      // The file sits under the user's home, so a hand-edited one must degrade
      // field by field rather than feed a bad number into an exit.
      await writeFile(shared.recordedSettingsPath(), '{"delayMs":"soon","exitCode":7}', 'utf8')
      assert.deepEqual(shared.readRecordedSettings(), { exitCode: 7 })
      await writeFile(shared.recordedSettingsPath(), 'not json at all', 'utf8')
      assert.deepEqual(shared.readRecordedSettings(), {})
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })

  it('writes that record from the host half, and speaks both settings models', async () => {
    const host = await readFile(at('src/index.js'), 'utf8')
    // Written when the choice is made, mirrored whenever the store publishes, and
    // seeded once so a host without a settings document still has an answer.
    assert.match(host, /writeRecordedLaunchMode\(mode\)/)
    assert.match(host, /writeRecordedLaunchMode\(next\.launchMode\)/)
    assert.match(host, /readRecordedLaunchMode\(\) === null/)
    // …but the mirror is FLAGGED, because one publish is nobody's choice: the
    // no-generated-form fallback sends the raw loader row, and mirroring that one
    // overwrote the mode the card had just recorded at every host start. That publish
    // also ADOPTS the record, so the host's own report of the next launch agrees with
    // the launcher and the supervisor instead of showing the row default.
    assert.match(host, /const publishFromStore = \(next, mirrors = true\) => \{/)
    assert.match(host, /if \(mirrors !== true\) return/)
    assert.match(host, /publish\(recorded === null \? fallback : \{ \.\.\.fallback, launchMode: recorded \}, false\)/)
    // Both models: registered namespaces (0.1.6) and generated forms (0.1.7).
    assert.match(host, /typeof settings\.register !== 'function'/)
    assert.match(host, /function installGeneratedForm/)
    assert.match(host, /settings\.update\(row\.ns, patch\)/)
    // The advanced settings travel the same way, and outrank the row config.
    assert.match(host, /writeRecordedSettings\(patch\)/)
    assert.match(host, /const applyRecorded = \(base\) => resolveConfig\(\{ \.\.\.\(base \?\? \{\}\), \.\.\.readRecordedSettings\(\) \}\)/)
    assert.match(host, /path: SETTINGS_ROUTE/u)
  })

  /**
   * The host's own URL record, which is what the switch broke on.
   *
   * Measured failure: the helper looked for the live host's token URL in the
   * logs only, and a machine whose launcher writes that log elsewhere produced
   * `no host token URL in any log` — the mode was saved and the shortcut
   * adopted, then the restart was refused. The host now writes the URL it minted
   * for its own run, into the state directory rather than the package.
   */
  it('records the live URL under the harness home, and refuses anything else', async () => {
    const shared = await import(url('scripts/restart-shared.mjs'))
    const home = await mkdtemp(join(tmpdir(), 'dpb-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      assert.equal(shared.readRecordedTokenUrl(), null, 'nothing recorded yet')
      const file = shared.writeRecordedTokenUrl('http://127.0.0.1:3080/?token=abc_DEF-123')
      assert.equal(shared.readRecordedTokenUrl(), 'http://127.0.0.1:3080/?token=abc_DEF-123')
      assert.match(file, /storages[/\\]dsh-power-switch[/\\]token-url\.txt$/u)
      assert.ok(!file.startsWith(at('.')), 'the record must not live inside the package')
      // A recorded file that is not a token URL must not be handed to a probe.
      await writeFile(file, 'http://127.0.0.1:3080/\n', 'utf8')
      assert.equal(shared.readRecordedTokenUrl(), null)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })

  /**
   * The interpreter record the two `.vbs` wrappers read.
   *
   * They cannot parse JSON and must not assume `%ProgramFiles%\nodejs\node.exe`:
   * nvm-windows, fnm, volta and Store installs have no such file, and a bare
   * `node.exe` needs a PATH a shortcut's environment may not carry. One line of
   * text is what VBScript can read.
   */
  it('records the node interpreter as a single readable line', async () => {
    const shared = await import(url('scripts/restart-shared.mjs'))
    const home = await mkdtemp(join(tmpdir(), 'dpb-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const file = shared.writeNodePath('C:\\Tools\\nvm\\v22.3.0\\node.exe')
      assert.match(file, /storages[/\\]dsh-power-switch[/\\]node-path\.txt$/u)
      const text = await readFile(file, 'utf8')
      assert.equal(text, 'C:\\Tools\\nvm\\v22.3.0\\node.exe\n')
      // The wrappers build the same path from the environment.
      assert.equal(file, join(home, 'storages', 'dsh-power-switch', 'node-path.txt'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })
})

/**
 * Browser discovery decides whether app mode is possible at all.
 *
 * The measured trap: Chrome or Edge installed WITHOUT admin lives under
 * `%LOCALAPPDATA%`, so a search that only knew `%ProgramFiles%` found nothing on
 * exactly those machines and silently fell back to a tab.
 */
describe('browser discovery', () => {
  it('looks in the per-user install root before the machine-wide ones', async () => {
    const shared = await import(url('scripts/restart-shared.mjs'))
    const env = {
      LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    }
    const candidates = shared.browserCandidates(env)
    assert.ok(candidates.length >= 4)
    assert.equal(candidates[0], 'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
    assert.ok(candidates.includes('C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'))
    assert.ok(candidates.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'))
    // A candidate that does not exist must not be picked.
    const found = shared.findBrowser((path) => path.includes('AppData'), env)
    assert.match(found, /AppData/u)
    assert.equal(shared.findBrowser(() => false, env), undefined)
  })
})

/**
 * The shortcut the card offers to place is the piece that makes the stored mode
 * govern a cold start, and it must be REVERSIBLE, so the two halves have to agree
 * exactly: what the host passes as arguments, and what the helper reads.
 */
describe('desktop shortcut placement', () => {
  it('ships a helper that stays ASCII-only, because wscript reads it as ANSI', async () => {
    const helper = await readFile(at('scripts/make-shortcut.vbs'), 'utf8')
    // Every piece of text the shortcut shows arrives as an ARGUMENT (wscript reads
    // those as UTF-16). Text written into this file instead would be decoded as
    // ANSI and land on the desktop as mojibake.
    // eslint-disable-next-line no-control-regex -- ASCII-ness is exactly the claim
    assert.doesNotMatch(helper, /[^\u0000-\u007F]/u, 'make-shortcut.vbs must stay ASCII-only')
    assert.match(helper, /WScript\.Arguments\.Count < 7/)
    // A redirected Desktop is common, and a shortcut in the wrong folder is
    // invisible -- so the shell must be the one asked.
    assert.match(helper, /SpecialFolders\("Desktop"\)/)
  })

  it('can check before it changes anything, and can put the original back', async () => {
    const helper = await readFile(at('scripts/make-shortcut.vbs'), 'utf8')
    // The four mechanical operations, and the backup that makes restoring possible.
    assert.match(helper, /If action = "scan" Then WScript\.Quit DoScan\(\)/)
    assert.match(helper, /If action = "apply" Then WScript\.Quit DoApply\(\)/)
    assert.match(helper, /If action = "create" Then WScript\.Quit DoCreate\(\)/)
    assert.match(helper, /If action = "restore" Then WScript\.Quit DoRestore\(\)/)
    assert.match(helper, /WriteBackup\("adopted"/)
    assert.match(helper, /WriteBackup\("created"/)
    // Adopting must record the ORIGINAL first, or restore has nothing to replay.
    assert.ok(helper.indexOf('WriteBackup("adopted"') < helper.indexOf('ApplyOurs(targetLnk)'), 'the original must be recorded before it is overwritten')
  })

  it('leaves the "which icon is DSH" decision to the testable half', async () => {
    const helper = await readFile(at('scripts/make-shortcut.vbs'), 'utf8')
    // A classifier inside a .vbs cannot be unit-tested, and the one that lived here
    // missed a real desktop shortcut. It now lives in host.js, where it is covered
    // by classifyShortcut's own tests.
    assert.doesNotMatch(helper, /LooksLikeDsh|IsOurs\(/)
    const pure = await readFile(at('src/host.js'), 'utf8')
    assert.match(pure, /export function classifyShortcut\(/)
    assert.match(pure, /export function chooseShortcutAction\(/)
    // The Electron desktop app must stay out of reach: it is a different product.
    assert.match(pure, /haystack\.includes\('desktop-host'\) \|\| haystack\.includes\('electron'\)/)
    assert.match(pure, /Refuse rather than guess/)
  })

  it('keeps the exit codes the host turns into a message', async () => {
    const helper = await readFile(at('scripts/make-shortcut.vbs'), 'utf8')
    // 1 and 3 come from the main script; the rest are RETURNED by the action
    // functions, so asserting `WScript.Quit N` for all of them would be wrong.
    assert.match(helper, /WScript\.Quit 1/)
    assert.match(helper, /WScript\.Quit 3/)
    for (const line of ['DoApply = 2', 'DoApply = 4', 'DoCreate = 2', 'DoCreate = 4', 'DoRestore = 4', 'DoRestore = 6']) {
      assert.ok(helper.includes(line), `the helper must still return ${line}`)
    }
    // The mapping itself is documented where a reader will look for it.
    assert.match(helper, /Exit codes: 0 fine, 1 bad arguments, 2 launcher missing, 3 no Desktop,/)
  })

  it('receives the arguments in the order the helper reads them', async () => {
    const host = await readFile(at('src/index.js'), 'utf8')
    assert.match(host, /'\/\/nologo', helper, action, launcher, dshHome\(\), shortcutBackup\(\), shortcutResult\(\), SHORTCUT_NAME, SHORTCUT_DESCRIPTION/)
    // The harness home is one of them, because a shortcut that does not carry it
    // is at the mercy of whatever environment Explorer happens to hold.
    assert.match(host, /\bdshHome\b/)
    // The shortcut to adopt rides as an extra argument, because the helper decides
    // nothing by itself.
    assert.match(host, /if \(targetLnk !== undefined\) args\.push\(targetLnk\)/)
    // A piped child is the thing that fails inside a sandboxed host, so the
    // verdict rides on the exit code and a result FILE instead.
    assert.match(host, /stdio: 'ignore'/)
    assert.match(host, /cscript\.exe/)
    // Both files carry a desktop path, so both must be read as UTF-16.
    assert.match(host, /readFileSync\(shortcutResult\(\), 'utf16le'\)/)
    assert.match(host, /readFileSync\(shortcutBackup\(\), 'utf16le'\)/)
  })

  it('points the adopted icon at a copy of the launcher, not at the package', async () => {
    // The package can be removed; the shortcut cannot. What the helper is told to
    // write into the .lnk is therefore the host's own copy in the state directory,
    // and the packaged wrapper is reached through it.
    const host = await readFile(at('src/index.js'), 'utf8')
    assert.match(host, /const launcher = shortcutLauncher\(\)/)
    assert.match(host, /const shortcutLauncher = \(\) => join\(ensureStateDir\(\), 'shortcut-launch\.vbs'\)/)
    assert.doesNotMatch(host, /const launcher = join\(WORKSPACE_ROOT, 'scripts', 'launch-dsh\.vbs'\)/)
    // What the copy must NOT be handed is a recorded path back into this package:
    // `dsh plugin remove` deletes the profile entry, not a `link:` checkout, so a
    // recorded path would keep the shortcut launching a plugin that is gone while the
    // original never came back. A stale record from that build is deleted here.
    assert.doesNotMatch(host, /writeFileSync\(join\(state, 'launcher-path\.txt'\)/)
    assert.match(host, /rmSync\(join\(state, 'launcher-path\.txt'\), \{ force: true \}\)/)
    // An icon adopted by an earlier version points INSIDE the package. Booting has
    // to move it onto the copy without waiting for the card to be touched.
    assert.match(host, /const owned = recordedShortcut\(\)/)
    assert.match(host, /callShortcutHelper\('apply', owned\)/)
  })

  it('ships a launcher copy that survives the package it came from', async () => {
    const vbs = await readFile(at('scripts/shortcut-launch.vbs'), 'utf8')
    // eslint-disable-next-line no-control-regex -- ASCII-ness is exactly the claim
    assert.doesNotMatch(vbs, /[^\u0000-\u007F]/u, 'shortcut-launch.vbs must stay ASCII-only')
    // Installed: the PROFILE is the authority -- `dsh plugin remove` deletes exactly
    // that entry -- and the launch is handed over with this launch's own arguments
    // and exit code.
    assert.match(vbs, /node_modules\\dsh-power-switch\\scripts\\launch-dsh\.vbs/)
    assert.doesNotMatch(vbs, /launcher-path\.txt/, 'a recorded path is not an install check')
    assert.match(vbs, /shell\.Run\(q & HostExe\(\) & q & " " & q & launcher & q & childArgs, 0, True\)/)
    assert.match(vbs, /WScript\.Quit exitCode/)
    // Gone: the record beside it is replayed by the repair script, quietly, and the
    // person is told what happened in ONE dialog.
    assert.match(vbs, /restore-shortcut\.vbs"\)/)
    assert.match(vbs, /shell\.Run\(q & HostExe\(\) & q & " " & q & restore & q & " \/quiet", 0, True\)/)
    assert.match(vbs, /original launch method has been put back/)
    // The wrapper's own home rule, so a shortcut started from Explorer and one
    // started from a shell resolve the same state directory.
    assert.match(vbs, /%DSH_HOME%/)
    assert.match(vbs, /--home/)
  })

  it('lets the repair script be asked to stay quiet', async () => {
    // `shortcut-launch.vbs` runs it after finding the package gone, and reports the
    // result itself; two dialogs for one event is one too many -- and a dialog a
    // hidden launch cannot dismiss would hang the shortcut instead of explaining it.
    const vbs = await readFile(at('scripts/restore-shortcut.vbs'), 'utf8')
    assert.match(vbs, /If LCase\(WScript\.Arguments\(i\)\) = "\/quiet" Then quiet = True/)
    assert.match(vbs, /Sub Report\(text, style\)/)
    assert.match(vbs, /If quiet = True Then Exit Sub/)
    // Every report goes through it -- an early exit that called MsgBox directly is
    // exactly the dialog that would hang a launch nobody is watching.
    assert.doesNotMatch(vbs, /^\s*MsgBox (?!text, style)/mu)
    assert.match(vbs, /^\s*MsgBox text, style, "dsh-power-switch"$/mu)
  })

  it('asks for its dialog text instead of carrying it, because wscript reads ANSI', async () => {
    // Chinese written into a `.vbs` arrives on screen as mojibake; reading the script
    // as UTF-16 instead would make it a binary blob in the repository. So the text
    // comes from the file the host writes beside the copy, and the English compiled
    // into each call site is the fallback.
    for (const name of ['scripts/shortcut-launch.vbs', 'scripts/restore-shortcut.vbs']) {
      const vbs = await readFile(at(name), 'utf8')
      assert.match(vbs, /Function Msg\(key, fallback\)/, `${name} must look its text up`)
      assert.match(vbs, /Sub LoadMessages\(\)/)
      assert.match(vbs, /shortcut-messages\.txt/)
      assert.match(vbs, /RegRead\("HKCU\\Control Panel\\International\\LocaleName"\)/, `${name} must ask Windows which language to speak`)
      assert.match(vbs, /DSH_POWER_SWITCH_LANG/, `${name} must allow the language to be forced`)
      const used = [...vbs.matchAll(/Msg\("([a-z0-9_]+)"/gu)].map((match) => match[1])
      assert.ok(used.length >= 4, `${name} must ask for its dialogs`)
    }
    const host = await readFile(at('src/index.js'), 'utf8')
    assert.match(host, /writeFileSync\(join\(state, 'shortcut-messages\.txt'\), `\\ufeff\$\{renderShortcutMessages\(\)\}`, 'utf16le'\)/)
  })

  it('wraps the cmd /c command, and waits so the exit code can be reported', async () => {
    // Measured: `shell.Run "cmd /c " & cmd` never ran anything at all. cmd /c
    // strips the first and last quote character of a command line holding more than
    // two quotes, so "C:\Program Files\nodejs\node.exe" was broken in half and the
    // error went into the mangled redirect target -- a shortcut that silently did
    // nothing. One extra pair of quotes is the fix, and it is also why the
    // manual-restart wrapper had never actually worked.
    //
    // The last argument is True (WAIT): a double-click has no console, so a
    // non-zero exit is only reportable at all if the wrapper can see it.
    for (const file of ['scripts/launch-dsh.vbs', 'scripts/restart-dsh-web.vbs']) {
      const vbs = await readFile(at(file), 'utf8')
      assert.match(vbs, /shell\.Run\("cmd \/c """ & cmd & """", 0, True\)/, `${file} must quote the whole command`)
      assert.match(vbs, /If exitCode <> 0 Then/, `${file} must report a failed launch instead of exiting silently`)
      assert.match(vbs, /MsgBox/, `${file} must show the failure it cannot print`)
      assert.doesNotMatch(vbs, /, 0, False/, `${file} must not return before the exit code is known`)
    }
  })

  it('closes the script path quote before the redirect', async () => {
    // Measured with a tracing copy of the real file: the command it built was
    //   "node.exe" "launch-dsh.mjs >> "dsh-power-switch-launch.log" 2>&1
    // -- the script path never closed. node was then asked to run a file whose name
    // contains a redirect, the redirect itself was swallowed, and the failure left
    // NOTHING in any log, which is why double-clicking the shortcut looked like it
    // did nothing at all. An extra pair of quotes around the whole command is NOT
    // enough on its own.
    const vbs = await readFile(at('scripts/launch-dsh.vbs'), 'utf8')
    assert.match(vbs, /& script & """ >> """ & logFile &/)
    assert.doesNotMatch(vbs, /& script & " >> """/)
  })

  it('records the harness home in the shortcut, so Explorer needs no DSH_HOME', async () => {
    const helper = await readFile(at('scripts/make-shortcut.vbs'), 'utf8')
    // The home is argument 2 and is written into the .lnk as `--home "<dir>"`.
    assert.match(helper, /home = WScript\.Arguments\(2\)/)
    assert.match(helper, /--home """/)
    const launcher = await readFile(at('scripts/launch-dsh.vbs'), 'utf8')
    // The wrapper resolves it (DSH_HOME first, then the recorded value) and hands
    // it to the launcher and the host as DSH_HOME, so all three agree on the state
    // directory. Without this, a machine whose DSH_HOME lives only in a shell left
    // the shortcut reading an empty state directory: no boot record, no refusal
    // message, nothing on screen.
    assert.match(launcher, /--home/)
    assert.match(launcher, /shell\.Environment\("Process"\)\("DSH_HOME"\) = homeDir/)
    assert.match(launcher, /If envHome = "" And bakedHome <> "" Then/)
  })

  /**
   * The plugin's display metadata, in the form DSH 0.1.7's reader expects.
   *
   * Measured against `app-boot`'s implementation (`readPluginMeta`): the icon is
   * `package.json.icon` — a MANIFEST-RELATIVE path, one of SVG/PNG/JPEG/WebP,
   * inside the manifest directory after realpath, at most 256 KiB — and localized
   * title/description come from `locale/<language>.json`, whose `meta` block is
   * read through Node exports (so `./locale/*.json` must be exported). The
   * English file is the entry point: without it no other language is read.
   */
  it('declares display metadata the way DSH reads it', async () => {
    const manifest = JSON.parse(await readFile(at('package.json'), 'utf8'))
    assert.equal(manifest.icon, './icon.svg')
    assert.equal(manifest.dsh.manifestVersion, 1)
    assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
    const icon = await readFile(at('icon.svg'))
    assert.ok(icon.length <= 256 * 1024, 'the icon must stay under the 256 KiB the reader admits')
    const english = JSON.parse(await readFile(at('locale/en.json'), 'utf8'))
    assert.equal(typeof english.meta.title, 'string')
    assert.equal(typeof english.meta.description, 'string')
    const chinese = JSON.parse(await readFile(at('locale/zh.json'), 'utf8'))
    assert.equal(typeof chinese.meta.title, 'string')
    assert.equal(typeof chinese.meta.description, 'string')
    // Both must actually be published, or the reader cannot resolve them.
    assert.ok(manifest.files.includes('icon.svg'))
    assert.ok(manifest.files.includes('locale'))
  })

  it('ships a repair script that works with the package gone', async () => {
    // A shortcut this plugin adopted points INTO the package, so uninstalling used to
    // take the desktop icon down with it. The record of the original always lived in
    // the state directory; this script replays it from there, beside its own copy.
    const vbs = await readFile(at('scripts/restore-shortcut.vbs'), 'utf8')
    // eslint-disable-next-line no-control-regex -- ASCII-ness is exactly the claim
    assert.doesNotMatch(vbs, /[^\u0000-\u007F]/u, 'restore-shortcut.vbs must stay ASCII-only')
    // The record is UTF-16, and the fallback is the harness home the wrappers use.
    assert.match(vbs, /OpenTextFile\(backupFile, 1, False, -1\)/)
    assert.match(vbs, /%DSH_HOME%/)
    // Both kinds: we adopted somebody's icon, or we created one.
    assert.match(vbs, /If kind = "created" Then/)
    assert.match(vbs, /fso\.DeleteFile lnkPath, True/)
    assert.match(vbs, /link\.TargetPath = bag\("target"\)/)
    assert.match(vbs, /link\.Description = bag\("description"\)/)
    // An incomplete record is refused rather than half-applied.
    assert.match(vbs, /The record is incomplete \(missing /)
    // And the host keeps that copy where uninstalling cannot reach it.
    const host = await readFile(at('src/index.js'), 'utf8')
    assert.match(host, /for \(const name of \['shortcut-launch\.vbs', 'restore-shortcut\.vbs'\]\)/)
    assert.match(host, /copyFileSync\(join\(WORKSPACE_ROOT, 'scripts', name\), join\(state, name\)\)/)
  })

  it('never lets the card choose a target, a path or a name', async () => {
    const host = await readFile(at('src/index.js'), 'utf8')
    assert.match(host, /createShortcutHandler\(\{ run: \(action\) => runShortcutHelper\(action, note\) \}\)/)
    assert.match(host, /const SHORTCUT_NAME = 'DSH 启动器'/)
    // Only the operation travels from the card, and only from a fixed list.
    const pure = await readFile(at('src/host.js'), 'utf8')
    assert.match(pure, /SHORTCUT_ACTIONS = \['scan', 'install', 'restore'\]/)
    assert.match(pure, /action must be "scan", "install" or "restore"/)
  })
})
