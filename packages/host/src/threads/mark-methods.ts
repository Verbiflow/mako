import { z } from "zod"
import type { MethodTable } from "../base/methods.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { ThreadMarkChangeSchema, type ThreadMarkChange, type ThreadMarkEntry } from "../contracts/thread-marks.js"
import { ThreadIdSchema } from "../contracts/thread-identity.js"
import type { ThreadStore } from "./store.js"

const OperationIdSchema = z.string().uuid()

/**
 * What the person marks Threads with, for every window: each Thread's workflow status and Mark as unread
 * (`contracts/thread-marks.ts`), and a change to them, receipted by its operation id so a repeat changes nothing again.
 * Every change is told to every window as `thread-marks`, and reaches the person's other devices with the Sessions
 * this host reports.
 */
export function declareThreadMarkMethods(methods: MethodTable, input: { store: ThreadStore | null; emit(event: HostEvent): void }) {
  const { store, emit } = input
  methods.handle("mako:thread-marks", (): ThreadMarkEntry[] => store?.marks() ?? [])
  methods.handle("mako:thread-mark", (operationId: string, thread: string, change: ThreadMarkChange): ThreadMarkEntry => {
    if (!store) throw new Error("This Mako couldn't open its Thread store, so it can't mark a Thread.")
    const entry = store.markThread({
      operationId: OperationIdSchema.parse(operationId),
      thread: ThreadIdSchema.parse(thread),
      change: ThreadMarkChangeSchema.parse(change),
      actor: store.person(),
    })
    emit({ type: "thread-marks", marks: [entry] })
    return entry
  })
}
