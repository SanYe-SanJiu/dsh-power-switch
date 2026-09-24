/**
 * Execute the shortcut scripts, on the real Windows Script Host.
 *
 * Every other suite tests JavaScript. These have to test `.vbs`, because the whole
 * point of `shortcut-launch.vbs` and `restore-shortcut.vbs` is that they still work
 * when the package that contains them is GONE -- a JavaScript re-implementation
 * could not be reached in that situation either. So the shipped files are run for
 * real, against real `.lnk` files, in a scratch directory that stands in for the
 * state directory:
 *
 *  - `describe('the durable shortcut launcher')` runs the copy the desktop icon
 *    points at: delegating to the package while it is installed, restoring the
 *    original shortcut once it is not;
 *  - `describe('adopting and restoring a real shortcut')` drives the mechanical
 *    helper over a real `.lnk`, which is where the host's argument order, the
 *    record and the restore are checked against the shell rather than against text.
 *
 * Two things about the execution shape are deliberate:
 *
 *  - the shipped files report through a MsgBox, which would block a headless run
 *    forever. Each scenario therefore runs a copy whose only difference is
 *    `MsgBox` -> `Note`, and a test proves that difference is the whole difference,
 *    so what runs here is the file that ships;
 *  - the children's stdio is IGNORED, never piped. A piped grandchild is what
 *    fails with EPERM under a sandboxed host, which is also why the host calls
 *    these scripts by exit code plus a result file. The observations come back
 *    through files for the same reason.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { renderShortcutMessages } from '../src/host.js'

const windows = process.platform === 'win32'
const shipped = readFileSync(new URL('../scripts/restore-shortcut.vbs', import.meta.url), 'utf8')

/**
 * The translation file the host writes beside its copies, rendered by the host's own
 * function so the test reads what the plugin really ships.
 */
function writeMessages(dir) {
  writeFileSync(join(dir, 'shortcut-messages.txt'), `\ufeff${renderShortcutMessages()}`, 'utf16le')
}

/** The one change that makes the shipped script runnable without a person present. */
const NOTATION = [
  '',
  'Sub Note(m, s, t)',
  '  Dim noteFile, noteStream',
  '  Set noteFile = CreateObject("Scripting.FileSystemObject")',
  '  Set noteStream = noteFile.OpenTextFile(noteFile.BuildPath(noteFile.GetParentFolderName(WScript.ScriptFullName), "note.txt"), 8, True, -1)',
  '  noteStream.WriteLine CStr(m)',
  '  noteStream.Close',
  'End Sub',
  ''
].join('\r\n')

const runnable = shipped.replace(/^(\s*)MsgBox /gm, '$1Note ') + NOTATION

/** The UTF-16 record the shortcut helper writes, BOM included. */
function record(fields) {
  return '\ufeff' + fields.concat(['']).join('\r\n')
}

function utf16(file) {
  return existsSync(file) ? readFileSync(file, 'utf16le').replace(/^\ufeff/, '').trim() : ''
}

/** A scenario directory: the script, optionally a record, and whatever it made. */
function scenario(name, fields) {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'restore-shortcut.vbs'), runnable, 'ascii')
  if (fields) writeFileSync(join(dir, 'shortcut-backup.txt'), record(fields), 'utf16le')
  return dir
}

/**
 * Run one shipped script the way the shortcut does.
 *
 * `USERPROFILE` is redirected into the scratch directory, and that is load-bearing:
 * the stub falls back to the DEFAULT harness home when the environment and the
 * shortcut's `--home` name nothing, which is right for a desktop icon and disastrous
 * for a test -- it resolved this machine's real `~/.dsh`, found the developer's own
 * installed plugin there, and launched DSH instead of testing the branch it was
 * asked about. A test that can start the operator's harness is not a test.
 */
function wscript(script, { args = [], env = {} } = {}) {
  const run = spawnSync('wscript.exe', ['//nologo', script, ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, USERPROFILE: join(scratch, 'userhome'), DSH_HOME: join(scratch, 'home'), ...env },
    timeout: 30_000,
  })
  assert.equal(run.error, undefined, `wscript could not be started: ${String(run.error)}`)
  return run.status
}

