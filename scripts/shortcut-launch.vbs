' Start DSH in the stored window shape, from a copy that outlives the package.
'
' Why this file exists. App-window mode needs a shortcut that starts THIS package's
' launcher, so adopting the desktop icon pointed it at
' `<profile>\node_modules\dsh-power-switch\scripts\launch-dsh.vbs`. Uninstalling the
' plugin then deleted the very file the icon named: the shortcut could not start DSH
' any more, and the tool that puts the original back lived in the same deleted
' package. A shortcut that only works while its installer is installed is not a
' shortcut anybody can trust.
'
' So the host copies this file into `$DSH_HOME/storages/dsh-power-switch/` on every
' boot, and the adopted shortcut points at THAT copy. This file then has two jobs:
'
'   1. the plugin is installed -- some harness home this launch could mean still has a
'      profile whose manifest names it and whose launcher is there: hand that launcher
'      the arguments this launch arrived with, wait, and forward its exit code. The
'      launch path is still the packaged one, so nothing about a normal start changes;
'   2. the plugin is gone -- no candidate home has such a profile: put the ORIGINAL
'      shortcut back from the record beside this file and say so. One more double-click
'      then starts DSH the way it did before the plugin was ever installed, with
'      nothing of this package left in the way.
'
' Nothing here is a fixed path: this file's own folder, the harness home resolved from
' the environment / the shortcut's `--home` / the documented default, DSH's own
' `profiles` directory, and `<profile>\node_modules\<package name>` for the launcher --
' which is where pnpm puts a direct dependency and where DSH says pnpm-managed entries
' stay authoritative. Every one of them is derived at run time, so an install under any
' user profile, drive or directory works the same way.
'
' Arguments: whatever the shortcut passes; only `--home <dir>` is read here, and it
' is forwarded untouched. Exit code: the launcher's, or 0 after a restore, or 1 when
' there was nothing left to put back.
Option Explicit

Dim shell, fso, here, homeDir, launcher, childArgs, exitCode, restore, at, q
Dim homes, index, messages, language

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

' One quote character, built once. Counting `""""` runs is how the first version of
' this file produced `"wscript.exe" "launcher.vbs--home"`, an unclosed quote that made
' wscript show a modal error no hidden launch can dismiss: the shortcut hung instead
' of starting anything.
q = Chr(34)

' The dialogs below are shown in the reader's language: the translations are loaded
' from the file the host writes beside this copy, and the English text in this file is
' the fallback whenever that file is missing or has no entry.
LoadMessages()

' Which harness home this launch belongs to is answered by looking, not by picking one
' and trusting it: every home the shortcut could mean is searched for a profile that
' still names this plugin, and the one that has it wins.
'
' A single winner would be wrong in both directions. Preferring the environment would
' let a DSH_HOME that changed after the shortcut was created hide an installed plugin
' -- and an icon that thinks the plugin is gone puts itself back while it is still
' there. Preferring the recorded `--home` would ignore a machine where the environment
' is the more recent statement, which is the rule both .vbs wrappers already follow.
homes = CandidateHomes()
homeDir = homes(0)
launcher = ""
For index = 0 To UBound(homes)
  If homes(index) <> "" Then
    launcher = FindLauncher(homes(index))
    If launcher <> "" Then
      homeDir = homes(index)
      Exit For
    End If
  End If
Next

If launcher <> "" Then
  ' Export the home the plugin was FOUND in, so the packaged wrapper cannot read a
  ' different state directory than the launcher it is handed: the mode record, the
  ' boot record and the log all live under that home.
  On Error Resume Next
  shell.Environment("Process")("DSH_HOME") = homeDir
  On Error GoTo 0
  ' Every argument is quoted on its own: this file runs wscript directly rather
  ' than through cmd, so the only quoting that matters is the one the child's own
  ' parser needs.
  childArgs = ""
  For at = 0 To WScript.Arguments.Count - 1
    childArgs = childArgs & " " & q & WScript.Arguments(at) & q
  Next
  exitCode = 0
  On Error Resume Next
  exitCode = shell.Run(q & HostExe() & q & " " & q & launcher & q & childArgs, 0, True)
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    MsgBox Msg("launch_failed", "The DSH launcher could not be started at all.") & vbCrLf & vbCrLf & _
      Msg("launcher_label", "launcher: ") & launcher, 16, "dsh-power-switch"
    WScript.Quit 1
  End If
  On Error GoTo 0
  ' Waiting (the third argument) is what makes the exit code available at all, and
  ' the packaged wrapper has already explained any failure in its own dialog --
  ' reporting it a second time here would only add a dialog nobody asked for.
  WScript.Quit exitCode
