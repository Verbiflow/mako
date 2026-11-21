# Sends a console event to the console a process owns, as a person does at its window: Ctrl-Break (Node hears SIGBREAK),
# or the window's close button (Node hears SIGHUP, and Windows ends the process a few seconds later). This script
# leaves its own console, attaches to the target's, ignores the event itself, and sends it. Prints "sent <event>" or
# why not. The target must own a console of its own: one shared with this script's caller would take the caller too.
#
#   powershell -File console-signal.ps1 -ProcessId 1234 -Signal break|close
param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)][ValidateSet('break', 'close')][string]$Signal)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MakoConsoleSignal {
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  delegate bool Handler(uint ctrlEvent);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
  // Kept for the life of the process: Windows calls it on a thread of its own.
  static readonly Handler ignore = delegate(uint ctrlEvent) { return true; };
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  public static string Send(uint pid, string what) {
    FreeConsole();
    if (!AttachConsole(pid)) return "attach failed " + Marshal.GetLastWin32Error();
    // This process, now in that console, handles what it sends by doing nothing (a null handler ignores only Ctrl-C).
    SetConsoleCtrlHandler(ignore, true);
    if (what == "break") {
      bool sent = GenerateConsoleCtrlEvent(1, 0);
      int error = Marshal.GetLastWin32Error();
      // Left before the host's console goes away with it.
      System.Threading.Thread.Sleep(300);
      FreeConsole();
      return sent ? "sent break" : "break failed " + error;
    }
    IntPtr window = GetConsoleWindow();
    if (window == IntPtr.Zero) return "no console window";
    // WM_CLOSE, as the window's close button.
    bool posted = PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
    FreeConsole();
    return posted ? "sent close" : "close failed " + Marshal.GetLastWin32Error();
  }
}
'@
[MakoConsoleSignal]::Send([uint32]$ProcessId, $Signal)
