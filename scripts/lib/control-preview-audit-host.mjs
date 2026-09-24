// Private acceptance process; test-only commands never enter the app registry.
import assert from "node:assert/strict"
import { BrowserService } from "@mako/control-runtime/browser"
import { BrowserCommandSchema } from "@mako/control-runtime/contracts"
import { extensionBrowsers } from "../../packages/control-runtime/dist/browser-extension-registration.js"
import { ControlPreviews } from "../../dist-electron/control-previews.js"
import { startWebHost } from "../../dist-electron/web-host.js"
import { hostCallInputs } from "../../dist-electron/contracts/host-call-inputs.js"

let close = () => {}
process.once(
  "message",
  async ({ socket, definition, extension, preferencePath, focusPolicy }) => {
    try {
      const definitions = extension
        ? (await extensionBrowsers()).filter((value) => value.id === extension)
        : [{ ...definition, endpoint: async () => definition.endpoint }]
      assert.equal(
        definitions.length,
        1,
        "The exact requested browser must be available"
      )
      const browser = new BrowserService(definitions, {
        preferencePath,
        focusPolicy,
      })
      const subscribe = browser.previewStream.bind(browser)
      browser.previewStream = (owner, target, authorize, frame, ended) => {
        console.error("Fixture capture subscribing")
        let count = 0
        return subscribe(
          owner,
          target,
          authorize,
          (value) => {
            if (++count === 1)
              console.error(
                "Fixture first capture frame:",
                value.width,
                value.height
              )
            frame(value)
          },
          (reason) => {
            console.error("Fixture capture ended:", reason)
            ended(reason)
          }
        ).catch((error) => {
          console.error("Fixture capture startup:", error.message)
          throw error
        })
      }
      const previews = new ControlPreviews(
        browser,
        (image) => image,
        (activity) => host.event({ type: "control-activity", activity })
      )
      let active = true
      const host = await startWebHost(
        socket,
        async (channel, args) => {
          if (
            channel === "mako:control-preview" ||
            channel === "mako:audit-preview"
          ) {
            const [id, watching, watcher] =
              hostCallInputs["mako:control-preview"].parse(args)
            assert.equal(id, "preview-audit")
            const value = previews.read(id, watching, watcher)
            return JSON.stringify({ ok: true, value: watching ? value : null })
          }
          if (channel === "mako:audit-cpu")
            return JSON.stringify({ ok: true, value: process.cpuUsage() })
          assert.equal(channel, "mako:audit-browser")
          const command = BrowserCommandSchema.parse(args[0])
          const value = await browser.execute(
            "preview-audit",
            command,
            AbortSignal.timeout(10_000)
          )
          if (command.action === "open") {
            previews.observe({
              conversationId: "preview-audit",
              kind: "browser",
              operation: "observe",
              target: `${value.browser}:${value.tab}`,
              status: "observed",
            })
            previews.browserTarget(
              "preview-audit",
              {
                browser: value.browser,
                tab: value.tab,
                generation: value.generation,
                lease: value.lease,
              },
              () => {
                assert.ok(active, "Fixture owner ended")
              }
            )
          }
          return JSON.stringify({ ok: true, value })
        },
        async () => new Response("Not found", { status: 404 })
      )
      let closing = false
      close = () => {
        if (closing) return
        closing = true
        active = false
        previews.close()
        browser.close()
        host.close()
        if (process.connected) process.disconnect()
      }
      process.send({ ready: true })
      process.once("message", close)
    } catch (error) {
      console.error(error)
      process.exitCode = 1
      process.disconnect()
    }
  }
)
process.once("SIGTERM", () => close())

process.once("disconnect", () => close())
