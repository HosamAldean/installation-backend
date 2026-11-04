// Deploy-Petra.exe -- double-click launcher for Deploy-Petra.ps1 (same folder).
// Build: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /out:..\Deploy-Petra.exe DeployPetra.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

class DeployPetra
{
    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(dir, "Deploy-Petra.ps1");
        if (!File.Exists(script))
        {
            Console.WriteLine("Deploy-Petra.ps1 not found next to the exe: " + script);
            Pause();
            return 1;
        }

        string passArgs = string.Join(" ", args.Select(a => a.Contains(" ") ? "\"" + a + "\"" : a));
        var psi = new ProcessStartInfo("powershell.exe",
            "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" " + passArgs)
        {
            UseShellExecute = false,
            WorkingDirectory = dir
        };

        Console.Title = "Deploy Petra -> PETRA-APP";
        int code;
        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            code = p.ExitCode;
        }

        Console.WriteLine();
        Console.WriteLine(code == 0 ? "Done." : "Deploy did NOT finish (exit code " + code + ").");
        Pause();
        return code;
    }

    static void Pause()
    {
        Console.WriteLine("Press Enter to close...");
        Console.ReadLine();
    }
}
