' Ardite sunucusunu pencere acmadan arka planda baslatir.
' Windows acilisinda "Baslangic" klasorundeki kisayol bunu calistirir.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run "node server.js", 0, False
