import { hostCommand } from "./host-command.js"
import { hostLog, hostWarn } from "./host-log.js"
import { makoLocalFolder } from "./kept-pipe.js"
import { errorMessage } from "./error-message.js"
import { windowsPowerShell } from "./system-tools.js"
import { join } from "node:path"

/**
 * Narrows the DACL Node gives a pipe (everyone and anonymous may open it to read; Node can set neither its own DACL
 * nor `PIPE_REJECT_REMOTE_CLIENTS`) to its owner's alone, with every network logon denied:
 * `D:P(D;;FA;;;NU)(A;;FA;;;SY)(A;;FA;;;<user>)`. Its owner opens a handle with `WRITE_DAC` and sets it there; a pipe's
 * security is its name's, so every instance made later keeps it (Windows CI holds both). It runs once the pipe
 * listens, in the background; until it has, the handshake (`pipe-handshake.ts`) is what keeps the pipe's clients safe,
 * as it is regardless. A pipe it couldn't narrow is said in the log and keeps working.
 */
const SOURCE = `
using System;
using System.Runtime.InteropServices;
public static class MakoPipeDaclV1 {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint SetSecurityInfo(IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  public static string Secure(string pipe, string sddl) {
    IntPtr handle = new IntPtr(-1);
    for (int attempt = 0; attempt < 200; attempt++) {
      // READ_CONTROL | WRITE_DAC, with SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: the server may not act as us.
      handle = CreateFile(pipe, 0x20000 | 0x40000, 0, IntPtr.Zero, 3, 0x00100000 | 0x00010000, IntPtr.Zero);
      if (handle != new IntPtr(-1) || Marshal.GetLastWin32Error() != 231) break;
      System.Threading.Thread.Sleep(25);
    }
    if (handle == new IntPtr(-1)) return "open failed " + Marshal.GetLastWin32Error();
    try {
      IntPtr descriptor, dacl; bool present, defaulted;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, IntPtr.Zero)) return "sddl failed " + Marshal.GetLastWin32Error();
      GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted);
      uint set = SetSecurityInfo(handle, 6, 0x4 | 0x80000000, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      return set == 0 ? "secured" : "set failed " + set;
    } finally { CloseHandle(handle); }
  }
}
`

/** The PowerShell that narrows `pipes`, compiling its helper once into the user's Mako folder and loading it after. */
/** A program to run, and its words. */
export interface PipeCommand {
  file: string
  args: string[]
}

export function pipeRestriction(pipes: readonly string[], env: NodeJS.ProcessEnv = process.env): PipeCommand {
  const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$dll = ${quoted(join(makoLocalFolder(env), "pipe-dacl-v1.dll"))}`,
    "if (-not (Test-Path $dll)) {",
    "  New-Item -ItemType Directory -Force -Path (Split-Path $dll) | Out-Null",
    "  $draft = \"$dll.$PID.tmp\"",
    `  Add-Type -TypeDefinition ${quoted(SOURCE)} -OutputAssembly $draft`,
    "  try { Move-Item -Force $draft $dll } catch { Remove-Item -Force $draft -ErrorAction SilentlyContinue }",
    "}",
    "Add-Type -Path $dll",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    `foreach ($pipe in @(${pipes.map(quoted).join(", ")})) { [Console]::Out.WriteLine([MakoPipeDaclV1]::Secure($pipe, "D:P(D;;FA;;;NU)(A;;FA;;;SY)(A;;FA;;;$sid)")) }`,
  ].join("\n")
  return { file: windowsPowerShell(env), args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] }
}

export async function restrictPipe(pipes: readonly string[], what: string): Promise<void> {
  const command = pipeRestriction(pipes)
  try {
    const { stdout } = await hostCommand(command.file, command.args, { timeout: 60_000, windowsHide: true })
    const said = stdout.trim().split(/\r?\n/)
    if (said.length === pipes.length && said.every((line) => line === "secured")) hostLog("pipes", "made private to this user", { what })
    else hostWarn("pipes", "a pipe kept Windows' default access", { what, said: said.join("; ") })
  } catch (error) {
    hostWarn("pipes", "a pipe kept Windows' default access", { what, error: errorMessage({ error }) })
  }
}
