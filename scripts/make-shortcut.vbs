' Check, adopt, create and RESTORE the desktop shortcut that starts DSH in the
' stored window shape.
'
' Why a shortcut has to change at all: `dsh web` hands its URL to the default
' browser, so it always opens a tab, and no plugin can intercept that. The stored
' mode therefore only governs a cold start when the thing that is double-clicked
' starts the packaged launcher instead. People already have a shortcut for this,
' so adopting THAT one is better than leaving a second icon beside it -- and the
' original is recorded first, so the change can be undone exactly.
'
' This file is deliberately MECHANICAL: it reads and writes .lnk files and never
' decides which icon is "the DSH one". That decision has to be testable, so it
' lives in the plugin's pure half (classifyShortcut / chooseShortcutAction). A
' classifier that cannot be unit-tested is how a real desktop shortcut got missed.
'
' Every piece of text arrives as an ARGUMENT and this file stays pure ASCII:
' wscript decodes a .vbs as ANSI, so a UTF-8 file containing Chinese would put a
' mojibake name on the desktop. Arguments are UTF-16 and survive.
'
' Arguments:
'   0  action       "scan" | "apply" | "create" | "restore"
'   1  launcher     the packaged launch-dsh.vbs to point at
'   2  home         the harness home to record in the shortcut (may be empty)
'   3  backupPath   where the ORIGINAL shortcut is recorded, for restore
'   4  resultPath   where this run writes what it did (UTF-16)
'   5  lnkName      the shortcut name to create ("DSH" is never taken over)
'   6  description  the shortcut's tooltip text
'   7  targetLnk    the shortcut to adopt (required by "apply" only)
'
' The home is written into the shortcut as `--home <dir>`, and that is the reason
' it is an argument at all: Explorer does not necessarily carry DSH_HOME, so a
' shortcut that did not record the home the host was using made the launcher read
' a different state directory, find no boot record, refuse to start anything, and
' look to the person like a shortcut that does nothing. The value is recorded,
' never interpreted -- this file stays mechanical.
'
' Exit codes: 0 fine, 1 bad arguments, 2 launcher missing, 3 no Desktop,
'             4 the shell refused to save, 6 nothing to restore.
Option Explicit

Dim shell, fso, action, launcher, home, backupPath, resultPath, lnkName, description
Dim targetLnk, desktop, ourLnk

If WScript.Arguments.Count < 7 Then WScript.Quit 1
action = LCase(WScript.Arguments(0))
launcher = WScript.Arguments(1)
home = WScript.Arguments(2)
backupPath = WScript.Arguments(3)
resultPath = WScript.Arguments(4)
lnkName = WScript.Arguments(5)
description = WScript.Arguments(6)
targetLnk = ""
If WScript.Arguments.Count > 7 Then targetLnk = WScript.Arguments(7)

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

On Error Resume Next
desktop = shell.SpecialFolders("Desktop")
If Err.Number <> 0 Then WScript.Quit 3
Err.Clear
If desktop = "" Then WScript.Quit 3
If Not fso.FolderExists(desktop) Then WScript.Quit 3

ourLnk = fso.BuildPath(desktop, lnkName & ".lnk")

If action = "scan" Then WScript.Quit DoScan()
If action = "apply" Then WScript.Quit DoApply()
If action = "create" Then WScript.Quit DoCreate()
If action = "restore" Then WScript.Quit DoRestore()
WScript.Quit 1

' ---------------------------------------------------------------- result file

' Start a fresh result file. Unicode (the third argument) so a path or a name
' with Chinese in it round-trips; the host reads it back as UTF-16.
Sub OpenResult()
  Dim stream
  Set stream = fso.CreateTextFile(resultPath, True, True)
  stream.Close
End Sub

Sub Say(key, value)
  Dim stream
  On Error Resume Next
  Set stream = fso.OpenTextFile(resultPath, 8, True, -1)
  stream.WriteLine key & "=" & Replace(Replace(Replace(value, vbCrLf, " "), vbCr, " "), vbLf, " ")
  stream.Close
End Sub

' ------------------------------------------------------------------ shortcuts

