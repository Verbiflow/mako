# The primary display's scaling, read or changed for this session, as Settings > Display > Scale changes it: a step
# above (1, 2…) or back to (0) what Windows recommends for the display. Prints one JSON object: the override now in
# force (steps from the recommended scale) and the primary screen's size as a program that isn't DPI-aware sees it,
# which shrinks as the scale grows. A display too small for the step keeps its scale, and the output says so.
#
#   powershell -File display-scale.ps1            # report
#   powershell -File display-scale.ps1 -Step 1    # one step above the recommended scale, then report
param([int]$Step = -99)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MakoDisplayScale {
  [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint action, int param, ref int value, uint flags);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint action, int param, IntPtr value, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  // SPI_GETLOGICALDPIOVERRIDE: the steps below the recommended scale, as a negative number.
  public static int Override() { int value = 0; SystemParametersInfo(0x009E, 0, ref value, 0); return -value; }
  // SPI_SETLOGICALDPIOVERRIDE, told to every window (SPIF_UPDATEINIFILE).
  public static bool Set(int step) { return SystemParametersInfo(0x009F, step, IntPtr.Zero, 1); }
  public static string Screen() { return GetSystemMetrics(0) + "x" + GetSystemMetrics(1); }
}
'@
$set = $null
if ($Step -ne -99) { $set = [MakoDisplayScale]::Set($Step); Start-Sleep -Seconds 2 }
[pscustomobject]@{ asked = $(if ($Step -ne -99) { $Step } else { $null }); set = $set; override = [MakoDisplayScale]::Override(); unawareScreen = [MakoDisplayScale]::Screen() } | ConvertTo-Json -Compress
