' One-click DSH restart, detached from whoever launched it.
'
' wscript owns the child, so the restart survives the host it is restarting.
' (A PowerShell wrapper was tried first: its child processes were observed being
' reaped, which left the host stopped with no replacement.)
'
' Double-click this file, or run:  wscript.exe restart-dsh-web.vbs
'
' It hands off to scripts/restart-dsh-web.mjs, which stops the host on the port
' gracefully, starts the same command line again, and then PROVES this plugin's
' browser half made it into the boot payload. Output goes to a file in %TEMP%,
' opened for APPEND -- a plain redirect would truncate it and destroy the
' evidence of whatever failed before this run.
'
' The harness home is resolved HERE as well (an optional `--home <dir>`, then
' DSH_HOME, then `~/.dsh`) and exported for this process, so this script and the
' restart it starts agree on which state directory holds node-path.txt and the
' boot record. A failure is reported in a message box rather than swallowed,
' because this runs with no console.
Option Explicit

Dim shell, fso, here, script, logFile, cmd, nodeExe, bakedHome, envHome, homeDir
Dim nodeFile, stream, at, flag, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "restart-dsh-web.mjs")
logFile = shell.ExpandEnvironmentStrings("%TEMP%\dsh-power-switch-restart.log")

If Not fso.FileExists(script) Then
  MsgBox "restart-dsh-web.mjs not found next to this script: " & script, 16, "dsh-power-switch"
  WScript.Quit 1
End If

' ---------------------------------------------------------- the harness home

bakedHome = ""
For at = 0 To WScript.Arguments.Count - 1
  flag = WScript.Arguments(at)
  If flag = "--home" Then
    If at + 1 <= WScript.Arguments.Count - 1 Then bakedHome = Trim(WScript.Arguments(at + 1))
  ElseIf Left(flag, 7) = "--home=" Then
    bakedHome = Trim(Mid(flag, 8))
  End If
Next

On Error Resume Next
envHome = shell.ExpandEnvironmentStrings("%DSH_HOME%")
If envHome = "%DSH_HOME%" Then envHome = ""
envHome = Trim(envHome)
On Error GoTo 0

homeDir = envHome
If homeDir = "" Then homeDir = bakedHome
If homeDir = "" Then homeDir = fso.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), ".dsh")
If Left(homeDir, 1) = "~" Then
  homeDir = fso.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), Mid(homeDir, 3))
End If

If envHome = "" And bakedHome <> "" Then
  On Error Resume Next
  shell.Environment("Process")("DSH_HOME") = homeDir
  On Error GoTo 0
End If

' ------------------------------------------------- which node.exe to run

' The interpreter the host recorded wins: see launch-dsh.vbs for why a
' %ProgramFiles%\nodejs\node.exe assumption fails on nvm/fnm/volta/Store installs.
nodeExe = ""
On Error Resume Next
nodeFile = homeDir & "\storages\dsh-power-switch\node-path.txt"
If fso.FileExists(nodeFile) Then
  Set stream = fso.OpenTextFile(nodeFile, 1, False)
  If Not stream.AtEndOfStream Then nodeExe = Trim(stream.ReadLine())
  stream.Close
End If
If nodeExe <> "" Then
  If Not fso.FileExists(nodeExe) Then nodeExe = ""
End If
If nodeExe = "" Then
  nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
  If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"
End If
On Error GoTo 0

' The home reaches the restart through the exported DSH_HOME above, which every
' child process inherits; this script's own .mjs takes no --home flag.
cmd = """" & nodeExe & """ """ & script & """ --delay-seconds 3 >> """ & logFile & """ 2>&1"

' The whole command goes inside ONE MORE pair of quotes. cmd /c strips the first
' and the last quote character of its command line whenever that line holds more
' than two quotes, which broke the quoted program path -- and the error went to the
' equally mangled redirect target, so this wrapper was silent and had never
' actually run. Measured: without this, the log file is not even created.
'
' True = wait, so the exit code can be turned into a message box: a double-click
' has no console to print to.
exitCode = 0
On Error Resume Next
exitCode = shell.Run("cmd /c """ & cmd & """", 0, True)
If Err.Number <> 0 Then
  Err.Clear
  On Error GoTo 0
  MsgBox "The restart could not be started at all." & vbCrLf & vbCrLf & _
    "node: " & nodeExe & vbCrLf & "home: " & homeDir & vbCrLf & vbCrLf & _
    "Log: " & logFile, 16, "dsh-power-switch"
  WScript.Quit 1
End If
On Error GoTo 0

If exitCode <> 0 Then
  MsgBox "The restart failed (exit code " & CStr(exitCode) & ")." & vbCrLf & vbCrLf & _
    Tail(logFile) & vbCrLf & "Log: " & logFile, 16, "dsh-power-switch"
  WScript.Quit exitCode
End If

WScript.Quit 0

' The last few lines of a log, for the failure dialog above.
Function Tail(path)
  Dim logStream, line, keep, count, index, first
  Tail = "(no log was written)"
  On Error Resume Next
  If Not fso.FileExists(path) Then Exit Function
  Set logStream = fso.OpenTextFile(path, 1, False)
  keep = Array("", "", "", "", "", "", "", "")
  count = 0
  Do Until logStream.AtEndOfStream
    line = logStream.ReadLine()
    If line <> "" Then
      keep(count Mod 8) = line
      count = count + 1
    End If
  Loop
  logStream.Close
  If count = 0 Then
    Tail = "(the log is empty)"
    Exit Function
  End If
  first = 0
  If count > 8 Then first = count - 8
  Tail = ""
  For index = first To count - 1
    Tail = Tail & keep(index Mod 8) & vbCrLf
  Next
  If Len(Tail) > 900 Then Tail = Right(Tail, 900)
End Function
