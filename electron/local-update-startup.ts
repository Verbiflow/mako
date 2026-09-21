import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { BuildIdentitySchema } from "./contracts/app-lifecycle.js"
import { RuntimeInfoSchema, RuntimeReplySchema } from "./contracts/runtime.js"
import { runtimeRequest } from "./runtime-connection.js"

const installation = z.object({ build: BuildIdentitySchema.nullable() })

/** Runs from a private, bundled copy after the app that installed it exits. */
export async function verifyLocalStartup(input: {
  socket: string
  build: string
  previousPid: number
  timeoutMs?: number
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 45_000)
  let reason = "The new host did not answer."
  while (Date.now() < deadline) {
    try {
      const timeoutMs = Math.max(1, Math.min(1000, deadline - Date.now()))
      const host = await runtimeRequest({ socket: input.socket, path: "/health", schema: RuntimeInfoSchema, timeoutMs })
      if (host.pid === input.previousPid) throw new Error("The previous host is still answering.")
      const reply = await runtimeRequest({
        socket: input.socket, path: "/rpc", schema: RuntimeReplySchema,
        client: randomUUID(), timeoutMs,
        body: { channel: "mako:installation-state", args: [] },
      })
      if (!reply.ok) throw new Error(reply.error)
      const state = installation.parse(reply.value)
      if (state.build?.id !== input.build) throw new Error("The host reported a different build.")
      return
    } catch (error) {
      reason = error instanceof Error ? error.message : "Startup verification failed."
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`Mako startup was not verified. ${reason}`)
}
