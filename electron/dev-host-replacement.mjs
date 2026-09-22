/** A host cannot relaunch into a different checkout: the launcher owns that
 * choice. Keep the same profile and wait for its owner to release it. */
export async function replaceDevHost({ original, probe, command, start, compatible, sleep, now = Date.now, timeoutMs = 60_000 }) {
  await command({ kind: "wait", action: "quit" })
  const deadline = now() + timeoutMs
  for (;;) {
    const current = await probe()
    if (current.state === "absent") {
      const runtime = await start()
      if (!compatible(runtime.info))
        throw new Error("Another launcher started a different Mako build in this profile. Close that launcher and try again.")
      return runtime
    }
    if (current.state === "ready" && current.info.instanceId !== original.instanceId) {
      if (compatible(current.info)) return { info: current.info }
      throw new Error("Another Mako build took over this profile. Close its launcher and try again.")
    }
    if (now() >= deadline) {
      // Do not leave a delayed quit behind after the launcher has given up.
      if (current.state === "ready" && current.info.instanceId === original.instanceId)
        await command({ kind: "cancel" })
      throw new Error("The previous Mako host is still finishing work. No agents were stopped. Run this command again after that work finishes.")
    }
    await sleep(250)
  }
}
