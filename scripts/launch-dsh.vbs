' One-click DSH start, in the window shape the card stored.
'
' Point a desktop shortcut at this file (or double-click it). It runs
' scripts/launch-dsh.mjs with no console window, so the desktop entry behaves
' like a normal application launcher.
'
' Why this is needed at all: `dsh web` hands the URL to the DEFAULT BROWSER, so
' starting DSH that way always produces a normal tab. Launching with --no-open
' and letting launch-dsh.mjs open the window is the only way app mode can be
' honoured at startup. Output is appended to a file in %TEMP% -- appended, not
' truncated, so a failed launch cannot erase the evidence of the previous one.
'
' %TEMP% rather than the plugin's log: this wrapper only exists to survive a
' failure BEFORE node starts (no node on PATH, a broken script path), and the
' launcher writes its own log under the harness home once it is running. %TEMP%
' always exists and is always writable; the harness home may not exist yet.
'
' THE HARNESS HOME IS RESOLVED HERE and handed down as DSH_HOME, because the
' shortcut records it as `--home <dir>`. Explorer does not necessarily carry
' DSH_HOME -- a person who sets it in the shell they start DSH from leaves the
' desktop shortcut without it -- and a launcher that reads a different home finds
' no boot record, so it refuses and the shortcut looks like it does nothing.
' Precedence mirrors the launcher's own rule: a real DSH_HOME wins, the recorded
' one fills in, `~/.dsh` is last. The value is exported for this process, so the
' launcher AND the host it starts read the same state directory.
'
' A FAILURE IS REPORTED, never swallowed: this runs with no console, so a silent
' non-zero exit was indistinguishable from "the shortcut does nothing". It waits
' for the launcher and shows a message box with the exit code, the log tail and
' the log path.
Option Explicit

Dim shell, fso, here, script, logFile, cmd, nodeExe, bakedHome, envHome, homeDir
Dim nodeFile, stream, at, flag, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "launch-dsh.mjs")
logFile = shell.ExpandEnvironmentStrings("%TEMP%\dsh-power-switch-launch.log")

If Not fso.FileExists(script) Then
  MsgBox "launch-dsh.mjs not found next to this script: " & script, 16, "dsh-power-switch"
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
' `~` is expanded here too: the launcher expands it, and a home spelled with a
' tilde would otherwise leave this script looking for node-path.txt in a literal
' "~" directory and falling back to a node.exe that may not exist.
If Left(homeDir, 1) = "~" Then
  homeDir = fso.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), Mid(homeDir, 3))
End If

' Only the RECORDED home is exported: an environment variable that is already
' there is the more recent statement and is left alone.
If envHome = "" And bakedHome <> "" Then
  On Error Resume Next
  shell.Environment("Process")("DSH_HOME") = homeDir
  On Error GoTo 0
End If

' ------------------------------------------------- which node.exe to run

' The RECORDED one wins, and that is the whole point on a machine whose Node came
' from nvm-windows, fnm, volta or the Store: those have no
' %ProgramFiles%\nodejs\node.exe, and a bare "node.exe" needs a PATH that a
' shortcut's environment does not always carry. The plugin's host process writes
' its own interpreter path next to its other state -- one line of text, because
' this script cannot parse JSON.
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

' The home reaches the launcher as an environment variable, not as a flag: the
' launcher derives its state directory from DSH_HOME, exactly as the host does,
' so the exported value above is the single mechanism every process in this
' launch shares.

' ------------------------------------------------------------------- start

' 0 = hidden window. The launcher returns quickly: the host it starts is
' detached, so DSH keeps running after this script is gone.
'
' Careful with the quotes. The script path needs its OWN closing quote before the
' redirect: written the other way round, the path and the ">>" merge into a single
' quoted argument, so node is asked to run a file whose name contains a redirect --
' and the redirect itself is swallowed, which is why the failure left nothing at all
' in any log. A tracing copy of this file is what exposed it.
cmd = """" & nodeExe & """ """ & script & """ >> """ & logFile & """ 2>&1"

' The whole command goes inside ONE MORE pair of quotes, and that is not cosmetic.
' cmd /c strips the FIRST quote character and the LAST quote character of its
' command line whenever that line holds more than two quotes -- so a quoted program
' path such as "C:\Program Files\nodejs\node.exe" gets broken in half, and the
' error lands in the equally mangled redirect target. Measured: without this the
' command does not even create its log file, so double-clicking the shortcut
' silently does nothing at all. Both copies of this wrapper need it.
'
' WAITING (the third argument is True) is what makes the failure visible: the exit
' code is available only after the command ends, and this script has no console to
' print to. The detached host is unaffected -- the launcher returns as soon as the
' window is open.
exitCode = 0
On Error Resume Next
exitCode = shell.Run("cmd /c """ & cmd & """", 0, True)
If Err.Number <> 0 Then
  Err.Clear
  On Error GoTo 0
  MsgBox "The launcher could not be started at all." & vbCrLf & vbCrLf & _
    "node: " & nodeExe & vbCrLf & "home: " & homeDir & vbCrLf & vbCrLf & _
    "Log: " & logFile, 16, "dsh-power-switch"
  WScript.Quit 1
End If
On Error GoTo 0

If exitCode <> 0 Then
  MsgBox "DSH did not start (exit code " & CStr(exitCode) & ")." & vbCrLf & vbCrLf & _
    Tail(logFile) & vbCrLf & "Log: " & logFile, 16, "dsh-power-switch"
  WScript.Quit exitCode
End If

WScript.Quit 0

' The last few lines of a log, for the failure dialog above. Read as ANSI: the
' launcher's own lines are ASCII, and a message box is the one place a person
' will actually see them. Bounded, because a dialog shows only a screenful.
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
