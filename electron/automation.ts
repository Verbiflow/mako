import { createServer, type Server } from "node:http"
import type { BrowserWindow } from "electron"

interface AutomationObject {
  [property: string]: AutomationValue
}

type AutomationValue =
  | AutomationObject
  | AutomationValue[]
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | undefined

type AutomationFailure = Error | AutomationValue

/**
 * A way to drive the window without touching the mouse.
 *
 * Verifying UI by synthesising clicks at screen coordinates works, but it
 * takes over the machine while it runs — the pointer moves, focus changes, and
 * whoever is using the computer is locked out for the duration. That is an
 * unacceptable way to check a button, and it is also fragile: it depends on
 * window position, on which app is frontmost, and on Chromium receiving a
 * click event that carries the right click-count field.
 *
 * This is the honest version. A loopback endpoint evaluates an expression in
 * the renderer and returns the result, so a check reads
 * `button.click()` / `document.querySelectorAll(...).length` instead of
 * "move to 881,541 and hope". Screenshots still work on a background window,
 * so the whole thing runs while the machine is in use.
 *
 * **Off unless asked for.** It requires a development build *and*
 * `MAKO_AUTOMATION=<port>` in the environment, and it binds to 127.0.0.1 only.
 * An endpoint that runs arbitrary code in the window is not something to leave
 * lying around, so it exists only when someone has explicitly turned it on for
 * this launch.
 */

let server: Server | null = null

export function installAutomation(window: BrowserWindow, isDev: boolean) {
  const port = Number(process.env.MAKO_AUTOMATION)
  // One endpoint for the first window that asks; a second would find the port taken.
  if (!isDev || !Number.isInteger(port) || port <= 0 || server) return

  server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/eval") {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const source = Buffer.concat(chunks).toString("utf8")
      window.webContents
        // `true` marks it as a user gesture, which some handlers require and
        // which a real click would have carried.
        .executeJavaScript(source, true)
        .then((value: AutomationValue) => {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ ok: true, value: value ?? null }))
        })
        .catch((error: AutomationFailure) => {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
          )
        })
    })
  })

  server.listen(port, "127.0.0.1", () => {
    console.log(`[automation] listening on 127.0.0.1:${port}`)
  })
  window.once("closed", () => {
    server?.close()
    server = null
  })
}