End If

' ------------------------------------------------------- the plugin is gone

' No launcher in any of the candidate homes: this package is uninstalled (or moved),
' and the record of the original shortcut is what is left. `restore-shortcut.vbs` sits
' beside this file for exactly this moment -- and it looks for the record beside ITSELF
' first, so no home has to be guessed here -- and /quiet keeps it from reporting twice,
' because the message below says everything a person needs to know.
restore = fso.BuildPath(here, "restore-shortcut.vbs")
exitCode = 1
If fso.FileExists(restore) Then
  On Error Resume Next
  exitCode = shell.Run(q & HostExe() & q & " " & q & restore & q & " /quiet", 0, True)
  If Err.Number <> 0 Then
    Err.Clear
    exitCode = 4
  End If
  On Error GoTo 0
End If

If exitCode = 0 Then
  MsgBox Msg("restored_title", "The plugin that changed this shortcut has been uninstalled, so the original launch method has been put back.") & vbCrLf & vbCrLf & _
    Msg("restored_advice", "Double-click the icon once more to start DSH the way you used to."), 64, "dsh-power-switch"
  WScript.Quit 0
End If

If exitCode = 1 Then
  MsgBox Msg("nothing_title", "The plugin that changed this shortcut has been uninstalled, and no record of the change was found, so there was nothing to put back.") & vbCrLf & vbCrLf & _
    Msg("nothing_advice", "This shortcut currently starts:") & vbCrLf & WScript.ScriptFullName & vbCrLf & vbCrLf & _
    Msg("nothing_advice2", "Delete it, or point it wherever you want DSH started from."), 48, "dsh-power-switch"
  WScript.Quit 1
End If

MsgBox Msg("failed_title", "The plugin that changed this shortcut has been uninstalled, and the original shortcut could not be put back.") & vbCrLf & vbCrLf & _
  Msg("failed_advice", "Run this file by hand:") & vbCrLf & restore, 16, "dsh-power-switch"
WScript.Quit 1

' ------------------------------------------------------------------ the dialogs

' Every message this file shows, in the language the person reads. The ENGLISH text
' is compiled in above as the fallback, and the translations live in a UTF-16 file the
' host writes beside this copy -- `<state>\shortcut-messages.txt` -- because a `.vbs`
' is read as ANSI: Chinese written into this file would land on screen as mojibake,
' and a UTF-16 script file would be a binary blob in the repository.
'
' The language is the Windows user interface language, because this is a Windows
' dialog; `DSH_POWER_SWITCH_LANG` overrides it for testing and for anyone who wants
' the other language.
Function Msg(key, fallback)
  Msg = fallback
  If messages.Exists(key & "." & language) Then Msg = messages(key & "." & language)
End Function

Sub LoadMessages()
  Dim file, stream, text, lines, i, line, pos, key
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
      For i = 0 To UBound(lines)
        line = lines(i)
        pos = InStr(line, "=")
        If pos > 0 Then
          key = Left(line, pos - 1)
          If Not messages.Exists(key) Then messages.Add key, Mid(line, pos + 1)
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

' ------------------------------------------------------------- the launcher

' The packaged launcher, or "" when no profile on this machine still has the plugin.
'
' Two things have to hold, and the second is the one that is easy to get wrong:
'
'   1. the profile carries the launcher file;
'   2. the profile MANIFEST still names the plugin -- `<profile>\package.json`, whose
'      `dependencies` and `dsh.profile.bundles` are what the host loads plugins from
'      and what `dsh plugin remove` rewrites.
'
' Requirement 2 is not decoration. Uninstalling a `link:` install leaves its junction
' behind in `node_modules`, so a leftover directory that still resolves would satisfy
' requirement 1 for ever: the shortcut would go on launching a plugin the profile no
' longer has, and the original shortcut would never be put back. Requirement 2 also
' covers the reverse, a checkout that moved: reinstall and the manifest names it
' again, wherever it now lives.
Function FindLauncher(homeDir)
  Dim folder, profile, candidate
  FindLauncher = ""
  On Error Resume Next
  Err.Clear
  If fso.FolderExists(fso.BuildPath(homeDir, "profiles")) Then
    Set folder = fso.GetFolder(fso.BuildPath(homeDir, "profiles"))
    For Each profile In folder.SubFolders
      candidate = fso.BuildPath(profile.Path, "node_modules\dsh-power-switch\scripts\launch-dsh.vbs")
      If fso.FileExists(candidate) Then
        If ProfileNamesPlugin(profile.Path) Then
          FindLauncher = candidate
          Exit For
        End If
      End If
    Next
  End If
  Err.Clear
  On Error GoTo 0
