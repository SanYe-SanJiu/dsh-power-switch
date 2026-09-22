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
Option Explicit

Dim shell, fso, here, script, logFile, cmd, nodeExe, stateDir, nodeFile, stream
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "launch-dsh.mjs")
logFile = shell.ExpandEnvironmentStrings("%TEMP%\dsh-power-switch-launch.log")

If Not fso.FileExists(script) Then
  MsgBox "launch-dsh.mjs not found next to this script: " & script, 16, "dsh-power-switch"
  WScript.Quit 1
End If

' Which node.exe to run. The RECORDED one wins, and that is the whole point on a
' machine whose Node came from nvm-windows, fnm, volta or the Store: those have
' no %ProgramFiles%\nodejs\node.exe, and a bare "node.exe" needs a PATH that a
' shortcut's environment does not always carry. The plugin's host process writes
' its own interpreter path next to its other state -- one line of text, because
' this script cannot parse JSON.
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
shell.Run "cmd /c """ & cmd & """", 0, False
