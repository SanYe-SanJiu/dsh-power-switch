/**
 * Execute the shortcut-repair script, on the real Windows Script Host.
 *
 * Every other suite tests JavaScript. This one has to test a `.vbs`, because the
 * whole point of `restore-shortcut.vbs` is that it still works when the package
 * that contains it is GONE -- a JavaScript re-implementation could not be reached
 * in that situation either. So the shipped file is run for real, against real
 * `.lnk` files, in a scratch directory that stands in for the state directory.
 *
 * Two things about the execution shape are deliberate:
 *
 *  - the shipped file ends in a MsgBox, which would block a headless run forever.
 *    Each scenario therefore runs a copy whose only difference is `MsgBox` ->
 *    `Note`, and the last test proves that difference is the whole difference, so
 *    what runs here is the file that ships;
 *  - the children's stdio is IGNORED, never piped. A piped grandchild is what
 *    fails with EPERM under a sandboxed host, which is also why the host calls
 *    this script by exit code plus a result file. The observations come back
 *    through files for the same reason.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const windows = process.platform === 'win32'
const shipped = readFileSync(new URL('../scripts/restore-shortcut.vbs', import.meta.url), 'utf8')

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

function wscript(script) {
  const run = spawnSync('wscript.exe', ['//nologo', script], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, DSH_HOME: join(scratch, 'home') },
    timeout: 30_000,
  })
  assert.equal(run.error, undefined, `wscript could not be started: ${String(run.error)}`)
  return run.status
}

/** Read the five fields back out of a `.lnk`, through the same shell that wrote it. */
function fieldsOf(dir, lnk) {
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
    assert.ok(boxes >= 7, `expected the script to report through message boxes, saw ${boxes}`)
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
})