End Function

' Does this profile's manifest still name the plugin, in the bundles list the host
' reads? A cheap text search is enough for that -- and safer than pretending to parse
' JSON in VBScript -- as long as the name is looked for AFTER the `bundles` keyword:
' the list is the only place in the manifest the name belongs, and a name that comes
' after it is a name inside it.
'
' The file is read twice, once as ANSI and once as Unicode. It is ASCII-compatible in
' practice, but a UTF-16 manifest read as ANSI separates every character with a NUL,
' the name would never match, and the shortcut would put itself back while the plugin
' was still installed.
Function ProfileNamesPlugin(profileDir)
  Dim manifest, stream, text, pass
  ProfileNamesPlugin = False
  manifest = fso.BuildPath(profileDir, "package.json")
  If Not fso.FileExists(manifest) Then Exit Function
  For pass = 0 To 1
    text = ""
    On Error Resume Next
    Err.Clear
    Set stream = fso.OpenTextFile(manifest, 1, False, -pass)
    text = stream.ReadAll
    stream.Close
    If Err.Number <> 0 Then
      Err.Clear
      text = ""
    End If
    On Error GoTo 0
    If InStr(LCase(text), "bundles") > 0 Then
      If InStr(InStr(LCase(text), "bundles"), LCase(text), "dsh-power-switch") > 0 Then
        ProfileNamesPlugin = True
        Exit Function
      End If
    End If
  Next
End Function

' Every harness home this launch could belong to, most explicit first: an environment
' variable that is already set, the `--home` the shortcut carries, then the default
' location. Empty entries and duplicates are dropped, and the caller searches them in
' order -- the rule for READING the home is the one the two .vbs wrappers use, but the
' decision about which home is real is made by finding the plugin in it.
Function CandidateHomes()
  Dim homes(2), count
  count = 0
  count = AddHome(homes, count, ExpandHome(ResolveEnvHome()))
  count = AddHome(homes, count, ExpandHome(ResolveBakedHome()))
  count = AddHome(homes, count, fso.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), ".dsh"))
  CandidateHomes = homes
End Function

' Append one candidate, unless it is empty or already there. Arrays pass by reference
' in VBScript, so the caller's slots are filled in place.
Function AddHome(homes, count, value)
  Dim i
  AddHome = count
  value = Trim(value)
  If value = "" Then Exit Function
  For i = 0 To count - 1
    If LCase(homes(i)) = LCase(value) Then Exit Function
  Next
  homes(count) = value
  AddHome = count + 1
End Function

' A home spelled with a tilde has to be expanded by hand: left alone, the profile
' search would look in a directory literally named "~".
Function ExpandHome(value)
  ExpandHome = Trim(value)
  If Left(ExpandHome, 1) = "~" Then
    ExpandHome = fso.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), Mid(ExpandHome, 3))
  End If
End Function

' `%DSH_HOME%`, or "" when the variable is not set at all (ExpandEnvironmentStrings
' returns the name unchanged in that case).
Function ResolveEnvHome()
  Dim envHome
  envHome = ""
  On Error Resume Next
  envHome = shell.ExpandEnvironmentStrings("%DSH_HOME%")
  If envHome = "%DSH_HOME%" Then envHome = ""
  envHome = Trim(envHome)
  On Error GoTo 0
  ResolveEnvHome = envHome
End Function

' The `--home <dir>` (or `--home=<dir>`) the shortcut was created with.
Function ResolveBakedHome()
  Dim bakedHome, flag, at
  bakedHome = ""
  For at = 0 To WScript.Arguments.Count - 1
    flag = WScript.Arguments(at)
    If flag = "--home" Then
      If at + 1 <= WScript.Arguments.Count - 1 Then bakedHome = Trim(WScript.Arguments(at + 1))
    ElseIf Left(flag, 7) = "--home=" Then
      bakedHome = Trim(Mid(flag, 8))
    End If
  Next
  ResolveBakedHome = bakedHome
End Function

' The script host this file is already running on. Asking the running process beats
' assuming `wscript.exe` is on a PATH that a double-clicked shortcut may not carry.
Function HostExe()
  HostExe = WScript.FullName
  If HostExe = "" Then HostExe = "wscript.exe"
End Function