/** Read the five fields back out of a `.lnk`, through the same shell that wrote it. */
function fieldsOf(dir, lnk) {
  // The reader APPENDS, so a previous answer has to go first: a second call in the
  // same directory would otherwise report the fields from before the change under
  // test.
  rmSync(join(dir, 'fields.txt'), { force: true })
  // The path travels in a UTF-16 file rather than inside the `.vbs`, because a
  // scratch path can hold the user name -- and wscript reads a `.vbs` as ANSI, so a
  // non-ASCII path baked into one would be read back as question marks.
  writeFileSync(join(dir, 'probe.txt'), '\ufeff' + lnk, 'utf16le')
  writeFileSync(
    join(dir, 'read-link.vbs'),
    [
      'Option Explicit',
      'Dim shell, fso, link, out, here, probe, probeStream, lnk',
      'Set shell = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'here = fso.GetParentFolderName(WScript.ScriptFullName)',
      'Set probeStream = fso.OpenTextFile(fso.BuildPath(here, "probe.txt"), 1, False, -1)',
      'lnk = Trim(probeStream.ReadAll)',
      'probeStream.Close',
      'Set link = shell.CreateShortcut(lnk)',
      'Set out = fso.OpenTextFile(fso.BuildPath(here, "fields.txt"), 8, True, -1)',
      'out.WriteLine link.TargetPath & "|" & link.Arguments & "|" & link.WorkingDirectory & "|" & link.IconLocation & "|" & link.Description',
      'out.Close',
      '',
    ].join('\r\n'),
    'ascii',
  )
  wscript(join(dir, 'read-link.vbs'))
  return utf16(join(dir, 'fields.txt'))
}

let scratch = ''

