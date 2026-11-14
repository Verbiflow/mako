import type { Worker } from "node:worker_threads"
import type { ToWriter } from "./writer-protocol.js"

/**
 * A Git reader returns views into its input buffers. Structured cloning a
 * view copies its whole backing allocation, not only the requested bytes.
 * Give the writer one exact, owned buffer without detaching Git's cached one.
 */
export function postToWriter(port: Pick<Worker, "postMessage">, message: ToWriter): void {
  if (message.type === "host-reply" && message.ok && message.value instanceof Uint8Array) {
    const bytes = Uint8Array.from(message.value)
    port.postMessage({ ...message, value: bytes }, [bytes.buffer])
  } else port.postMessage(message)
}
