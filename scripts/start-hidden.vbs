' Starts the Ardite server in the background without opening a window.
' The shortcut in the Windows Startup folder runs this at login.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run "node server.js", 0, False
