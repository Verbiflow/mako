import { Session } from "node:inspector/promises"
import { z } from "zod"

/** The profiler's sampling interval: fine enough for a launch of half a second, light enough to leave it be. */
const SAMPLE_US = 1_000

const Profile = z.object({
  profile: z.object({
    nodes: z.array(z.object({ id: z.number(), callFrame: z.object({ functionName: z.string(), url: z.string() }), hitCount: z.number().optional(), children: z.array(z.number()).optional() })),
    samples: z.array(z.number()).optional(),
    startTime: z.number(),
    endTime: z.number(),
  }),
})

/**
 * The host's own CPU while a window runs, by the file that spent it, from V8's sampling profiler in this process
 * (`node:inspector`, no port opened): what a launch's CPU line counts as the host, taken apart. One window at a time.
 */
export class HostProfiler {
  private session: Session | undefined

  /** Starts a window; false when one is already open or the profiler can't run. */
  async start(): Promise<boolean> {
    if (this.session) return false
    const session = new Session()
    try {
      session.connect()
      await session.post("Profiler.enable")
      await session.post("Profiler.setSamplingInterval", { interval: SAMPLE_US })
      await session.post("Profiler.start")
      this.session = session
      return true
    } catch {
      session.disconnect()
      return false
    }
  }

  /** Ends the window: the files that spent the most, in seconds, its `limit` busiest. */
  async stop(limit = 6): Promise<Array<{ file: string; seconds: number }> | undefined> {
    const session = this.session
    this.session = undefined
    if (!session) return undefined
    try {
      const { profile } = Profile.parse(await session.post("Profiler.stop"))
      const perSample = profile.samples?.length ? (profile.endTime - profile.startTime) / profile.samples.length / 1e6 : SAMPLE_US / 1e6
      const byId = new Map(profile.nodes.map((node) => [node.id, node]))
      const parents = new Map<number, number>()
      for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
      // A built-in's time (`Math.sqrt`, a native binding) and Node's own (`node:`) is the file's that called it.
      const owner = (id: number): string => {
        for (let at: number | undefined = id; at !== undefined; at = parents.get(at)) {
          const frame = byId.get(at)?.callFrame
          if (frame && ((frame.url && !frame.url.startsWith("node:")) || frame.functionName.startsWith("("))) return fileOf(frame)
        }
        return "node"
      }
      const byFile = new Map<string, number>()
      for (const node of profile.nodes) {
        if (!node.hitCount) continue
        const file = owner(node.id)
        if (file === "(idle)") continue
        byFile.set(file, (byFile.get(file) ?? 0) + node.hitCount * perSample)
      }
      return [...byFile].map(([file, seconds]) => ({ file, seconds })).filter((entry) => entry.seconds >= 0.005)
        .sort((a, b) => b.seconds - a.seconds).slice(0, limit)
    } catch {
      return undefined
    } finally {
      session.disconnect()
    }
  }
}

/** A frame's file as a person reads it: a package and its file, Mako's own file, or V8's name for what isn't JavaScript. */
function fileOf(frame: { functionName: string; url: string }): string {
  if (!frame.url) return frame.functionName.startsWith("(") ? frame.functionName : "(native)"
  const path = frame.url.replace(/^file:\/\//, "")
  const modules = path.lastIndexOf("/node_modules/")
  if (modules >= 0) {
    const parts = path.slice(modules + "/node_modules/".length).split("/")
    const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
    // Mako's own packages are linked into node_modules: name their file too.
    return name?.startsWith("@mako/") ? `${name}/${parts.slice(-1)[0]}` : name ?? path
  }
  return path.split("/").slice(-2).join("/")
}
