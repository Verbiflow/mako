import { z } from "zod"
import { decodeRuntimeValue } from "../contracts/runtime-value.js"
import type { AppMark } from "../contracts/thread-app.js"
import type { HostInvoke } from "../transport/index.js"

/** What `mako:thread-app-marks` answers, as far as a port request needs it. */
const AppMarksSchema = z.array(z.object({ state: z.string(), port: z.number().int().optional() }).loose()) satisfies z.ZodType<Array<Pick<AppMark, "port">>>

/** The ports this host's Threads' apps serve their pages on now: each running or starting app's first process's. */
export async function appPorts(invoke: (channel: string, args: unknown[], client: string, history: boolean) => ReturnType<HostInvoke>): Promise<ReadonlySet<number>> {
  const marks = AppMarksSchema.parse(decodeRuntimeValue(await invoke("mako:thread-app-marks", [], "gateway:ports", false)))
  return new Set(marks.flatMap((mark) => (mark.port !== undefined && (mark.state === "running" || mark.state === "starting") ? [mark.port] : [])))
}