' Read one shortcut's values into a Dictionary, or Nothing when unreadable.
Function ReadLnk(path)
  Dim link, bag
  Set ReadLnk = Nothing
  On Error Resume Next
  Set link = shell.CreateShortcut(path)
  If Err.Number <> 0 Then
    Err.Clear
    Exit Function
  End If
  Set bag = CreateObject("Scripting.Dictionary")
  bag.Add "target", link.TargetPath
  bag.Add "arguments", link.Arguments
  bag.Add "workingdir", link.WorkingDirectory
  bag.Add "icon", link.IconLocation
  bag.Add "description", link.Description
  Set ReadLnk = bag
End Function

' Point one shortcut at the packaged launcher.
Function ApplyOurs(path)
  Dim link
  ApplyOurs = False
  On Error Resume Next
  Err.Clear
  Set link = shell.CreateShortcut(path)
  link.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
  If Not fso.FileExists(link.TargetPath) Then link.TargetPath = "wscript.exe"
  ' `--home "<dir>"` is what makes this shortcut independent of the environment
  ' Explorer happens to carry: the wrapper resolves the state directory from it
  ' (DSH_HOME still wins when it is set). Omitted when the host reported none.
  If home = "" Then
    link.Arguments = """" & launcher & """"
  Else
    link.Arguments = """" & launcher & """ --home """ & home & """"
  End If
  ' The working directory is the HARNESS HOME, not the launcher's package: this
  ' shortcut has to stay valid after the package is gone, and a "Start in" pointing
  ' at a deleted directory is one more thing that looks broken. It is cosmetic --
  ' the launcher passes the CLI its own working directory, taken from the boot
  ' record -- so the only other requirement is that it exists. Without a home the
  ' launcher's own folder stays the fallback.
  If home = "" Then
    link.WorkingDirectory = fso.GetParentFolderName(fso.GetParentFolderName(launcher))
  Else
    link.WorkingDirectory = home
  End If
  link.Description = description
  link.Save
  If Err.Number <> 0 Then
    Err.Clear
    Exit Function
  End If
  ApplyOurs = True
End Function

' ------------------------------------------------------------------- the backup

Function WriteBackup(kind, path, bag)
  Dim stream
  WriteBackup = False
  On Error Resume Next
  Err.Clear
  Set stream = fso.CreateTextFile(backupPath, True, True)
  stream.WriteLine "kind=" & kind
  stream.WriteLine "lnk=" & path
  If kind = "adopted" Then
    stream.WriteLine "target=" & bag("target")
    stream.WriteLine "arguments=" & bag("arguments")
    stream.WriteLine "workingdir=" & bag("workingdir")
    stream.WriteLine "icon=" & bag("icon")
    stream.WriteLine "description=" & bag("description")
  End If
  stream.Close
  If Err.Number <> 0 Then
    Err.Clear
    Exit Function
  End If
  WriteBackup = True
End Function

Function ReadBackup()
  Dim stream, text, lines, i, line, pos, key, bag
  Set ReadBackup = Nothing
  If Not fso.FileExists(backupPath) Then Exit Function
  On Error Resume Next
  Err.Clear
  Set stream = fso.OpenTextFile(backupPath, 1, False, -1)
  text = stream.ReadAll
  stream.Close
  If Err.Number <> 0 Then
    Err.Clear
    Exit Function
  End If
  Set bag = CreateObject("Scripting.Dictionary")
  lines = Split(Replace(text, vbCrLf, vbLf), vbLf)
  For i = 0 To UBound(lines)
    line = lines(i)
    pos = InStr(line, "=")
    If pos > 0 Then
      key = Left(line, pos - 1)
      If Not bag.Exists(key) Then bag.Add key, Mid(line, pos + 1)
    End If
  Next
  Set ReadBackup = bag
End Function

' ------------------------------------------------------------------ the actions

' Read-only: report every desktop shortcut FACTUALLY. Deciding which one is the
' DSH entry point is the host's job, because that is the part that must be
' testable -- and the part that once missed a real shortcut.
Function DoScan()
  Dim folder, file, bag, index
  OpenResult()
  Set folder = fso.GetFolder(desktop)
  index = 0
  For Each file In folder.Files
    If LCase(fso.GetExtensionName(file.Name)) = "lnk" Then
      Set bag = ReadLnk(file.Path)
      If Not (bag Is Nothing) Then
        Say "lnk" & CStr(index), file.Path
        Say "name" & CStr(index), file.Name
        Say "target" & CStr(index), bag("target")
        Say "args" & CStr(index), bag("arguments")
        Say "workdir" & CStr(index), bag("workingdir")
        Say "desc" & CStr(index), bag("description")
        index = index + 1
      End If
    End If
  Next
  Say "action", "scan"
  Say "count", CStr(index)
  DoScan = 0
