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
' It replays the record the plugin wrote BEFORE it changed anything:
'
'   kind=adopted -> put the recorded target, arguments, working directory, icon and
'                   description back on that .lnk
'   kind=created -> the plugin created that .lnk, so undoing it means deleting it
'
' Exit codes: 0 undone, 1 nothing recorded, 4 the shell refused.
Option Explicit

Dim shell, fso, here, backupFile, stateDir, stream, text, lines, i, line, pos, key, bag
Dim kind, lnkPath, link, message, required, name

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' The record sits next to this copy. Run from inside the package instead and it is
' found under the harness home -- DSH_HOME wins, then ~/.dsh, the same rule the
' launcher and the two .vbs wrappers use.
here = fso.GetParentFolderName(WScript.ScriptFullName)
backupFile = fso.BuildPath(here, "shortcut-backup.txt")
If Not fso.FileExists(backupFile) Then
  stateDir = shell.ExpandEnvironmentStrings("%DSH_HOME%")
  If stateDir = "%DSH_HOME%" Then stateDir = ""
  If stateDir = "" Then stateDir = fso.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), ".dsh")
  backupFile = stateDir & "\storages\dsh-power-switch\shortcut-backup.txt"
End If

If Not fso.FileExists(backupFile) Then
  MsgBox "Nothing to undo: no shortcut record was found." & vbCrLf & vbCrLf & _
    "Looked for:" & vbCrLf & backupFile, 64, "dsh-power-switch"
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
  MsgBox "Could not read the record:" & vbCrLf & backupFile, 16, "dsh-power-switch"
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
  MsgBox "The record names no shortcut:" & vbCrLf & backupFile, 16, "dsh-power-switch"
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
    MsgBox "Could not delete the shortcut this plugin created:" & vbCrLf & lnkPath, 16, "dsh-power-switch"
    WScript.Quit 4
  End If
  On Error GoTo 0
  message = "Removed the shortcut this plugin created:" & vbCrLf & lnkPath
Else
  ' Every field is required to put the original back exactly; a record missing one is
  ' reported rather than half-applied, which would leave a shortcut nobody chose.
  required = Array("target", "arguments", "workingdir", "icon", "description")
  For Each name In required
    If Not bag.Exists(name) Then
      MsgBox "The record is incomplete (missing " & name & "):" & vbCrLf & backupFile, 16, "dsh-power-switch"
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
    MsgBox "The shell refused to restore:" & vbCrLf & lnkPath, 16, "dsh-power-switch"
    WScript.Quit 4
  End If
  On Error GoTo 0
  message = "Restored the original shortcut:" & vbCrLf & lnkPath & vbCrLf & vbCrLf & _
    "target: " & bag("target") & vbCrLf & "arguments: " & bag("arguments")
End If

' The record has been used up: dropping it keeps a second run from "restoring" a
' shortcut that is already back, and matches what the plugin's own restore action does.
On Error Resume Next
fso.DeleteFile backupFile, True
On Error GoTo 0

MsgBox message, 64, "dsh-power-switch"
WScript.Quit 0