describe('shortcut repair without the package', () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'dsh-power-repair-'))
    mkdirSync(join(scratch, 'home'), { recursive: true })
    // The default harness home the stub falls back to is `%USERPROFILE%\.dsh`, so the
    // scratch directory needs a profile of its own -- see `wscript` below.
    mkdirSync(join(scratch, 'userhome'), { recursive: true })
  })

  after(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('is the shipped script, modulo the message boxes a headless run cannot answer', () => {
    // Without this the scenarios below would be testing a script that only looks
    // like the shipped one.
    const boxes = (shipped.match(/^\s*MsgBox /gm) ?? []).length
    const notes = (runnable.match(/^\s*Note /gm) ?? []).length
    assert.equal(notes, boxes, 'every MsgBox must have become a Note')
    assert.ok(boxes >= 1, `expected the script to report through a message box, saw ${boxes}`)
    const back = runnable
      .slice(0, runnable.length - NOTATION.length)
      .replace(/^(\s*)Note /gm, '$1MsgBox ')
    assert.equal(back, shipped, 'the runnable copy must differ from the shipped file in nothing else')
  })

  it('deletes the shortcut it created, and uses the record up', { skip: !windows }, () => {
    const dir = scenario('created', ['kind=created', `lnk=${join(scratch, 'created', 'DSH 启动器.lnk')}`])
    const lnk = join(dir, 'DSH 启动器.lnk')
    writeFileSync(lnk, 'placeholder')
    assert.equal(wscript(join(dir, 'restore-shortcut.vbs')), 0)
    assert.equal(existsSync(lnk), false, 'a shortcut the plugin created must be removed, not rewritten')
    assert.equal(existsSync(join(dir, 'shortcut-backup.txt')), false, 'the record has been used up')
    assert.match(utf16(join(dir, 'note.txt')), /DSH 启动器\.lnk/u, 'the report names the file it removed')
  })

  it('puts an adopted shortcut back, field for field', { skip: !windows }, () => {
    const lnk = join(scratch, 'adopted', 'DeepSeek Harness.lnk')
    const dir = scenario('adopted', [
      'kind=adopted',
      `lnk=${lnk}`,
      'target=C:\\Windows\\System32\\wscript.exe',
      'arguments="G:\\test\\deepseek-harness\\start-dsh-web.vbs"',
      'workingdir=G:\\test\\deepseek-harness',
      'icon=G:\\test\\deepseek-harness\\deepseek.ico,0',
      'description=直接打开 DeepSeek Harness Web UI',
    ])
    assert.equal(wscript(join(dir, 'restore-shortcut.vbs')), 0)
    assert.equal(existsSync(lnk), true, 'the original shortcut is rewritten in place')
    // The description is Chinese and the record is UTF-16: this is the assertion
    // that catches an ANSI read, which would silently mangle the desktop entry.
    assert.equal(
      fieldsOf(dir, lnk),
      'C:\\Windows\\System32\\wscript.exe|"G:\\test\\deepseek-harness\\start-dsh-web.vbs"|'
        + 'G:\\test\\deepseek-harness|G:\\test\\deepseek-harness\\deepseek.ico,0|直接打开 DeepSeek Harness Web UI',
    )
    assert.equal(existsSync(join(dir, 'shortcut-backup.txt')), false)
  })

  it('refuses an incomplete record instead of half-restoring it', { skip: !windows }, () => {
    // A shortcut missing its icon or description is a shortcut nobody chose, so the
    // script reports which field is gone and touches nothing.
    const dir = scenario('partial', ['kind=adopted', `lnk=${join(scratch, 'partial', 'x.lnk')}`, 'target=calc.exe'])
    assert.equal(wscript(join(dir, 'restore-shortcut.vbs')), 4)
    assert.match(utf16(join(dir, 'note.txt')), /missing (arguments|icon|workingdir|description|target)/u)
    assert.equal(existsSync(join(scratch, 'partial', 'x.lnk')), false)
    assert.equal(existsSync(join(dir, 'shortcut-backup.txt')), true, 'the record survives so the run can be retried')
  })

  it('falls back to the harness home when the record is not beside it', { skip: !windows }, () => {
    // Running the packaged copy, or a copy somebody moved, must still find the
    // record under DSH_HOME -- the same rule the launcher and both .vbs wrappers use.
    const dir = scenario('norecord', null)
    const store = join(scratch, 'home', 'storages', 'dsh-power-switch')
    mkdirSync(store, { recursive: true })
    const lnk = join(store, 'restored.lnk')
    writeFileSync(
      join(store, 'shortcut-backup.txt'),
      record(['kind=adopted', `lnk=${lnk}`, 'target=C:\\Windows\\notepad.exe', 'arguments=', 'workingdir=C:\\Windows', 'icon=C:\\Windows\\notepad.exe,0', 'description=note']),
      'utf16le',
    )
    assert.equal(wscript(join(dir, 'restore-shortcut.vbs')), 0)
    assert.equal(existsSync(lnk), true, 'the state directory is where an uninstalled plugin left the record')
  })

  it('says so, and exits 1, when there is nothing recorded', { skip: !windows }, () => {
    const dir = scenario('nothing', null)
    assert.equal(wscript(join(dir, 'restore-shortcut.vbs')), 1)
    const note = utf16(join(dir, 'note.txt'))
    assert.match(note, /Nothing to undo/u)
    assert.match(note, /dsh-power-switch/u, 'the report says where it looked')
  })

  it('shows its dialogs in the language the Windows interface speaks', { skip: !windows }, () => {
    // The scripts cannot carry Chinese: a `.vbs` is read as ANSI, so the text lives in
    // a UTF-16 file the host writes beside them. Without it the English compiled into
    // the call sites is what shows, which is what the tests above already prove.
    const lnk = join(scratch, 'chinese', 'DeepSeek Harness.lnk')
    const dir = scenario('chinese', [
      'kind=adopted',
      `lnk=${lnk}`,
      'target=C:\\Windows\\System32\\wscript.exe',
      'arguments="G:\\test\\deepseek-harness\\start-dsh-web.vbs"',
      'workingdir=G:\\test\\deepseek-harness',
      'icon=G:\\test\\deepseek-harness\\deepseek.ico,0',
      'description=直接打开 DeepSeek Harness Web UI',
    ])
    writeMessages(dir)

    assert.equal(wscript(join(dir, 'restore-shortcut.vbs'), { env: { DSH_POWER_SWITCH_LANG: 'zh' } }), 0)
    const note = utf16(join(dir, 'note.txt'))
    assert.match(note, /已还原原快捷方式/u, note)
    assert.match(note, /目标：/u, note)
    assert.match(note, /参数：/u, note)
    // The paths and field values are data, not text: they must survive untranslated.
    assert.match(note, /start-dsh-web\.vbs/u, note)
    assert.equal(existsSync(lnk), true)

    // Asking for English gets the compiled-in text, not the table's Chinese.
    const again = scenario('chinese-en', [
      'kind=adopted',
      `lnk=${join(scratch, 'chinese-en', 'x.lnk')}`,
      'target=C:\\Windows\\System32\\wscript.exe',
      'arguments=',
      'workingdir=C:\\Windows',
      'icon=C:\\Windows\\notepad.exe,0',
      'description=note',
    ])
    writeMessages(again)
    assert.equal(wscript(join(again, 'restore-shortcut.vbs'), { env: { DSH_POWER_SWITCH_LANG: 'en' } }), 0)
    assert.match(utf16(join(again, 'note.txt')), /Restored the original shortcut/u)
  })
})

