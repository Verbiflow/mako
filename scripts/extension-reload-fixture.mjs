import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

// Fault injection into a disposable browser only. Task commands still use the
// Native Messaging extension transport; this is never a product fallback.
export async function reloadExtensionFixture(
  profile,
  extensionId,
  registration,
  previousEndpoint
) {
  const [port, path] = (
    await readFile(join(profile, "DevToolsActivePort"), "utf8")
  )
    .trim()
    .split("\n")
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  let next = 0
  const pending = new Map()
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data))
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Fixture debugger timeout: ${method}`))
      }, 5000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  const attachWorker = async () => {
    const { targetInfos } = await send("Target.getTargets")
    const worker = targetInfos.find(
      (t) =>
        t.type === "service_worker" &&
        t.url === `chrome-extension://${extensionId}/background.js`
    )
    assert.ok(worker, "The fixture extension worker is present")
    return (
      await send("Target.attachToTarget", {
        targetId: worker.targetId,
        flatten: true,
      })
    ).sessionId
  }
  try {
    // Chromium ignores the unsigned Developer-mode preference in a new
    // profile. Toggle the real settings control in this disposable fixture.
    const settings = await send("Target.createTarget", {
      url: "chrome://extensions",
    })
    const settingsSession = (
      await send("Target.attachToTarget", {
        targetId: settings.targetId,
        flatten: true,
      })
    ).sessionId
    const toggle =
      "document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar')?.shadowRoot?.querySelector('#devMode')"
    for (let attempt = 0; attempt < 50; attempt++) {
      const ready = await send(
        "Runtime.evaluate",
        { expression: `Boolean(${toggle})`, returnByValue: true },
        settingsSession
      )
      if (ready.result.value) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await send(
      "Runtime.evaluate",
      {
        expression: `{const toggle=${toggle};if(!toggle)throw Error('Developer mode control missing');if(toggle.getAttribute('aria-pressed')!=='true')toggle.click();}`,
      },
      settingsSession
    )
    const enabled = await send(
      "Runtime.evaluate",
      {
        expression: `${toggle}.getAttribute('aria-pressed')`,
        returnByValue: true,
      },
      settingsSession
    )
    assert.equal(enabled.result.value, "true")
    await send("Target.closeTarget", { targetId: settings.targetId })
    const worker = await attachWorker()
    await send(
      "Runtime.evaluate",
      { expression: "chrome.runtime.reload()" },
      worker
    ).catch(() => {})
    let updated
    for (let i = 0; i < 150; i++) {
      const current = await registration().catch(() => null)
      if (current && current.endpoint !== previousEndpoint) {
        updated = current
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(updated, "Forced extension reload must reconnect")
    const replacement = await attachWorker()
    const result = await send(
      "Runtime.evaluate",
      {
        expression: "chrome.storage.local.get('lastRecovery')",
        awaitPromise: true,
        returnByValue: true,
      },
      replacement
    )
    const recovery = result.result.value.lastRecovery
    assert.ok(recovery?.tabs > 0, "Reload preserves interrupted ownership")
    assert.equal(recovery.outcome, "unknown")
    assert.ok(
      recovery.needsInspection > 0,
      "Reload does not infer a browser incarnation from tab IDs"
    )
    return { registration: updated, recovery }
  } finally {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error("Fixture debugger closed"))
    }
    socket.close()
  }
}
