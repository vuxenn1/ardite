' Starts the Ardite server in the background without opening a window.
' Windows runs this at login (see lib/autostart.js); updates from Ardite 1.8 and older start the
' new version with it.
' Uses the Node.js bundled in runtime\ (release packages), otherwise the installed one.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
node = "node"
If fso.FileExists(root & "\runtime\node.exe") Then node = """" & root & "\runtime\node.exe"""
sh.Run node & " server.js", 0, False