/**
 * `shortcut-launch.vbs` is what the adopted desktop icon actually points at, so its
 * two branches are the whole "uninstall cannot break my shortcut" promise: hand the
 * launch to the package while it is there, put the original back when it is not.
 *
 * The launcher it should find is a STAND-IN here: a tiny script that records the
 * arguments it was handed and exits with a code of its own, which is how the
 * delegation, the argument forwarding and the exit code are all observed without
 * starting DSH.
 */
describe('the durable shortcut launcher', () => {
  const shippedStub = readFileSync(new URL('../scripts/shortcut-launch.vbs', import.meta.url), 'utf8')
  const stub = shippedStub.replace(/^(\s*)MsgBox /gm, '$1Note ') + NOTATION

  /**
   * A stand-in for the packaged launcher: records the arguments it was handed AND the
   * DSH_HOME it inherited, then exits 7. The environment is part of the observation
   * because the launched wrapper has to read the state directory of the home whose
   * launcher was run, not whichever home happened to be in the environment.
   */
  function fakeLauncher(path) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      [
        'Option Explicit',
        'Dim fso, out, i, all, here, shell',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'Set shell = CreateObject("WScript.Shell")',
        'here = fso.GetParentFolderName(WScript.ScriptFullName)',
        'all = ""',
        'For i = 0 To WScript.Arguments.Count - 1',
        '  all = all & "[" & WScript.Arguments(i) & "]"',
        'Next',
        'all = all & " DSH_HOME=[" & shell.ExpandEnvironmentStrings("%DSH_HOME%") & "]"',
        'Set out = fso.OpenTextFile(fso.BuildPath(here, "marker.txt"), 8, True, -1)',
        'out.WriteLine all',
        'out.Close',
        'WScript.Quit 7',
        '',
      ].join('\r\n'),
      'ascii',
    )
    return join(dirname(path), 'marker.txt')
  }

  /**
   * A profile as the host leaves it: the plugin's launcher under node_modules, and a
   * manifest that names the plugin in the bundles list the host loads plugins from.
   * `listed: false` models the leftover a `link:` uninstall leaves behind -- the
   * junction is still there, the manifest no longer mentions the plugin.
   */
  function fakeProfile(home, name, { listed = true } = {}) {
    const profile = join(home, 'profiles', name)
    const marker = fakeLauncher(join(profile, 'node_modules', 'dsh-power-switch', 'scripts', 'launch-dsh.vbs'))
    const bundles = listed ? ['@deepseek-ai/dsh-base', 'dsh-power-switch'] : ['@deepseek-ai/dsh-base']
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: listed ? { 'dsh-power-switch': 'link:G:/somewhere' } : {},
      dsh: { profile: { bundles } },
    }, null, 2), 'utf8')
    return marker
  }

  /** A scenario directory holding the launcher copy, and the real repair script. */
  function launchScenario(name, fields) {
    const dir = join(scratch, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'shortcut-launch.vbs'), stub, 'ascii')
    // The SHIPPED repair script, untransformed: the stub runs it with /quiet, so it
    // must not raise a dialog -- and a broken quiet gate must hang this test rather
    // than pass it.
    writeFileSync(join(dir, 'restore-shortcut.vbs'), readFileSync(new URL('../scripts/restore-shortcut.vbs', import.meta.url), 'utf8'), 'ascii')
    if (fields) writeFileSync(join(dir, 'shortcut-backup.txt'), record(fields), 'utf16le')
    return dir
  }

  it('hands the launch to the launcher the profile resolves to, arguments and exit code intact', { skip: !windows }, () => {
    const dir = launchScenario('stub-installed', null)
    const home = join(scratch, 'stub-installed-home')
    const marker = fakeProfile(home, 'web')

    assert.equal(wscript(join(dir, 'shortcut-launch.vbs'), { args: ['--home', home], env: { DSH_HOME: home } }), 7, 'the launcher exit code is forwarded')
    const forwarded = utf16(marker)
    assert.match(forwarded, /\[--home\]/u, 'the arguments this launch arrived with are handed over')
    assert.match(forwarded, new RegExp(`\\[${home.replace(/[\\^$*+?.()|[\]{}]/gu, '\\$&')}\\]`, 'u'))
    assert.equal(existsSync(join(dir, 'note.txt')), false, 'a launch that worked reports nothing')
  })

  it('ignores a stale launcher-path.txt, because the profile is the authority', { skip: !windows }, () => {
    // An earlier build recorded the packaged launcher in that file, and the record
    // outlives the plugin. If it still counted, a `link:` install that was removed
    // would keep launching from the checkout that is still on disk instead of putting
    // the original shortcut back.
    const dir = launchScenario('stub-stale', null)
    const home = join(scratch, 'stub-stale-home')
    const stale = join(scratch, 'stub-stale-checkout', 'scripts', 'launch-dsh.vbs')
    const staleMarker = fakeLauncher(stale)
    writeFileSync(join(dir, 'launcher-path.txt'), '\ufeff' + stale, 'utf16le')
    const liveMarker = fakeProfile(home, 'web')

    assert.equal(wscript(join(dir, 'shortcut-launch.vbs'), { args: ['--home', home], env: { DSH_HOME: home } }), 7)
    assert.equal(existsSync(liveMarker), true, 'the installed profile is what gets launched')
    assert.equal(existsSync(staleMarker), false, 'the stale record must not be followed')
  })

  it('treats a leftover junction as gone, because the manifest no longer names the plugin', { skip: !windows }, () => {
    // MEASURED on a real machine: removing a `link:` install rewrote the profile
    // manifest and left the junction in node_modules. A launcher file that still
    // resolves is therefore NOT evidence that the plugin is installed -- and treating
    // it as evidence is exactly how the shortcut kept launching a plugin that was gone
    // while the restore prompt never appeared.
    const lnk = join(scratch, 'stub-leftover', 'DeepSeek Harness.lnk')
    const dir = launchScenario('stub-leftover', [
      'kind=adopted',
      `lnk=${lnk}`,
      'target=C:\\Windows\\System32\\wscript.exe',
      'arguments="G:\\test\\deepseek-harness\\start-dsh-web.vbs"',
      'workingdir=G:\\test\\deepseek-harness',
      'icon=G:\\test\\deepseek-harness\\deepseek.ico,0',
      'description=直接打开 DeepSeek Harness Web UI',
    ])
    const home = join(scratch, 'stub-leftover-home')
    // The junction is still there and still resolves; the manifest is the leftover's
    // other half: the plugin is simply not in it any more.
    const leftoverMarker = fakeProfile(home, 'web', { listed: false })

    assert.equal(wscript(join(dir, 'shortcut-launch.vbs'), { args: ['--home', home], env: { DSH_HOME: home } }), 0)
    assert.equal(existsSync(leftoverMarker), false, 'a leftover directory is not an installed plugin')
    assert.equal(existsSync(lnk), true)
    assert.match(utf16(join(dir, 'note.txt')), /original launch method has been put back/u)
  })

  it('restores the original instead of launching a checkout that is still on disk', { skip: !windows }, () => {
    // The same shape without a profile directory at all: the checkout a removed
    // `link:` install pointed at is untouched, and a stale launcher-path.txt still
    // points into it. The icon must heal, not keep launching a plugin that is gone --
    // this is the report that produced the rule.
    const lnk = join(scratch, 'stub-unlinked', 'DeepSeek Harness.lnk')
    const dir = launchScenario('stub-unlinked', [
      'kind=adopted',
      `lnk=${lnk}`,
      'target=C:\\Windows\\System32\\wscript.exe',
      'arguments="G:\\test\\deepseek-harness\\start-dsh-web.vbs"',
      'workingdir=G:\\test\\deepseek-harness',
      'icon=G:\\test\\deepseek-harness\\deepseek.ico,0',
      'description=直接打开 DeepSeek Harness Web UI',
    ])
    const home = join(scratch, 'stub-unlinked-home')
    mkdirSync(home, { recursive: true })
    const checkout = join(scratch, 'stub-unlinked-checkout', 'scripts', 'launch-dsh.vbs')
    const marker = fakeLauncher(checkout)
    writeFileSync(join(dir, 'launcher-path.txt'), '\ufeff' + checkout, 'utf16le')

    assert.equal(wscript(join(dir, 'shortcut-launch.vbs'), { args: ['--home', home], env: { DSH_HOME: home } }), 0)
    assert.equal(existsSync(marker), false, 'nothing may be launched once no profile names the plugin')
    assert.equal(existsSync(lnk), true)
    assert.match(utf16(join(dir, 'note.txt')), /original launch method has been put back/u)
  })

  it('finds the launcher with only DSH_HOME set, as Explorer gives it', { skip: !windows }, () => {
    const dir = launchScenario('stub-env', null)
    const home = join(scratch, 'stub-env-home')
    const marker = fakeProfile(home, 'web')

    // No --home at all: the wrapper rule is that an existing DSH_HOME wins, and that
    // is what a shortcut double-clicked from Explorer has to rely on.
    assert.equal(wscript(join(dir, 'shortcut-launch.vbs'), { env: { DSH_HOME: home } }), 7)
    assert.equal(existsSync(marker), true, 'the profile that carries the plugin is searched')
    assert.match(utf16(marker), new RegExp(`DSH_HOME=\\[${home.replace(/[\\^$*+?.()|[\]{}]/gu, '\\$&')}\\]`, 'u'))
  })

  it('looks in every home the launch could mean, not just the first', { skip: !windows }, () => {
    // A DSH_HOME that changed after the shortcut was created must not hide an
    // installed plugin: if it did, the icon would decide the plugin is gone and put
    // itself back while the plugin is still there. The home the shortcut carries is
    // searched too, and the home the plugin was FOUND in is the one exported, so the
    // wrapper reads the state directory that belongs to the launcher it runs.
    const dir = launchScenario('stub-two-homes', null)
    const stale = join(scratch, 'stub-two-homes-stale')
    const real = join(scratch, 'stub-two-homes-real')
    mkdirSync(stale, { recursive: true })
    const marker = fakeProfile(real, 'web')

    assert.equal(wscript(join(dir, 'shortcut-launch.vbs'), { args: ['--home', real], env: { DSH_HOME: stale } }), 7)
    const recorded = utf16(marker)
    assert.match(recorded, /\[--home\]/u, 'the launch reached the installed plugin')
    assert.match(recorded, new RegExp(`DSH_HOME=\\[${real.replace(/[\\^$*+?.()|[\]{}]/gu, '\\$&')}\\]`, 'u'), 'the home that carries the plugin wins')
    assert.equal(existsSync(join(dir, 'note.txt')), false, 'nothing was restored')
  })

  it('also accepts a `--home=<dir>` spelling, which is how a shortcut may record it', { skip: !windows }, () => {
    const dir = launchScenario('stub-home-equals', null)
    const home = join(scratch, 'stub-home-equals-real')
    const marker = fakeProfile(home, 'web')
    assert.equal(wscript(join(dir, 'shortcut-launch.vbs'), { args: [`--home=${home}`], env: { DSH_HOME: join(scratch, 'stub-home-equals-stale') } }), 7)
    assert.equal(existsSync(marker), true)
  })

  it('puts the original shortcut back when the package is gone', { skip: !windows }, () => {
    const lnk = join(scratch, 'stub-gone', 'DeepSeek Harness.lnk')
    const dir = launchScenario('stub-gone', [
      'kind=adopted',
      `lnk=${lnk}`,
      'target=C:\\Windows\\System32\\wscript.exe',
      'arguments="G:\\test\\deepseek-harness\\start-dsh-web.vbs"',
      'workingdir=G:\\test\\deepseek-harness',
      'icon=G:\\test\\deepseek-harness\\deepseek.ico,0',
      'description=直接打开 DeepSeek Harness Web UI',
    ])
    const home = join(scratch, 'stub-gone-home')
    mkdirSync(home, { recursive: true })

    assert.equal(wscript(join(dir, 'shortcut-launch.vbs'), { args: ['--home', home], env: { DSH_HOME: home } }), 0)
    assert.equal(existsSync(lnk), true, 'the icon is usable again, pointing where it did before')
    assert.equal(
      fieldsOf(dir, lnk),
      'C:\\Windows\\System32\\wscript.exe|"G:\\test\\deepseek-harness\\start-dsh-web.vbs"|'
        + 'G:\\test\\deepseek-harness|G:\\test\\deepseek-harness\\deepseek.ico,0|直接打开 DeepSeek Harness Web UI',
    )
    assert.equal(existsSync(join(dir, 'shortcut-backup.txt')), false, 'the record has been used up')
    assert.match(utf16(join(dir, 'note.txt')), /original launch method has been put back/u)
  })

  it('says there was nothing to put back, and exits 1, without a record', { skip: !windows }, () => {
    const dir = launchScenario('stub-nothing', null)
    const home = join(scratch, 'stub-nothing-home')
    mkdirSync(home, { recursive: true })
    assert.equal(wscript(join(dir, 'shortcut-launch.vbs'), { args: ['--home', home], env: { DSH_HOME: home } }), 1)
    const note = utf16(join(dir, 'note.txt'))
    assert.match(note, /nothing to put back/u)
    assert.match(note, /shortcut-launch\.vbs/u, 'the message names the file the icon now starts')
  })

  it('tells the person in Chinese when that is the language of their Windows', { skip: !windows }, () => {
    // This is the dialog the whole feature exists for: the icon heals itself and says
    // so. The text comes from the UTF-16 message file, because the `.vbs` cannot hold
    // it -- and the English above is what shows when that file is not there.
    const lnk = join(scratch, 'stub-zh', 'DeepSeek Harness.lnk')
    const dir = launchScenario('stub-zh', [
      'kind=adopted',
      `lnk=${lnk}`,
      'target=C:\\Windows\\System32\\wscript.exe',
      'arguments="G:\\test\\deepseek-harness\\start-dsh-web.vbs"',
      'workingdir=G:\\test\\deepseek-harness',
      'icon=G:\\test\\deepseek-harness\\deepseek.ico,0',
      'description=直接打开 DeepSeek Harness Web UI',
    ])
    writeMessages(dir)
    const home = join(scratch, 'stub-zh-home')
    mkdirSync(home, { recursive: true })

    assert.equal(wscript(join(dir, 'shortcut-launch.vbs'), { args: ['--home', home], env: { DSH_HOME: home, DSH_POWER_SWITCH_LANG: 'zh' } }), 0)
    const note = utf16(join(dir, 'note.txt'))
    assert.match(note, /原有的启动方式已放回/u, note)
    assert.match(note, /再双击一次图标/u, note)
    assert.equal(existsSync(lnk), true)
  })

  it('is the shipped script, modulo the message boxes a headless run cannot answer', () => {
    const boxes = (shippedStub.match(/^\s*MsgBox /gm) ?? []).length
    assert.ok(boxes >= 3, `expected the launcher to report through message boxes, saw ${boxes}`)
    const back = stub
      .slice(0, stub.length - NOTATION.length)
      .replace(/^(\s*)Note /gm, '$1MsgBox ')
    assert.equal(back, shippedStub, 'the runnable copy must differ from the shipped file in nothing else')
    // eslint-disable-next-line no-control-regex -- ASCII-ness is exactly the claim
    assert.doesNotMatch(shippedStub, /[^\u0000-\u007F]/u, 'wscript reads a .vbs as ANSI')
  })
})

