import { parseArgs } from "node:util"
import { RuntimeInfoSchema, RuntimePackagesSchema } from "./contracts/runtime.js"
import { appDataFolder, jsonBody, runtimeDataRoot, runtimeLocation, runtimeRequest } from "./transport/index.js"

const USAGE = `Usage: mako-host inspect [--profile <name> | --data-root <dir> | --socket <path>] [--json]

What a running host has loaded and what it runs: its domains (state, why each
loaded, how long it took, the modules it brought in), its recurring jobs, its
event loop (how late its checks ran, and each hold with the work running then)
and the heavy packages it has loaded, from its /health and /packages.

  (no option)         the installed app's host, or MAKO_DATA_ROOT's
  --profile <name>    a profile's host: dev, a sandbox, a fixture desk
  --data-root <dir>   the host of that data root, as a machine runs it
  --socket <path>     the host on that socket
  --json              the raw answers, for a script`

/** Prints what the host answers, and returns the process's exit code. */
export async function inspectHost(args: string[]): Promise<number> {
  const { values: options } = parseArgs({
    args,
    options: {
      profile: { type: "string" },
      "data-root": { type: "string" },
      socket: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const env = { ...process.env, MAKO_PROFILE: options.profile ?? "", MAKO_DATA_ROOT: options["data-root"] ?? process.env.MAKO_DATA_ROOT }
  const socket = options.socket ?? runtimeLocation(runtimeDataRoot(appDataFolder(env), env)).socket
  try {
    const health = await runtimeRequest({ socket, path: "/health", read: jsonBody(RuntimeInfoSchema), timeoutMs: 5_000 })
    const packages = await runtimeRequest({ socket, path: "/packages", read: jsonBody(RuntimePackagesSchema), timeoutMs: 5_000 })
    if (options.json) {
      console.log(JSON.stringify({ health, packages }, null, 2))
      return 0
    }
    console.log(`Host ${health.pid}, version ${health.version}${health.devBuild ? `, dev build ${health.devBuild.slice(0, 12)}` : ""}${health.fixture ? ", fixture desk" : ""}, on ${socket}`)
    console.log("\nDomains")
    console.table((health.domains ?? []).map((domain) => ({
      domain: domain.name,
      loads: domain.load,
      state: domain.state,
      for: domain.reason ?? "",
      ms: domain.loadMs ?? "",
      modules: domain.modules ?? "",
      KB: domain.sourceBytes === undefined ? "" : Math.round(domain.sourceBytes / 1024),
      ...(domain.error && { error: domain.error }),
    })))
    console.log("Jobs")
    console.table((health.jobs ?? []).map((job) => ({
      job: job.name,
      every: job.everyMs >= 60_000 ? `${job.everyMs / 60_000} min` : `${job.everyMs / 1000} s`,
      runs: job.runs,
      failures: job.failures,
      state: job.paused ? `paused: needs ${job.needs?.join(" or ")}` : "scheduled",
      ...(job.lastError && { lastError: job.lastError }),
    })))
    const loop = health.eventLoop
    if (loop) {
      const { delayMs, holds } = loop
      console.log(`Event loop: ${loop.watching ? "watched now" : "unwatched, nothing running"}; busy ${Math.round(loop.utilization * 1000) / 10}% of the time since start`)
      console.log(`  ${delayMs.checks} checks every ${loop.resolutionMs} ms while working, late by p50 ${delayMs.p50} ms, p99 ${delayMs.p99}, at most ${delayMs.max}`)
      console.log(`  ${holds.count} hold${holds.count === 1 ? "" : "s"} of ${loop.heldMs} ms or more${holds.longest ? `; the longest ${holds.longest.ms} ms, during ${holds.longest.during.join(", ") || "no named work"}` : ""}`)
      for (const hold of [...holds.recent].reverse())
        console.log(`  ${new Date(hold.at).toLocaleTimeString()}  ${hold.ms} ms  ${hold.during.join(", ") || "no named work"}`)
    }
    const loaded = packages.filter((entry) => entry.state !== "unloaded")
    console.log(`Heavy packages: ${loaded.length} of ${packages.length} loaded`)
    if (loaded.length) console.table(loaded.map((entry) => ({ package: entry.name, state: entry.state, for: entry.reason ?? "", ms: entry.ms ?? "" })))
    return 0
  } catch (error) {
    console.error(`mako-host inspect: the host on ${socket}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
