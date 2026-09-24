' Undo the desktop-shortcut takeover WITHOUT the plugin installed.
'
' Why this file is copied out of the package: adopting the desktop icon is reversible,
' but the tool that reverses it lived inside the package. Removing the plugin therefore
' left a shortcut pointing at a launcher that no longer existed, so the desktop icon
' could not start DSH at all. The host keeps a copy of this script in
' $DSH_HOME/storages/dsh-power-switch/, next to the record, where uninstalling the
' package cannot reach it.
'
' Double-click it, or run:  wscript.exe restore-shortcut.vbs
'
' `/quiet` reports through the exit code alone. `shortcut-launch.vbs` passes it
' after it finds the package gone: that file then shows the one message a person
' needs, and two dialogs would be one too many.
'
' It replays the record the plugin wrote BEFORE it changed anything:
'
'   kind=adopted -> put the recorded target, arguments, working directory, icon and
'                   description back on that .lnk
'   kind=created -> the plugin created that .lnk, so undoing it means deleting it
'
' Exit codes: 0 undone, 1 nothing recorded, 4 the shell refused.
Option Explicit

Dim shell, fso, here, backupFile, stateDir, stream, text, lines, i, line, pos, key, bag
Dim kind, lnkPath, link, message, required, name, quiet, messages, language

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' This file's own folder, which is where the record and the translations sit. Set
' BEFORE the messages are loaded: the loader looks beside this script.
here = fso.GetParentFolderName(WScript.ScriptFullName)

' The dialogs below are shown in the reader's language: the translations are loaded
' from the file the host writes beside this copy, and the English text in this file is
' the fallback whenever that file is missing or has no entry.
LoadMessages()

quiet = False
For i = 0 To WScript.Arguments.Count - 1
  If LCase(WScript.Arguments(i)) = "/quiet" Then quiet = True
Next

' The record sits next to this copy. Run from inside the package instead and it is
' found under the harness home -- DSH_HOME wins, then ~/.dsh, the same rule the
' launcher and the two .vbs wrappers use.
backupFile = fso.BuildPath(here, "shortcut-backup.txt")
If Not fso.FileExists(backupFile) Then
  stateDir = shell.ExpandEnvironmentStrings("%DSH_HOME%")
  If stateDir = "%DSH_HOME%" Then stateDir = ""
  If stateDir = "" Then stateDir = fso.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), ".dsh")
  backupFile = stateDir & "\storages\dsh-power-switch\shortcut-backup.txt"
End If

If Not fso.FileExists(backupFile) Then
  Report Msg("undo_nothing", "Nothing to undo: no shortcut record was found.") & vbCrLf & vbCrLf & _
    Msg("undo_looked", "Looked for:") & vbCrLf & backupFile, 64
  WScript.Quit 1
End If

' UTF-16: the plugin writes this record with the Unicode flag, so a desktop path or a
' description containing Chinese round-trips.
Set bag = CreateObject("Scripting.Dictionary")
On Error Resume Next
Err.Clear
Set stream = fso.OpenTextFile(backupFile, 1, False, -1)
text = stream.ReadAll
stream.Close
If Err.Number <> 0 Then
  Err.Clear
  On Error GoTo 0
  Report Msg("undo_unreadable", "Could not read the record:") & vbCrLf & backupFile, 16
  WScript.Quit 4
End If
On Error GoTo 0

lines = Split(Replace(text, vbCrLf, vbLf), vbLf)
For i = 0 To UBound(lines)
  line = lines(i)
  pos = InStr(line, "=")
  If pos > 0 Then
    key = Left(line, pos - 1)
    If Not bag.Exists(key) Then bag.Add key, Mid(line, pos + 1)
  End If
Next

If Not bag.Exists("lnk") Then
  Report Msg("undo_noname", "The record names no shortcut:") & vbCrLf & backupFile, 16
  WScript.Quit 4
End If
kind = ""
If bag.Exists("kind") Then kind = bag("kind")
lnkPath = bag("lnk")

If kind = "created" Then
  ' We made it, so undoing it means removing it.
  On Error Resume Next
  Err.Clear
  If fso.FileExists(lnkPath) Then fso.DeleteFile lnkPath, True
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Report Msg("undo_delete_failed", "Could not delete the shortcut this plugin created:") & vbCrLf & lnkPath, 16
    WScript.Quit 4
  End If
  On Error GoTo 0
  message = Msg("undo_removed", "Removed the shortcut this plugin created:") & vbCrLf & lnkPath