End Function

' Adopt one shortcut the host picked: record the original, then repoint it.
Function DoApply()
  Dim bag
  OpenResult()
  If targetLnk = "" Then
    Say "action", "failed"
    Say "error", "no shortcut was named to adopt"
    DoApply = 1
    Exit Function
  End If
  If Not fso.FileExists(launcher) Then
    Say "action", "failed"
    Say "error", "the packaged launcher is missing: " & launcher
    DoApply = 2
    Exit Function
  End If
  If Not fso.FileExists(targetLnk) Then
    Say "action", "failed"
    Say "error", "that shortcut no longer exists: " & targetLnk
    DoApply = 1
    Exit Function
  End If
  Set bag = ReadLnk(targetLnk)
  If bag Is Nothing Then
    Say "action", "failed"
    Say "error", "that shortcut could not be read: " & targetLnk
    DoApply = 1
    Exit Function
  End If
  ' An existing backup means a previous run is still in charge; overwriting it
  ' would destroy the only record of the original.
  If Not fso.FileExists(backupPath) Then
    If Not WriteBackup("adopted", targetLnk, bag) Then
      Say "action", "failed"
      Say "error", "could not record the original shortcut before changing it"
      DoApply = 4
      Exit Function
    End If
  End If
  If Not ApplyOurs(targetLnk) Then
    Say "action", "failed"
    Say "error", "the shell refused to save the shortcut"
    DoApply = 4
    Exit Function
  End If
  Say "action", "adopted"
  Say "lnk", targetLnk
  Say "was", bag("target")
  DoApply = 0
End Function

Function DoCreate()
  OpenResult()
  If Not fso.FileExists(launcher) Then
    Say "action", "failed"
    Say "error", "the packaged launcher is missing: " & launcher
    DoCreate = 2
    Exit Function
  End If
  If Not fso.FileExists(backupPath) Then
    If Not WriteBackup("created", ourLnk, Nothing) Then
      Say "action", "failed"
      Say "error", "could not record what was created"
      DoCreate = 4
      Exit Function
    End If
  End If
  If Not ApplyOurs(ourLnk) Then
    Say "action", "failed"
    Say "error", "the shell refused to save the shortcut"
    DoCreate = 4
    Exit Function
  End If
  Say "action", "created"
  Say "lnk", ourLnk
  DoCreate = 0
End Function

Function DoRestore()
  Dim record, path, link
  OpenResult()
  Set record = ReadBackup()
  If record Is Nothing Then
    Say "action", "failed"
    Say "error", "there is nothing to restore: no shortcut was changed by this plugin"
    DoRestore = 6
    Exit Function
  End If
  path = record("lnk")

  If record("kind") = "created" Then
    ' We made it, so undoing it means removing it.
    On Error Resume Next
    Err.Clear
    If fso.FileExists(path) Then fso.DeleteFile path, True
    If Err.Number <> 0 Then
      Err.Clear
      Say "action", "failed"
      Say "error", "could not delete " & path
      DoRestore = 4
      Exit Function
    End If
    Err.Clear
    fso.DeleteFile backupPath, True
    Say "action", "removed"
    Say "lnk", path
    DoRestore = 0
    Exit Function
  End If

  On Error Resume Next
  Err.Clear
  Set link = shell.CreateShortcut(path)
  link.TargetPath = record("target")
  link.Arguments = record("arguments")
  link.WorkingDirectory = record("workingdir")
  link.IconLocation = record("icon")
  link.Description = record("description")
  link.Save
  If Err.Number <> 0 Then
    Err.Clear
    Say "action", "failed"
    Say "error", "the shell refused to restore " & path
    DoRestore = 4
    Exit Function
  End If
  Err.Clear
  fso.DeleteFile backupPath, True
  Say "action", "restored"
  Say "lnk", path
  Say "target", record("target")
  DoRestore = 0
End Function
