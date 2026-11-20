import { hostLog, hostWarn } from "./host-log.js"
import { windowsHelper, windowsHelperLines } from "./windows-helper.js"

/**
 * Narrows the DACL Node gives a listening pipe (everyone and anonymous may open it to read; Node can set neither its
 * own DACL nor `PIPE_REJECT_REMOTE_CLIENTS`) to its owner's alone, with every network logon denied:
 * `D:P(D;;FA;;;NU)(A;;FA;;;SY)(A;;FA;;;<user>)`, by `mako-windows secure-pipe`. Its owner opens a handle with `WRITE_DAC`
 * and sets it there; a pipe's security is its name's, so every instance made later keeps it.
 *
 * This is hardening, not the guarantee: a pipe is open to read for a moment before it runs, and where the helper is
 * missing it never runs. What keeps every client safe is the handshake both ends of every connection prove themselves
 * with (`@mako/sessions/private-pipe`).
 */
export async function restrictPipe(pipes: readonly string[], what: string): Promise<void> {
  if (!windowsHelper()) {
    hostLog("pipes", "a pipe keeps Windows' default DACL: mako-windows.exe isn't installed; its handshake still guards it", { what })
    return
  }
  const said = await windowsHelperLines(["secure-pipe", ...pipes])
  if (said?.length === pipes.length && said.every((line) => line === "secured")) hostLog("pipes", "a pipe's DACL is its owner's alone", { what })
  else hostWarn("pipes", "a pipe keeps Windows' default DACL; its handshake still guards it", { what, said: said?.join("; ") ?? "the helper failed" })
}
