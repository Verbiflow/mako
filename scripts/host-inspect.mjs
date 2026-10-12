// What a running host has loaded and what it runs: its domains (state, why
// each loaded, how long it took, the modules it brought in), its recurring
// jobs (runs, failures, which are paused for want of a client), its event
// loop (how late its checks ran, and each hold with the work running then)
// and the heavy packages it has loaded, from its `/health` and `/packages`.
//
//   npm run host:inspect                       the installed app's host
//   npm run host:inspect -- --profile dev      a profile's host (dev, a sandbox, a fixture desk)
//   npm run host:inspect -- --socket <path>    the host on that socket
//   npm run host:inspect -- --json             the raw answers, for a script
import { request } from "node:http"
import { parseArgs } from "node:util"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"
import { RuntimeInfoSchema } from "@mako/host/contracts/runtime"

const { values: options } = parseArgs({
  options: {
    profile: { type: "string" },
    socket: { type: "string" },
    json: { type: "boolean", default: false },
  },
})

const socket = options.socket ?? runtimeLocation(runtimeDataRoot(appDataFolder(), { ...process.env, MAKO_PROFILE: options.profile ?? "" })).socket

const get = (path) => new Promise((resolve, reject) => {
  const call = request({ socketPath: socket, path }, (response) => {
    let body = ""
    response.on("data", (chunk) => (body += chunk))
    response.on("end", () => (response.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`${path} answered ${response.statusCode}`))))
  })
  call.on("error", (error) => reject(new Error(`No host answers on ${socket} (${error.message})`)))
  call.end()
})

try {
  const health = RuntimeInfoSchema.parse(await get("/health"))
  const packages = await get("/packages")
  if (options.json) {
    console.log(JSON.stringify({ health, packages }, null, 2))
  } else {
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
      for (const hold of holds.recent.toReversed())
        console.log(`  ${new Date(hold.at).toLocaleTimeString()}  ${hold.ms} ms  ${hold.during.join(", ") || "no named work"}`)
    }
    const loaded = packages.filter((entry) => entry.state !== "unloaded")
    console.log(`Heavy packages: ${loaded.length} of ${packages.length} loaded`)
    if (loaded.length) console.table(loaded.map((entry) => ({ package: entry.name, state: entry.state, for: entry.reason ?? "", ms: entry.ms ?? "" })))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
