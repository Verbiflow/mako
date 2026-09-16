import { z } from "zod"
import {
  BrowserFault,
  BrowserFaultSchema,
  type BrowserCommand,
} from "./contracts/browser-control.js"
import type { JsonValue } from "./codex-app-json.js"

const reply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({ ok: z.literal(false), fault: BrowserFaultSchema }),
])
export function browserControlClient(env: NodeJS.ProcessEnv = process.env) {
  const call = async (
    command: BrowserCommand,
    signal: AbortSignal
  ): Promise<JsonValue> => {
    const endpoint = env.MAKO_CONTROL_URL
    const token = env.MAKO_CONTROL_TOKEN
    if (!endpoint || !token)
      throw new BrowserFault({
        code: "unavailable",
        message:
          "Mako browser control is not attached to this provider session. Start or resume the task in Mako.",
        outcome: "not-dispatched",
      })
    const url = new URL(endpoint)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
      throw new Error("Mako control requires its private local endpoint")
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      signal,
    })
    if (!response.ok)
      throw new BrowserFault({
        code: "unavailable",
        message:
          "This Mako control grant is no longer active. Resume the task in Mako.",
        outcome: "not-dispatched",
      })
    if (!response.body) throw new Error("Browser control returned no body")
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > 32 * 1024 * 1024)
        throw new BrowserFault({
          code: "output-limit",
          message: "Browser response exceeded 32 MB. Request a smaller result.",
          outcome: "unknown",
        })
      chunks.push(chunk)
    }
    const value = reply.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8"))
    )
    if (!value.ok) throw new BrowserFault(value.fault)
    return value.value
  }
  return Object.assign(call, {
    async close(): Promise<void> {
      const endpoint = env.MAKO_CONTROL_URL
      const token = env.MAKO_CONTROL_TOKEN
      if (!endpoint || !token) return
      const url = new URL(endpoint)
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return
      url.pathname = `${url.pathname}/release-owner`
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined)
      if (!response?.ok) return
      const value = reply.parse(await response.json())
      if (!value.ok) throw new BrowserFault(value.fault)
    },
  })
}