/**
 * The mechanical helper, driven over a REAL `.lnk` in the scratch directory.
 *
 * `make-shortcut.vbs` only needs the Desktop for the `create` action; adopting and
 * restoring work on whatever path the host names, which is exactly why this can be
 * checked here without rewriting the machine's own desktop icon. What it proves is
 * the seam no pure test can reach: the host's argument order, the fields the shell
 * really ends up with, and the record that has to be replayed exactly.
 */
describe('adopting and restoring a real shortcut', () => {
  const helperPath = fileURLToPath(new URL('../scripts/make-shortcut.vbs', import.meta.url))
  const stubPath = fileURLToPath(new URL('../scripts/shortcut-launch.vbs', import.meta.url))

  /** Run one action; stdio ignored for the reason in this file's header. */
  const action = (args) => {
    const run = spawnSync('cscript.exe', ['//nologo', helperPath, ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 30_000,
    })
    assert.equal(run.error, undefined, `cscript could not be started: ${String(run.error)}`)
    return run.status
  }

  /**
   * A generated `.lnk` writer, because the shell is the only thing that can.
   *
   * Both inputs arrive as UTF-16 files NEXT TO the script and the paths are built at
   * run time, never pasted into it: wscript reads a `.vbs` as ANSI, and the scratch
   * directory sits under a user name that need not be ASCII -- a path baked into the
   * file would come back as question marks and the script would pop the modal error
   * that a headless run cannot dismiss.
   */
  function writeLnk(file, values) {
    const dir = dirname(file)
    writeFileSync(join(dir, 'seed.txt'), '\ufeff' + values.join('|'), 'utf16le')
    writeFileSync(join(dir, 'target.txt'), '\ufeff' + file, 'utf16le')
    const script = join(dir, 'write-lnk.vbs')
    writeFileSync(script, [
      'Option Explicit',
      'Dim shell, fso, link, stream, parts, here, target',
      'Set shell = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'here = fso.GetParentFolderName(WScript.ScriptFullName)',
      'Set stream = fso.OpenTextFile(fso.BuildPath(here, "target.txt"), 1, False, -1)',
      'target = Trim(stream.ReadAll)',
      'stream.Close',
      'Set stream = fso.OpenTextFile(fso.BuildPath(here, "seed.txt"), 1, False, -1)',
      'parts = Split(stream.ReadAll, "|")',
      'stream.Close',
      'Set link = shell.CreateShortcut(target)',
      'link.TargetPath = parts(0)',
      'link.Arguments = parts(1)',
      'link.WorkingDirectory = parts(2)',
      'link.IconLocation = parts(3)',
      'link.Description = parts(4)',
      'link.Save',
      'WScript.Quit 0',
      '',
    ].join('\r\n'), 'ascii')
    return wscript(script)
  }

  it('writes what adoption asks for, and puts every field back', { skip: !windows }, () => {
    const dir = join(scratch, 'adopt')
    mkdirSync(dir, { recursive: true })
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const target = join(dir, 'DeepSeek Harness.lnk')
    // The original was a launcher of the person's own, with a Chinese tooltip: both
    // have to survive the record, the takeover and the restore unchanged.
    const original = [
      'C:\\Windows\\System32\\wscript.exe',
      '"G:\\test\\deepseek-harness\\start-dsh-web.vbs"',
      'G:\\test\\deepseek-harness',
      'G:\\test\\deepseek-harness\\deepseek.ico,0',
      '直接打开 DeepSeek Harness Web UI',
    ]
    writeLnk(target, original)
    const backup = join(dir, 'shortcut-backup.txt')
    const result = join(dir, 'shortcut-result.txt')
    const description = '启动 DSH 并按卡片里存着的窗口模式打开（tab / app）。'
    const args = (verb, extra) => [
      verb, join(home, 'shortcut-launch.vbs'), home, backup, result, 'DSH 启动器', description, ...(extra ?? []),
    ]
    // The copy the host keeps in the state directory, as the host would place it.
    writeFileSync(join(home, 'shortcut-launch.vbs'), readFileSync(stubPath, 'utf8'), 'ascii')

    assert.equal(action(args('apply', [target])), 0)
    const record = utf16(backup)
    assert.match(record, /^kind=adopted$/mu, 'the original must be recorded before it is overwritten')
    assert.ok(record.includes(`description=${original[4]}`), 'the Chinese description survives the record')
    // The three fields that decide what a double-click does, plus the tooltip: the
    // copy in the state directory, the harness home as the "Start in", and a title
    // for the person. The ICON is deliberately left alone -- it is still DSH's.
    assert.equal(
      fieldsOf(dir, target),
      `C:\\Windows\\System32\\wscript.exe|"${join(home, 'shortcut-launch.vbs')}" --home "${home}"|${home}|${original[3]}|${description}`,
    )
    assert.match(utf16(result), /action=adopted/u)

    assert.equal(action(args('restore')), 0)
    assert.equal(fieldsOf(dir, target), original.join('|'), 'every recorded field is back')
    assert.equal(existsSync(backup), false, 'the record is consumed')
    assert.equal(action(args('restore')), 6, 'a second restore reports that there is nothing to undo')
  })
})
