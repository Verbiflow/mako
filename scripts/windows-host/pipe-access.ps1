# What another Windows user can do to a named pipe: the pipe's owner and DACL as SDDL, then, as a second local
# account made for the check and deleted after, whether it can open the pipe to write, to read only, or create an
# instance of its own under the same name. Prints one JSON object. The runner's account is an administrator, which
# it needs to make the account; the pipe's own user is whoever started the server.
#
#   pwsh -File pipe-access.ps1 -Pipe '\\.\pipe\mako-host-...'
param([Parameter(Mandatory = $true)][string]$Pipe)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MakoPipeAccess {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool LogonUser(string user, string domain, string password, int logonType, int provider, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool RevertToSelf();
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint outSize, uint inSize, uint timeout, IntPtr sa);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityInfo(IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
  static readonly IntPtr Invalid = new IntPtr(-1);

  // A pipe whose instances are all taken answers ERROR_PIPE_BUSY (231) until its server makes another: wait for one.
  static IntPtr Connect(string pipe, uint access) {
    for (int attempt = 0; ; attempt++) {
      IntPtr handle = CreateFile(pipe, access, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (handle != Invalid || Marshal.GetLastWin32Error() != 231 || attempt >= 100) return handle;
      System.Threading.Thread.Sleep(50);
    }
  }
  public static string Open(string pipe, uint access) {
    IntPtr handle = Connect(pipe, access);
    if (handle == Invalid) return "denied " + Marshal.GetLastWin32Error();
    CloseHandle(handle);
    return "opened";
  }
  public static string Instance(string pipe) {
    // PIPE_ACCESS_DUPLEX, byte mode, unlimited instances.
    IntPtr handle = CreateNamedPipe(pipe, 3, 0, 255, 4096, 4096, 0, IntPtr.Zero);
    if (handle == Invalid) return "denied " + Marshal.GetLastWin32Error();
    CloseHandle(handle);
    return "created";
  }
  public static string Sddl(string pipe) {
    IntPtr handle = Connect(pipe, 0x20000);
    if (handle == Invalid) return "unreadable " + Marshal.GetLastWin32Error();
    IntPtr descriptor;
    uint read = GetSecurityInfo(handle, 6, 0x5, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
    CloseHandle(handle);
    if (read != 0) return "unreadable " + read;
    IntPtr text; uint length;
    ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, 0x5, out text, out length);
    return Marshal.PtrToStringUni(text);
  }
  public delegate string Probe();
  public static string As(string user, string password, Probe probe) {
    IntPtr token;
    // Interactive first; a network logon where the runner's policy refuses it.
    if (!LogonUser(user, ".", password, 2, 0, out token) && !LogonUser(user, ".", password, 3, 0, out token))
      return "logon failed " + Marshal.GetLastWin32Error();
    if (!ImpersonateLoggedOnUser(token)) return "impersonation failed " + Marshal.GetLastWin32Error();
    try { return probe(); } finally { RevertToSelf(); CloseHandle(token); }
  }
}
'@

$user = 'makoprobe' + (Get-Random -Maximum 99999)
$password = 'Mk!' + [guid]::NewGuid().ToString('N') + 'a9Z'
$result = [ordered]@{ pipe = $Pipe; owner = "$env:USERDOMAIN\$env:USERNAME"; sddl = [MakoPipeAccess]::Sddl($Pipe) }
& net.exe user $user $password /add /y | Out-Null
try {
  $result.other = $user
  # GENERIC_READ | GENERIC_WRITE, as Node's client asks first; then GENERIC_WRITE alone; then GENERIC_READ alone.
  $result.readWrite = [MakoPipeAccess]::As($user, $password, { [MakoPipeAccess]::Open($Pipe, [uint32]'0xC0000000') })
  $result.writeOnly = [MakoPipeAccess]::As($user, $password, { [MakoPipeAccess]::Open($Pipe, [uint32]'0x40000000') })
  $result.readOnly = [MakoPipeAccess]::As($user, $password, { [MakoPipeAccess]::Open($Pipe, [uint32]'0x80000000') })
  $result.newInstance = [MakoPipeAccess]::As($user, $password, { [MakoPipeAccess]::Instance($Pipe) })
} finally {
  & net.exe user $user /delete | Out-Null
}
$result | ConvertTo-Json -Compress
