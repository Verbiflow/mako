/** A host cannot relaunch into a different checkout: the launcher owns that
 * choice. Keep the same profile and wait for its owner to release it. */
export async function replaceDevHost({ original, probe, command, readState, start, compatible, sleep, report = () => {}, now = Date.now, timeoutMs = 60_000 }) {
  let lifecycle = await command({ kind: "wait", action: "quit" })
  let reported = ""
  const inspect = () => {
    if (lifecycle.operation.kind === "error")
      throw new Error(`The previous Mako host could not close: ${lifecycle.operation.message}`)
    if (lifecycle.operation.kind === "idle")
      throw new Error("The host replacement was cancelled in another Mako client. No replacement was started.")
    if (lifecycle.operation.action !== "quit")
      throw new Error("Another Mako lifecycle operation replaced this shutdown request. No replacement was started.")
    const detail = describeWaiting(lifecycle)
    if (detail !== reported) { reported = detail; report(detail) }
  }
  inspect()
  const deadline = now() + timeoutMs
  let nextStatus = now() + 1000
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
    if (current.state === "ready" && (now() >= nextStatus || now() >= deadline)) {
      lifecycle = await readState()
      inspect()
      nextStatus = now() + 1000
    }
    if (now() >= deadline) {
      // Do not leave a delayed quit behind after the launcher has given up.
      if (current.state === "ready" && current.info.instanceId === original.instanceId && lifecycle.operation.kind === "waiting")
        await command({ kind: "cancel" })
      throw new Error(`${describeWaiting(lifecycle)} No agents were stopped. ${lifecycle.work.length ? "Finish or pause the listed work in Mako, then run this command again." : "Review Mako's shutdown status before trying again."}`)
    }
    await sleep(250)
  }
}

function describeWaiting(state) {
  if (!state.work.length) return "The previous Mako host has no active agents; it is still saving conversations or closing its windows."
  const work = state.work.slice(0, 5).map(item =>
    `${item.provider || "Mako"}: ${item.title.replace(/\s+/g, " ").slice(0, 160)} (${item.status}, ${item.id})`
  )
  if (state.work.length > work.length) work.push(`${state.work.length - work.length} more operations`)
  return `The previous Mako host is waiting for ${state.work.length} operation${state.work.length === 1 ? "" : "s"}:\n${work.map(item => `  - ${item}`).join("\n")}`
}
