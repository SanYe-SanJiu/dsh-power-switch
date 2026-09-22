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
Option Explicit

Dim shell, fso, here, script, logFile, cmd, nodeExe, stateDir, nodeFile, stream
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "restart-dsh-web.mjs")
logFile = shell.ExpandEnvironmentStrings("%TEMP%\dsh-power-switch-restart.log")

If Not fso.FileExists(script) Then
  MsgBox "restart-dsh-web.mjs not found next to this script: " & script, 16, "dsh-power-switch"
  WScript.Quit 1
End If

' The interpreter the host recorded wins: see launch-dsh.vbs for why a
' %ProgramFiles%\nodejs\node.exe assumption fails on nvm/fnm/volta/Store installs.
nodeExe = ""
On Error Resume Next
stateDir = shell.ExpandEnvironmentStrings("%DSH_HOME%")
If stateDir = "%DSH_HOME%" Then stateDir = ""
If stateDir = "" Then stateDir = fso.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), ".dsh")
nodeFile = stateDir & "\storages\dsh-power-switch\node-path.txt"
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

cmd = """" & nodeExe & """ """ & script & """ --delay-seconds 3 >> """ & logFile & """ 2>&1"

' The whole command goes inside ONE MORE pair of quotes. cmd /c strips the first
' and the last quote character of its command line whenever that line holds more
' than two quotes, which broke the quoted program path -- and the error went to the
' equally mangled redirect target, so this wrapper was silent and had never
' actually run. Measured: without this, the log file is not even created.
shell.Run "cmd /c """ & cmd & """", 0, False
