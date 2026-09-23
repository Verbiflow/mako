import type { z } from "zod"
import type { ComputerObservationSchema } from "./contracts/control-preview.js"

type Observation = z.infer<typeof ComputerObservationSchema>

/** Conflate preview updates; delivery cannot hold up or fail a native tool call. */
export class ComputerObservationClient {
  private pending: Observation | undefined
  private sending: Promise<void> | undefined
  private closed = false
  private readonly env: NodeJS.ProcessEnv
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env
  }

  submit(observation: Observation) {
    if (
      this.closed ||
      !this.env.MAKO_CONTROL_URL ||
      !this.env.MAKO_CONTROL_TOKEN
    )
      return
    this.pending = observation
    this.sending ??= this.flush().finally(() => {
      this.sending = undefined
      if (this.pending) this.submit(this.pending)
    })
  }

  private async flush() {
    while (this.pending && !this.closed) {
      const value = this.pending
      this.pending = undefined
      try {
        const endpoint = new URL(this.env.MAKO_CONTROL_URL ?? "")
        if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1")
          return
        endpoint.pathname = "/computer-observation"
        await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.env.MAKO_CONTROL_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(value),
          signal: AbortSignal.timeout(1500),
        }).then((response) => response.body?.cancel())
      } catch {
        /* Agent output remains authoritative when its optional preview is unavailable. */
      }
    }
  }

  close() {
    this.closed = true
    this.pending = undefined
  }
}
