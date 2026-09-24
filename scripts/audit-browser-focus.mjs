import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BrowserService } from "@mako/control-runtime/browser"
import { extensionBrowsers } from "../packages/control-runtime/dist/browser-extension-registration.js"

// Explicit exact regular-profile target; owns only tabs it creates.
const id = process.argv[2]
assert.ok(id, "Pass an exact installed extension browser ID")
const root = await mkdtemp(join(tmpdir(), "mako-focus-restoration-"))
const definitions = (await extensionBrowsers()).filter(
  (browser) => browser.id === id
)
assert.equal(definitions.length, 1)
const browser = new BrowserService(definitions, {
  preferencePath: join(root, "preferences.json"),
})
const run = (command) =>
  browser.execute("focus-restoration", command, AbortSignal.timeout(10000))
const server = createServer((_req, res) =>
  res.end(
    '<input><button onclick="this.textContent=\'Saved\'">Save</button><script>let t=0;function f(){document.body.style.background=t++%2?"#eee":"#ddd";requestAnimationFrame(f)}f()</script>'
  )
)
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const results = []
try {
  await run({ action: "connect", browser: id })
  for (const mode of ["capture", "click", "screenshot", "transport-loss"]) {
    let target
    try {
      const opened = await run({
        action: "open",
        browser: id,
        url: `http://127.0.0.1:${server.address().port}`,
        lifetime: "persistent",
      })
      target = {
        browser: opened.browser,
        tab: opened.tab,
        generation: opened.generation,
        lease: opened.lease,
      }
      const state = async () =>
        (
          await run({
            action: "cdp",
            target,
            method: "Runtime.evaluate",
            params: {
              expression:
                "({visibility:document.visibilityState,focus:document.hasFocus()})",
              returnByValue: true,
            },
          })
        ).result.value
      const result = { mode, target, initial: await state() }
      results.push(result)
      await writeFile(
        join(root, "result.json"),
        JSON.stringify(results, null, 2)
      )
      let frames = 0
      const release = await browser.previewStream(
        "focus-restoration",
        target,
        () => {},
        () => {
          frames++
        },
        () => {}
      )
      await delay(500)
      result.during = await state()
      if (mode === "click")
        await run({ action: "click", target, at: { x: 30, y: 15 } })
      if (mode === "screenshot")
        await run({
          action: "cdp",
          target,
          method: "Page.captureScreenshot",
          params: { format: "png" },
        })
      if (mode === "transport-loss") {
        const binding = [...browser.bindings.values()].find(
          (binding) => binding.target.tab === target.tab
        )
        binding.connection.close()
        await delay(500)
        await run({ action: "connect", browser: id })
        target = await run({ action: "select", browser: id, tab: target.tab })
      }
      await release()
      await delay(200)
      result.after = await state()
      result.frames = frames
      await run({ action: "release", target })
      target = await run({ action: "select", browser: id, tab: target.tab })
      result.afterDetach = await state()
      if (mode !== "click")
        assert.deepEqual(
          result.after,
          result.initial,
          `${mode} restores page focus and visibility`
        )
      assert.ok(frames > 0, `${mode} receives actual frames`)
      console.log(JSON.stringify(result))
    } finally {
      if (target)
        await run({ action: "close", target })
          .catch(async () => {
            // Only reclaim this fixture's known target; never choose a replacement.
            await run({ action: "connect", browser: id })
            const exact = await run({
              action: "select",
              browser: id,
              tab: target.tab,
            })
            await run({ action: "close", target: exact })
          })
          .catch(() => {})
    }
  }
} finally {
  browser.close()
  server.close()
  await writeFile(join(root, "result.json"), JSON.stringify(results, null, 2))
  console.log(root)
}
