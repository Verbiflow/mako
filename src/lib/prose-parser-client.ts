import type { Root } from "hast"
import type { ProseParseReply } from "./parsed-markdown"

interface Work {
  owner: string
  text: string
  receive(tree: Root | null): void
  canceled: boolean
}
let worker: Worker | null = null
let unavailable = false
let active: Work | null = null
const queued = new Map<string, Work>()

export function requestProse(
  owner: string,
  text: string,
  receive: Work["receive"]
): void {
  const work: Work = { owner, text, receive, canceled: false }
  if (!globalThis.Worker || unavailable) {
    receive(null)
    return
  }
  queued.set(owner, work)
  pump()
}

export function cancelProse(owner: string): void {
  queued.delete(owner)
  if (active?.owner === owner) active.canceled = true
}

function pump(): void {
  if (active || unavailable) return
  const work = queued.values().next().value
  if (!work) return
  queued.delete(work.owner)
  active = work
  const channel = new MessageChannel()
  let completed = false
  const complete = (tree: Root | null) => {
    if (completed) return
    completed = true
    channel.port1.onmessage = null
    channel.port1.onmessageerror = null
    channel.port1.close()
    clearTimeout(timeout)
    if (worker) { worker.onerror = null; worker.onmessageerror = null }
    active = null
    if (!work.canceled) work.receive(tree)
    pump()
  }
  const failed = () => {
    unavailable = true
    worker?.terminate()
    worker = null
    complete(null)
    for (const pending of queued.values())
      if (!pending.canceled) pending.receive(null)
    queued.clear()
  }
  const timeout = setTimeout(failed, 30_000)
  channel.port1.onmessage = (event: MessageEvent<ProseParseReply>) =>
    complete(event.data.ok ? event.data.tree : null)
  channel.port1.onmessageerror = failed
  try {
    worker ??= new Worker(
      new URL("./prose-parser.worker.ts", import.meta.url),
      { type: "module" }
    )
    worker.onerror = (event) => {
      console.error("Markdown worker failed:", event.message)
      failed()
    }
    worker.onmessageerror = failed
    worker.postMessage({ text: work.text }, [channel.port2])
  } catch (error) {
    console.error("Markdown worker could not start:", error)
    failed()
  }
}