Else
  ' Every field is required to put the original back exactly; a record missing one is
  ' reported rather than half-applied, which would leave a shortcut nobody chose.
  required = Array("target", "arguments", "workingdir", "icon", "description")
  For Each name In required
    If Not bag.Exists(name) Then
      Report Replace(Msg("undo_incomplete", "The record is incomplete (missing %s):"), "%s", name) & vbCrLf & backupFile, 16
      WScript.Quit 4
    End If
  Next
  On Error Resume Next
  Err.Clear
  Set link = shell.CreateShortcut(lnkPath)
  link.TargetPath = bag("target")
  link.Arguments = bag("arguments")
  link.WorkingDirectory = bag("workingdir")
  link.IconLocation = bag("icon")
  link.Description = bag("description")
  link.Save
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Report Msg("undo_refused", "The shell refused to restore:") & vbCrLf & lnkPath, 16
    WScript.Quit 4
  End If
  On Error GoTo 0
  message = Msg("undo_restored", "Restored the original shortcut:") & vbCrLf & lnkPath & vbCrLf & vbCrLf & _
    Msg("undo_target", "target: ") & bag("target") & vbCrLf & Msg("undo_arguments", "arguments: ") & bag("arguments")
End If

' The record has been used up: dropping it keeps a second run from "restoring" a
' shortcut that is already back, and matches what the plugin's own restore action does.
On Error Resume Next
fso.DeleteFile backupFile, True
On Error GoTo 0

Report message, 64
WScript.Quit 0

' One place decides whether anything is said at all. `/quiet` exists so that
' shortcut-launch.vbs can report the outcome itself: a dialog nobody is present to
' dismiss would hang the launch instead of explaining it.
Sub Report(text, style)
  If quiet = True Then Exit Sub
  MsgBox text, style, "dsh-power-switch"
End Sub

' The messages, in the language the person reads. The ENGLISH text is compiled into
' the calls above as the fallback, and the translations live in a UTF-16 file the host
' writes beside this copy -- `<state>\shortcut-messages.txt` -- because a `.vbs` is
' read as ANSI: Chinese written into this file would land on screen as mojibake, and a
' UTF-16 script file would be a binary blob in the repository. Both copies carry this
' block because either one can be run on its own.
'
' The language is the Windows user interface language, because this is a Windows
' dialog; `DSH_POWER_SWITCH_LANG` overrides it for testing and for anyone who wants the
' other language.
Function Msg(key, fallback)
  Msg = fallback
  If messages.Exists(key & "." & language) Then Msg = messages(key & "." & language)
End Function

Sub LoadMessages()
  Dim file, stream, text, lines, count, line, at, name
  Set messages = CreateObject("Scripting.Dictionary")
  language = DetectLanguage()
  file = fso.BuildPath(here, "shortcut-messages.txt")
  On Error Resume Next
  Err.Clear
  If fso.FileExists(file) Then
    Set stream = fso.OpenTextFile(file, 1, False, -1)
    text = stream.ReadAll
    stream.Close
    If Err.Number = 0 Then
      lines = Split(Replace(text, vbCrLf, vbLf), vbLf)
      For count = 0 To UBound(lines)
        line = lines(count)
        at = InStr(line, "=")
        If at > 0 Then
          name = Left(line, at - 1)
          If Not messages.Exists(name) Then messages.Add name, Mid(line, at + 1)
        End If
      Next
    End If
  End If
  Err.Clear
  On Error GoTo 0
End Sub

' Two letters of the Windows user interface language, or "en". Read from the registry
' rather than guessed from the machine's locale: this is the language Explorer itself
' speaks to the person who double-clicked the icon.
Function DetectLanguage()
  Dim override, localeName, detected
  override = LCase(Trim(shell.ExpandEnvironmentStrings("%DSH_POWER_SWITCH_LANG%")))
  If override = "%dsh_power_switch_lang%" Then override = ""
  If override <> "" Then
    DetectLanguage = Left(override, 2)
    Exit Function
  End If
  localeName = ""
  On Error Resume Next
  localeName = shell.RegRead("HKCU\Control Panel\International\LocaleName")
  On Error GoTo 0
  detected = LCase(Left(Trim(localeName), 2))
  If detected = "" Then detected = "en"
  DetectLanguage = detected
End Function
