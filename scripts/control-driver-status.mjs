// What a running host's computer-use driver is doing, in one command: the
// daemon, every consumer leasing a connection from the driver broker (the
// person's Appshots, each task's session), the calls in flight and the last
// ones with their timings, and the processes on the driver's side with their
// memory. Content-free: tool names, windows by pid:id, sizes and outcomes.
//
//   npm run control:driver                    the installed app's host
//   npm run control:driver -- --profile dev   a profile's host (`npm run dev`)
//   npm run control:driver -- --data-root D   the host of data root D
//   npm run control:driver -- --json          the raw readout
//   npm run control:driver -- --watch         again every second
import { randomUUID } from "node:crypto"
import { parseArgs } from "node:util"
import { invokeRuntime } from "@mako/host/transport/connection"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"
import { driverReadout } from "./lib/driver-readout.mjs"

const { values: options } = parseArgs({
  options: {
    profile: { type: "string" },
    "data-root": { type: "string" },
    json: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
    recent: { type: "string", default: "12" },
  },
})
const dataRoot =
  options["data-root"] ?? runtimeDataRoot(appDataFolder(), options.profile ? { ...process.env, MAKO_DATA_ROOT: undefined, MAKO_PROFILE: options.profile } : process.env)
const { socket } = runtimeLocation(dataRoot)
const client = randomUUID()

async function read() {
  try {
    return await invokeRuntime(socket, client, "mako:computer-driver-connections", [])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(
      /Unknown|unsupported|not declared/i.test(reason)
        ? `The host at ${dataRoot} is older than the driver broker; restart it on this build.`
        : `No host answered at ${socket} (${reason}). Is Mako running on this data root?`
    )
    process.exit(1)
  }
}

do {
  const status = await read()
  if (options.json) console.log(JSON.stringify(status, null, 2))
  else {
    if (options.watch) process.stdout.write("\x1b[2J\x1b[H")
    console.log(driverReadout(status, { recent: Number(options.recent) }))
  }
  if (options.watch) await new Promise((done) => setTimeout(done, 1000))
} while (options.watch)
