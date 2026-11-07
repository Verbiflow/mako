import "./lib/scratch-git.mjs"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomInt, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import type { Duplex } from "node:stream"
import { join, resolve } from "node:path"
import { connect as tlsConnect } from "node:tls"
import { promisify, parseArgs } from "node:util"
import { z } from "zod"
import { holdHostLease } from "@mako/host/base/host-idle"
import type { JsonValue } from "@mako/host/contracts/json"
import type { RuntimeValue } from "@mako/host/contracts/runtime"
import { invokeRuntime, runtimeInfo } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { assertOwnHarnessStores } from "./lib/proof-host.ts"
import { assertScratchEnvironment, seedScratchHome } from "./scratch-harness-home.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"
import { allowed, containerExec, localExec, markerOn, rejected, type Searched } from "./lib/placed-proof-evidence.ts"

/**
 * A Fin placed on another device, live against a deployed cloud: two hosts of this checkout's build (`mako-host`, as a
 * machine with no window runs it), each on a scratch home and data root of its own with no sign-in of the person's,
 * joined to one account as two devices with a code each (`mako-host join --name`), their OpenCode answered by a
 * scripted model on this computer. Whoever drives it confirms each code at the page it prints, as the person would.
 *
 * Then, with nothing asked of the driver until the last step:
 * - an Apex Thread starts on the first device, on OpenCode, in a clone of `--repository`;
 * - it starts a Fin with `place: device:<the second's name>`, which that device runs in its own clone of the same
 *   remote, in a worktree; the Fin's turn ends and its result wakes the Apex on the first device;
 * - the same start asked again answers the same Fin, and the Apex's list and read of it are answered by its device;
 * - a second Fin is held at its model while the first device is taken off the network (its relay cut, as a closed
 *   lid), finishes while it's off, and its notice waits on the second device; the first device, back, takes it once;
 * - a third Fin starts there on `ask`, and its harness asks to run a command. The report says who hears that: its
 *   Apex's device reads it as waiting on the person, its Apex can't allow it with `agents_answer`, and the person's
 *   answer from the Apex's Thread is refused, with where to go. Then the first device goes off the network again, so
 *   the Apex's device can't be what answers. The second device has no window, so it prints
 *   `ASK {"device","thread","name","title","question","apex"}` and waits ten minutes for a person to allow the command
 *   where they can: the Fin's own row, which its device writes to the account's list and every other device shows
 *   under its Apex, on the web or from another device. Allowed, the command runs there, which only the device can
 *   show: the command writes a marker file named for this run in the Fin's worktree, and the proof reads it back on
 *   the device itself (`docker exec` in a container), never taking the model's resumed word for it. The first device,
 *   back, takes the Fin's result and it wakes its Apex;
 * - a fourth Fin starts there on `ask` the same way, and the proof prints a second `ASK`, with `"decision": "reject"`:
 *   the person rejects it. Its turn ends without the command running, the marker it would have written is absent on
 *   the device, and the permission line its host logged says so; a marker found would fail the proof.
 *
 * Every word a turn is asked for is one only this run knows, so where each ran is plain: each device's scripted model
 * hears only its own device's turns. The report (`report.json`: each step with its time, the devices, Threads and
 * operations by their IDs, and both hosts' log lines for the calls between them with their correlation IDs) and both
 * hosts' logs go to `--out`. Both devices leave the account at the end, their hosts stop, and the root is removed
 * unless `--keep`.
 *
 * With `--image`, the second device is a Linux machine: a container of that image (the `device` stage of
 * `runtime/host/Dockerfile`), which joins as its entrypoint does and is reached only through the account, as any
 * machine is. The report then also says, from inside the container, its system, the clone its host made and the
 * Fin's worktree there; its host's log and the container's own go to `--out`, and the container and its volume are
 * removed at the end. `prove-fins-placed-linux.ts` builds that image from this checkout and runs this with it.
 *
 * `--account` says which kind of account the codes are confirmed on, and the run fails if the devices joined another:
 * `cloud` (the default), one with the cloud; or `free`, one without it, whose devices reach each other only where the
 * cloud gives every account the device network.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/prove-fins-placed.ts --root <empty folder> --out <folder> \
 *     --cloud https://… --relay-port <port> [--image <device image>] [--account cloud|free]
 *     [--repository https://github.com/octocat/Hello-World] [--keep]
 *
 * It prints `JOIN {"device","url","code"}` for each device, then `STEP …` lines, one `ASK …`, then `DONE {"ok",…}`.
 * Each code is confirmed at its page, and the ask answered in its Thread, within ten minutes, by a person signed in
 * to the account or by whatever reads these lines.
 */
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    out: { type: "string" },
    cloud: { type: "string" },
    "relay-port": { type: "string" },
    repository: { type: "string", default: "https://github.com/octocat/Hello-World" },
    keep: { type: "boolean", default: false },
    image: { type: "string" },
    account: { type: "string", default: "cloud" },
  },
})
if (!values.root || !values.out || !values.cloud || !values["relay-port"]) throw new Error("--root, --out, --cloud and --relay-port are required")
if (values.account !== "cloud" && values.account !== "free") throw new Error("--account is cloud or free")
const { image, account: accountKind } = values
const root = resolve(values.root)
const out = resolve(values.out)
const cloud = new URL(values.cloud)
if (cloud.protocol !== "https:") throw new Error("--cloud is a deployed gateway, on https")
const relayPort = Number(values["relay-port"])
if ((await readdir(root).catch(() => [])).length) throw new Error(`${root} isn't empty: give the proof a folder of its own`)
await mkdir(out, { recursive: true })
const run = promisify(execFile)
const say = (word: string, value?: JsonValue) => console.log(value === undefined ? word : `${word} ${JSON.stringify(value)}`)
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
// Letters alone: the scripted models hear "single word X" for X in capitals.
const tag = Array.from({ length: 5 }, () => String.fromCharCode(65 + randomInt(26))).join("")
const WORDS = { apex: `ALPHA${tag}`, fin: `FOXTROT${tag}`, held: `GOLF${tag}`, asks: `HOTEL${tag}`, deny: `INDIA${tag}` }
/** The file the asked command writes in the Fin's worktree, named for this run and its word, which only the device can show. */
const marker = (word: string) => `.mako-proof-${word}`
const ONE_WORD = /Reply with the single word ([A-Za-z0-9-]+)\./g
const mako = join(process.cwd(), "packages", "host", "dist", "mako-host.js")

/** What the report keeps of a step: its value as JSON carries it. */
const DetailSchema = z.json()
type Detail = z.infer<typeof DetailSchema>
type Step = { name: string; at: string; ms: number; ok: boolean; detail?: Detail; problem?: string }
const steps: Step[] = []
/** One step of the proof, timed; `describe` says what of its value the report keeps, all of it when absent. */
async function step<T, Kept = T>(name: string, work: () => Promise<T>, describe?: (value: T) => Kept): Promise<T> {
  const record: Step = { name, at: new Date().toISOString(), ms: 0, ok: false }
  steps.push(record)
  const began = performance.now()
  try {
    const value = await work()
    record.ok = true
    record.detail = DetailSchema.parse(JSON.parse(JSON.stringify(describe ? describe(value) : value ?? null)))
    return value
  } catch (error) {
    record.problem = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    record.ms = Math.round(performance.now() - began)
    say("STEP", { name, ok: record.ok, ms: record.ms, ...(record.problem && { problem: record.problem }) })
  }
}
async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 3 * 60_000): Promise<T> {
  for (const deadline = Date.now() + ms; ; await pause(250)) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${what} didn't happen within ${Math.round(ms / 1000)} s`)
  }
}

// The first device's network: an http relay on this computer's loopback to the cloud's https, sockets and all, so
// cutting it takes the device off the network while its host runs.
const carried = new Set<Duplex>()
const keep = (socket: Duplex) => {
  carried.add(socket)
  socket.once("close", () => carried.delete(socket))
  socket.on("error", () => socket.destroy())
}
const upstream = { host: cloud.hostname, port: Number(cloud.port) || 443 }
const relay = createServer((inbound, outbound) => {
  const onward = httpsRequest({ ...upstream, method: inbound.method, path: inbound.url, headers: { ...inbound.headers, host: cloud.host } }, (answer) => {
    outbound.writeHead(answer.statusCode ?? 502, answer.headers)
    answer.pipe(outbound)
  })
  onward.on("error", () => outbound.destroy())
  inbound.pipe(onward)
})
relay.on("connection", keep)
relay.on("upgrade", (inbound: IncomingMessage, socket: Duplex, head: Buffer) => {
  keep(socket)
  const onward = tlsConnect({ ...upstream, servername: cloud.hostname, ALPNProtocols: ["http/1.1"] }, () => {
    const lines = [`${inbound.method} ${inbound.url} HTTP/1.1`]
    for (let at = 0; at < inbound.rawHeaders.length; at += 2) {
      const name = inbound.rawHeaders[at]!
      lines.push(`${name}: ${name.toLowerCase() === "host" ? cloud.host : inbound.rawHeaders[at + 1]}`)
    }
    onward.write(`${lines.join("\r\n")}\r\n\r\n`)
    if (head.length) onward.write(head)
    socket.pipe(onward).pipe(socket)
  })
  keep(onward)
  onward.once("close", () => socket.destroy())
  socket.once("close", () => onward.destroy())
})
const listen = () => new Promise<void>((done, fail) => relay.once("error", fail).listen(relayPort, "127.0.0.1", () => (relay.off("error", fail), done())))
const cut = () => {
  const closed = new Promise<void>((done) => relay.close(() => done()))
  for (const socket of carried) socket.destroy()
  return closed
}
await listen()
const relayUrl = `http://127.0.0.1:${relayPort}`

/** A device of the proof: a scratch home, a data root, a scripted model for its OpenCode, and its host once joined. */
interface ProofDevice {
  name: string
  home: string
  dataRoot: string
  env: NodeJS.ProcessEnv
  heard: string[]
  call(channel: string, args: JsonValue[]): Promise<RuntimeValue>
  log(): Promise<string[]>
  /** A search of the device's data for a file of that name, on the device: found with what it holds, absent, or failed with why. */
  searched(name: string): Promise<Searched>
  stop(): Promise<void>
}

/** The second device as a Linux machine: a container of the device image, its host reached only through the account. */
interface ContainerDevice {
  name: string
  container: string
  heard: string[]
  /** A command inside the container, as its user: what it printed. */
  inside(command: string): Promise<string>
  log(): Promise<string[]>
  /** A search of the device's data for a file of that name, on the device: found with what it holds, absent, or failed with why. */
  searched(name: string): Promise<Searched>
  stop(): Promise<void>
}

async function docker(args: string[], input?: string): Promise<string> {
  const child = run("docker", args, { maxBuffer: 64 * 1024 * 1024 })
  if (input !== undefined) child.child.stdin?.end(input)
  return (await child).stdout
}

async function makeContainer(name: string, of: string): Promise<ContainerDevice> {
  const heard: string[] = []
  // Reached from inside the container at this computer's address there, so it listens on every interface.
  const model = await scriptedModel({
    host: "0.0.0.0",
    reply: answers(heard),
    aside: "Placed Fins proof",
  })
  const container = `mako-fins-proof-${tag.toLowerCase()}`
  const volume = `${container}-data`
  await docker(["volume", "create", volume])
  await docker(["run", "-d", "--init", "--platform", "linux/amd64", "--name", container, "-v", `${volume}:/data`, "-e", `MAKO_CLOUD_URL=${cloud.origin}`, "-e", "MAKO_GATEWAY_TRACE=1", "-e", "OPENCODE_DISABLE_MODELS_FETCH=1", "--add-host", "host.docker.internal:host-gateway", of, "--name", name])
  const inside = (command: string) => docker(["exec", container, "sh", "-c", command])
  /** Its host's log and the container's own, kept in `--out` before the container goes. */
  const keepLogs = async () => {
    await inside("cat /data/logs/host.log").then((log) => writeFile(join(out, "place.host.log"), log), () => undefined)
    await run("docker", ["logs", container]).then(({ stdout, stderr }) => writeFile(join(out, "place.container.log"), `${stdout}\n${stderr}`), () => undefined)
  }
  const remove = async () => {
    await docker(["rm", "-f", container]).catch(() => undefined)
    await docker(["volume", "rm", volume]).catch(() => undefined)
    await model.close()
  }
  try {
    // Its OpenCode answers from the scripted model on this computer, set before its host starts.
    const settings = JSON.stringify({ $schema: "https://opencode.ai/config.json", enabled_providers: ["anthropic"], provider: { anthropic: { options: { baseURL: `http://host.docker.internal:${new URL(model.url).port}/v1`, apiKey: "placed-fins-proof" } } } }, null, 2)
    await docker(["exec", "-i", container, "sh", "-c", "mkdir -p ~/.config/opencode && cat > ~/.config/opencode/opencode.json"], settings)
    // It joins as its entrypoint does (`mako-host join --name`): the code is in its log, for whoever drives the proof to confirm.
    const joined = await until(`${name}'s code`, async () => {
      const printed = (await run("docker", ["logs", container])).stdout
      const url = /^\s+(https?:\/\/\S+)$/m.exec(printed)?.[1]
      const code = /confirm the code (\S+) there/.exec(printed)?.[1]
      return url && code ? { url, code } : undefined
    })
    say("JOIN", { device: name, url: joined.url, code: joined.code })
    // Ten minutes for the code, then its host's own start.
    let status = ""
    await until(`${name}'s host`, async () => {
      // What it says is read however the command ends: a host still starting answers with why.
      status = await inside("mako-host status --json 2>&1 || true").catch((error: Error) => error.message)
      return /"connection": "connected"/.test(status) && /"host": "running/.test(status) ? true : undefined
    }, 12 * 60_000).catch((error: Error) => {
      throw new Error(`${error.message}; it last said: ${status.replace(/\s+/g, " ").slice(0, 600)}`)
    })
  } catch (error) {
    await keepLogs()
    await remove()
    throw error
  }
  return {
    name,
    container,
    heard,
    inside,
    log: async () => (await inside("cat /data/logs/host.log 2>/dev/null").catch(() => "")).split("\n").filter(Boolean),
    // Read on the device itself, by `find`'s own exit status: found, absent, or a search that couldn't look, which proves nothing.
    searched: (name) => markerOn(containerExec(container), "/data", name),
    stop: async () => {
      await keepLogs()
      await inside("mako-host leave").catch(() => undefined)
      await remove()
    },
  }
}

/**
 * What a device's scripted model answers: the word its turn was asked for, noted in `heard`. The held word waits at
 * the gate first; the asking word is answered first with a shell command, which a harness on `ask` puts to a person,
 * and with the word once that command's result comes back.
 */
function answers(heard: string[]): (text: string) => Promise<ScriptedReply> {
  const asked = new Set<string>()
  return async (text) => {
    const word = [...text.matchAll(ONE_WORD)].at(-1)?.[1]
    if (!word) return { text: "OK" }
    if (word === WORDS.held) await heldGate
    if ((word === WORDS.asks || word === WORDS.deny) && !asked.has(word)) {
      asked.add(word)
      // The command writes the run's marker where the Fin works: the device shows whether it ran, the model's word never does.
      return { text: "Running it.", call: { id: `call_${word.toLowerCase()}`, name: "shell", arguments: { command: `echo ${word} > ${marker(word)}` } } }
    }
    heard.push(word)
    return { text: word }
  }
}

/** A gate the second device's model waits at before it answers the held word, so its Fin finishes when the proof says. */
let releaseHeld: () => void = () => {}
const heldGate = new Promise<void>((resolve) => {
  releaseHeld = resolve
})

async function makeDevice(key: string, name: string, reach: string): Promise<ProofDevice> {
  const scratch = seedScratchHome(join(root, key), {}, { keep: values.keep })
  const home = scratch.home
  const heard: string[] = []
  const model = await scriptedModel({
    reply: answers(heard),
    aside: "Placed Fins proof",
  })
  await mkdir(join(home, ".config", "opencode"), { recursive: true })
  await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", enabled_providers: ["anthropic"], provider: { anthropic: { options: { baseURL: `${model.url}/v1`, apiKey: "placed-fins-proof" } } } }, null, 2))
  // Outside any application-data folder, so the host is isolated: its stores, its projects and its sign-in are its own.
  const dataRoot = join(home, "mako-data")
  const env: NodeJS.ProcessEnv = {
    ...scratch.env,
    MAKO_DATA_ROOT: dataRoot,
    MAKO_PROD: "1",
    MAKO_SCREENLESS: "1",
    // No keychain of the person's is touched: the sign-in is sealed by a key file in the scratch root, as on a server.
    MAKO_SECRET_KEY_FILE: join(root, key, "host-key"),
    MAKO_GATEWAY_TRACE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  }
  assertScratchEnvironment(env, `the proof's ${name}`)

  // Joins as `mako-host join` does: the code is printed for whoever drives the proof to confirm.
  const join_ = spawn(process.execPath, [mako, "join", "--name", name, "--cloud", reach], { env, stdio: ["ignore", "pipe", "pipe"] })
  let printed = ""
  let announced = false
  const joined = new Promise<void>((done, fail) => {
    const read = (chunk: Buffer) => {
      printed += chunk.toString()
      const url = /^\s+(https?:\/\/\S+)$/m.exec(printed)?.[1]
      const code = /confirm the code (\S+) there/.exec(printed)?.[1]
      if (url && code && !announced) {
        announced = true
        say("JOIN", { device: name, url: url.replace(relayUrl, cloud.origin), code })
      }
    }
    join_.stdout.on("data", read)
    join_.stderr.on("data", read)
    join_.once("exit", (exit) => (exit === 0 ? done() : fail(new Error(`mako-host join ended ${exit}: ${printed.trim().slice(-600)}`))))
  })
  await joined

  const hostLog = createWriteStream(join(out, `${key}.host.out`))
  const host: ChildProcess = spawn(process.execPath, [mako], { env, stdio: ["ignore", "pipe", "pipe"] })
  host.stdout?.pipe(hostLog)
  host.stderr?.pipe(hostLog)
  const location = runtimeLocation(dataRoot)
  for (const deadline = Date.now() + 90_000; !(await runtimeInfo(location.socket).catch(() => null)); await pause(250)) {
    if (host.exitCode !== null) throw new Error(`${name}'s host ended ${host.exitCode} as it started; its output is ${join(out, `${key}.host.out`)}`)
    if (Date.now() > deadline) throw new Error(`${name}'s host didn't start within 90 s`)
  }
  const release = await holdHostLease(location.directory)
  const client = randomUUID()
  const call = (channel: string, args: JsonValue[]) => invokeRuntime(location.socket, client, channel, args)
  await assertOwnHarnessStores((channel, args) => invokeRuntime(location.socket, client, channel, args), dataRoot)
  const logFile = join(dataRoot, "logs", "host.log")
  return {
    name,
    home,
    dataRoot,
    env,
    heard,
    call,
    log: async () => (await readFile(logFile, "utf8").catch(() => "")).split("\n").filter(Boolean),
    searched: (name) => markerOn(localExec, dataRoot, name),
    stop: async () => {
      await run(process.execPath, [mako, "leave"], { env }).catch(() => undefined)
      const exited = host.exitCode === null && host.signalCode === null ? new Promise((done) => host.once("exit", done)) : Promise.resolve()
      host.kill("SIGTERM")
      await Promise.race([exited, pause(30_000)])
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL")
      await release()
      await model.close()
      await copyFile(logFile, join(out, `${key}.host.log`)).catch(() => undefined)
      scratch.dispose()
    },
  }
}

const AccountSchema = z.object({ state: z.object({ status: z.string(), connection: z.string().optional(), device: z.object({ id: z.string(), name: z.string() }).loose().optional(), account: z.object({ entitlements: z.array(z.string()) }).loose().optional() }).loose() }).loose()
const SnapshotSchema = z.object({
  session: z.object({ cwd: z.string().nullish() }).loose(),
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
  requests: z.array(z.object({ id: z.string(), status: z.string(), text: z.string().optional(), error: z.string().optional(), digest: z.object({ notices: z.array(z.object({ id: z.string() }).loose()) }).loose().optional() }).loose()).default([]),
}).loose()
const StartedSchema = z.object({ child: z.string().optional(), name: z.string(), state: z.string(), place: z.string().optional(), note: z.string().optional(), deduped: z.boolean().optional(), refused: z.string().optional(), why: z.string().optional() }).loose()
const ListedSchema = z.object({ children: z.array(z.object({ child: z.string(), name: z.string(), place: z.string().optional(), state: z.object({ kind: z.string(), question: z.string().optional(), on: z.string().optional(), ask: z.object({ id: z.string(), kind: z.string() }).loose().optional() }).loose(), harness: z.string() }).loose()) }).loose()
const RefusedSchema = z.object({ refused: z.string().optional(), why: z.string().optional() }).loose()
const ReadSchema = z.object({ text: z.string(), state: z.object({ kind: z.string() }).loose() }).loose()

const devices: Array<Pick<ProofDevice, "name" | "stop">> = []
let ok = false
/** What the proof writes down: who took part, by their IDs, each step, and both hosts' lines for the calls between them. */
interface ProofReport {
  run: string
  cloud: string
  /** The kind of account the devices joined (`--account`), checked against what the cloud says of it. */
  account: string
  /** The device image the second device is a container of (`--image`); absent when both devices are hosts here. */
  image?: string
  words: typeof WORDS
  devices?: Detail
  apex?: Detail
  log?: { apex: string[]; place: string[] }
  worktree?: string
  steps: Step[]
  ok: boolean
}
const report: ProofReport = { run: tag, cloud: cloud.origin, account: accountKind, ...(image && { image }), words: WORDS, steps, ok: false }
try {
  const names = { apex: `proof-apex-${tag.toLowerCase()}`, place: `Proof-Place-${tag}` }
  // The first device reaches the cloud through the relay; the second directly.
  const apex = await step("the first device joins and its host starts", () => makeDevice("apex", names.apex, relayUrl), (made) => ({ name: made.name, dataRoot: made.dataRoot }))
  devices.push(apex)
  const second = image
    ? { kind: "container" as const, device: await step("the second device, a Linux container, joins and its host starts", () => makeContainer(names.place, image), (made) => ({ name: made.name, container: made.container, image })) }
    : { kind: "local" as const, device: await step("the second device joins and its host starts", () => makeDevice("place", names.place, cloud.origin), (made) => ({ name: made.name, dataRoot: made.dataRoot })) }
  const place = second.device
  devices.push(place)
  if (second.kind === "container") {
    const { inside } = second.device
    await step("inside the container: its system, its host and its device", async () => ({
      uname: (await inside("uname -srm")).trim(),
      os: (await inside('. /etc/os-release && echo "$PRETTY_NAME"')).trim(),
      node: (await inside("node --version")).trim(),
      status: (await inside("mako-host status")).trim().split("\n"),
    }))
  }

  const linked = async (device: ProofDevice) => until(`${device.name}'s links`, async () => {
    const account = AccountSchema.parse(await device.call("mako:cloud-account", []))
    return account.state.status === "signed-in" && account.state.connection === "connected" && account.state.device ? { ...account.state.device, entitlements: account.state.account?.entitlements ?? [] } : undefined
  })
  // The account's own list of its devices, as every device and the web read it.
  const DevicesSchema = z.object({ devices: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), platform: z.string(), appVersion: z.string().nullable(), enrolledBy: z.string() }).loose()) }).loose()
  const listed = await step("both devices are connected, and the account lists them", async () => {
    const first = await linked(apex)
    if (second.kind === "local") await linked(second.device)
    const all = DevicesSchema.parse(await apex.call("mako:cloud-devices", [])).devices.map(({ id, name, kind, platform, appVersion, enrolledBy }) => ({ id, name, kind, platform, appVersion, enrolledBy }))
    const other = all.find((device) => device.name === names.place)
    if (!other) throw new Error(`the account doesn't list ${names.place}: it lists ${all.map((device) => device.name).join(", ")}`)
    if (other.kind !== "runtime") throw new Error(`${names.place} is listed as ${other.kind}, not a runtime`)
    if (image && !/linux/i.test(other.platform)) throw new Error(`${names.place} is listed on ${other.platform}, not Linux`)
    const withCloud = first.entitlements.includes("cloud")
    if (withCloud !== (accountKind === "cloud"))
      throw new Error(`the codes were confirmed on ${withCloud ? "an account with the cloud" : "a free account"} (entitled to ${first.entitlements.join(", ") || "nothing"}), and --account ${accountKind} was asked`)
    return { account: { kind: accountKind, entitlements: first.entitlements }, apex: first, place: other, devices: all }
  })
  report.devices = DetailSchema.parse(JSON.parse(JSON.stringify(listed)))

  const project = join(apex.home, "projects", new URL(values.repository).pathname.split("/").at(-1) ?? "project")
  await step("the project is cloned on the first device only", async () => {
    await mkdir(join(apex.home, "projects"), { recursive: true })
    await run("git", ["clone", "-q", values.repository, project], { env: { ...apex.env } })
    return { project, remote: (await run("git", ["-C", project, "remote", "get-url", "origin"])).stdout.trim() }
  })

  const snapshot = async (device: ProofDevice, conversation: string) => SnapshotSchema.parse(await device.call("mako:live-snapshot", [conversation]))
  const apexConversation = randomUUID()
  const apexThread = await step("an Apex Thread starts on the first device, on OpenCode", async () => {
    const request = randomUUID()
    await apex.call("mako:live-start", ["opencode", project, { conversationId: apexConversation, title: `Placed Fins proof ${tag}`, initialRequest: { id: request, text: `Reply with the single word ${WORDS.apex}.`, attachments: [] } }])
    await until("the Apex's first turn", async () => {
      const status = (await snapshot(apex, apexConversation)).requests.find((entry) => entry.id === request)?.status
      if (status === "failed") throw new Error(`the Apex's first turn failed: ${JSON.stringify((await snapshot(apex, apexConversation)).requests)}`)
      return status === "completed" ? true : undefined
    })
    const shot = await snapshot(apex, apexConversation)
    if (!shot.sessionId || !shot.threadId) throw new Error("the Apex's conversation has no Thread")
    return { conversation: apexConversation, thread: shot.threadId, session: shot.sessionId, heard: [...apex.heard] }
  })
  const caller = { kind: "agent", session: apexThread.session }
  const digests = async () => (await snapshot(apex, apexConversation)).requests.filter((request) => request.digest)

  // Named in another case than the device's own: a place's name is taken whatever its case.
  const where = `device:${names.place.toLowerCase()}`
  const startedAt = Date.now()
  const fin = await step(`the Apex starts a Fin with place ${where}`, async () => {
    const answer = StartedSchema.parse(await apex.call("mako:agents-start", [caller, { brief: { objective: `Reply with the single word ${WORDS.fin}.` }, harness: "opencode", name: "placed", place: where, clientKey: `fin-${tag}` }]))
    if (answer.refused || !answer.child) throw new Error(`the start was refused: ${answer.refused}: ${answer.why}`)
    return answer
  })
  const woken = await step("the Fin's turn ends on the second device and its result wakes the Apex on the first", async () => {
    const wake = await until("the Apex's wake", async () => (await digests()).find((request) => request.text?.includes(WORDS.fin) && request.status === "completed"))
    return { request: wake.id, notices: wake.digest?.notices.map((notice) => notice.id), msFromStart: Date.now() - startedAt, heardOnPlace: [...place.heard], heardOnApex: [...apex.heard] }
  })
  if (!place.heard.includes(WORDS.fin) || apex.heard.includes(WORDS.fin)) throw new Error(`the Fin's turn ran on the wrong device: ${JSON.stringify(woken)}`)
  if (second.kind === "container") {
    const { inside, log } = second.device
    await step("inside the container: the clone, the Fin's worktree and its turn", async () => {
      const lines = await log()
      const folder = /folder=(\S+)/.exec(lines.find((line) => line.includes("cloned a project")) ?? "")?.[1]
      if (!folder) throw new Error("the container's host logged no clone")
      const worktrees = (await inside(`git -C ${folder} worktree list`)).trim().split("\n")
      if (!worktrees.some((line) => line.includes("[mako/placed]"))) throw new Error(`the Fin has no worktree of the clone: ${worktrees.join(" | ")}`)
      return {
        uname: (await inside("uname -srm")).trim(),
        clone: folder,
        remote: (await inside(`git -C ${folder} remote get-url origin`)).trim(),
        worktrees,
        edge: lines.filter((line) => line.includes("edge written")).map((line) => line.slice(0, 300)),
        placed: lines.filter((line) => line.includes("host.agents-place")).map((line) => line.slice(0, 300)),
        opencode: (await inside("command -v opencode; opencode --version 2>/dev/null")).trim().split("\n"),
      }
    })
  }

  await step("the same start again answers the same Fin", async () => {
    const again = StartedSchema.parse(await apex.call("mako:agents-start", [caller, { brief: { objective: `Reply with the single word ${WORDS.fin}.` }, harness: "opencode", name: "placed", place: where, clientKey: `fin-${tag}` }]))
    if (again.child !== fin.child || !again.deduped) throw new Error(`a repeat started another: ${JSON.stringify(again)}`)
    if (place.heard.filter((word) => word === WORDS.fin).length !== 1) throw new Error("the Fin's brief ran twice")
    return again
  })
  await step("the Apex's list and read of the Fin are answered by its device", async () => {
    const listed = ListedSchema.parse(await apex.call("mako:agents-list", [caller, {}])).children.find((strip) => strip.child === fin.child)
    const read = ReadSchema.parse(await apex.call("mako:agents-read", [caller, { child: "placed" }]))
    if (listed?.state.kind !== "ended" || !listed.place || !read.text.includes(WORDS.fin)) throw new Error(`the Fin read otherwise: ${JSON.stringify({ listed, read })}`)
    return { listed, read: read.text.slice(0, 200) }
  })

  // The offline case: the second Fin's model holds its answer until the first device is off the network.
  const held = await step("a second Fin starts on the second device and holds at its model", async () => {
    const answer = StartedSchema.parse(await apex.call("mako:agents-start", [caller, { brief: { objective: `Reply with the single word ${WORDS.held}.` }, harness: "opencode", name: "held", place: where, clientKey: `held-${tag}` }]))
    if (answer.refused || !answer.child) throw new Error(`the start was refused: ${answer.refused}: ${answer.why}`)
    return answer
  })
  const offAt = await step("the first device goes off the network while its host runs", async () => {
    await cut()
    await until("the first device's link to drop", async () => (AccountSchema.parse(await apex.call("mako:cloud-account", [])).state.connection === "connected" ? undefined : true))
    return { at: new Date().toISOString() }
  })
  const waited = await step("the Fin finishes while the Apex's device is off, and its notice waits on its own device", async () => {
    releaseHeld()
    const line = await until("the notice to wait", async () => (await place.log()).find((entry) => entry.includes("notice waits") && entry.includes(held.child!)))
    return { heardOnPlace: [...place.heard], waits: line.slice(0, 400), wakesOnApex: (await digests()).filter((request) => request.text?.includes(WORDS.held)).length }
  })
  if (waited.wakesOnApex !== 0) throw new Error("the Apex heard a notice while its device was off")
  const backAt = Date.now()
  const taken = await step("the first device is back, and takes the notice once", async () => {
    await listen()
    const wake = await until("the Apex's wake after it's back", async () => (await digests()).find((request) => request.text?.includes(WORDS.held) && request.status === "completed"), 5 * 60_000)
    // Long enough for a second delivery to have come, were one sent: the outbox's first retry is 5 s.
    await pause(12_000)
    const wakes = (await digests()).filter((request) => request.text?.includes(WORDS.held))
    const sent = (await place.log()).filter((entry) => entry.includes("notice sent") && entry.includes(held.child!))
    const took = (await apex.log()).filter((entry) => entry.includes("notice taken") && entry.includes(held.child!))
    return { request: wake.id, msAfterBack: Date.now() - backAt - 12_000, wakes: wakes.length, sentByPlace: sent.length, takenByApex: took.length, offAt: offAt.at }
  })
  if (taken.wakes !== 1 || taken.sentByPlace !== 1) throw new Error(`the notice wasn't delivered exactly once: ${JSON.stringify(taken)}`)

  // An approval on a device nobody sits at: who hears it, who may answer it, and where the person does.
  const title = `Approval proof ${tag}`
  const stripOf = async (child: string) => ListedSchema.parse(await apex.call("mako:agents-list", [caller, {}])).children.find((strip) => strip.child === child)
  const asker = await step("a Fin on ask starts on the second device, and its harness asks to run a command", async () => {
    const answer = StartedSchema.parse(await apex.call("mako:agents-start", [caller, { brief: { objective: `Run the command you're given. Reply with the single word ${WORDS.asks}.` }, harness: "opencode", name: "asker", title, access: "ask", place: where, clientKey: `asker-${tag}` }]))
    if (answer.refused || !answer.child) throw new Error(`the start was refused: ${answer.refused}: ${answer.why}`)
    const child = answer.child
    // Its Apex's device reads it as blocked once the notice of its ask is taken.
    const strip = await until("its ask to reach its Apex's device", async () => {
      const found = await stripOf(child)
      return found?.state.kind === "blocked" ? found : undefined
    })
    return { child, name: answer.name, note: answer.note, state: strip.state, heardOnPlace: [...place.heard] }
  })
  if (place.heard.includes(WORDS.asks)) throw new Error("the command ran with nobody asked")
  await step("its Apex's device takes the ask as the person's to answer", async () => {
    const asks = (line: string) => line.includes(asker.child) && (line.includes("ask routed") || line.includes("notice sent") || line.includes("notice taken"))
    const wake = (await digests()).find((request) => request.digest?.notices.some((notice) => notice.id.includes(asker.child)))
    return { state: asker.state, apexWoken: wake ? { request: wake.id, status: wake.status, says: wake.text?.slice(0, 600) } : false, place: (await place.log()).filter(asks).map((line) => line.slice(0, 400)), apex: (await apex.log()).filter(asks).map((line) => line.slice(0, 400)) }
  })
  await step("its Apex can't allow it with agents_answer", async () => {
    const answer = RefusedSchema.parse(await apex.call("mako:agents-answer", [caller, { to: asker.child, allow: true, clientKey: `allow-${tag}` }]))
    if (!answer.refused) throw new Error(`its Apex's answer was taken: ${JSON.stringify(answer)}`)
    if (place.heard.includes(WORDS.asks)) throw new Error("the command ran on its Apex's word")
    return answer
  })
  // The ask as the Apex's device holds it: the Fin's report of it, which its notice named.
  const noticesOf = async () => (await digests()).flatMap((request) => request.digest?.notices ?? []).filter((each) => each.id.startsWith(`notice:${asker.child}:`))
  const asked = (await noticesOf())[0]?.id
  await step("the person's answer from the Apex's Thread is refused, and says where to go", async () => {
    if (!asked) throw new Error("the Apex's device took no notice of the Fin's ask")
    const answer = RefusedSchema.parse(await apex.call("mako:agents-respond", [apexConversation, { fin: asker.child, ask: asked.slice(`notice:${asker.child}:`.length), option: 0, request: randomUUID() }]))
    if (!answer.refused) throw new Error(`the person's answer from the Apex's Thread was taken: ${JSON.stringify(answer)}`)
    if (place.heard.includes(WORDS.asks)) throw new Error("the command ran on an answer its device never took")
    return answer
  })
  // The Apex's device off while the person answers: the Fin's row is its own device's, so nothing of this needs it.
  const apexOffAt = await step("the first device goes off the network again, with the ask open", async () => {
    await cut()
    await until("the first device's link to drop", async () => (AccountSchema.parse(await apex.call("mako:cloud-account", [])).state.connection === "connected" ? undefined : true))
    return { at: new Date().toISOString() }
  })
  const askedAt = Date.now()
  // The person's answer as the device's host logged it: the gateway operation that carried it (`host.live-permission`).
  const permissionLines = async () => (await place.log()).filter((line) => /permission/i.test(line) && !/gateway trace/.test(line)).slice(-8).map((line) => line.slice(0, 300))
  const answered = (lines: string[], since: number) => lines.filter((line) => /live-permission/.test(line) && Date.parse(line.slice(0, 24)) >= since - 1_000)
  await step("the person allows it from under the Apex, in the Fin's own Thread, with the Apex's device off, and the command runs on the device", async () => {
    say("ASK", { device: names.place, thread: asker.child, name: asker.name, title, decision: "allow", ...(asker.state.question && { question: asker.state.question }), apex: { thread: apexThread.thread, title: `Placed Fins proof ${tag}`, offSince: apexOffAt.at } })
    // Ten minutes for whoever answers it: there's no window on that device to answer it in. What ends the wait is the
    // marker the command wrote, read on the device: the model resuming with its word is never the evidence.
    const ran = await until("the command's marker on the device", async () => {
      const searched = await place.searched(marker(WORDS.asks))
      if (searched.kind === "failed") throw new Error(`the device couldn't be searched: ${searched.why}`)
      return searched.kind === "found" ? searched : undefined
    }, 10 * 60_000)
    const proven = allowed(ran, WORDS.asks)
    if (!proven.ok) throw new Error(proven.why)
    const permission = await permissionLines()
    if (!answered(permission, askedAt).length) throw new Error(`the device's host logged no answer to the permission since the ask: ${JSON.stringify(permission)}`)
    return { msToAnswer: Date.now() - askedAt, marker: { name: marker(WORDS.asks), holds: ran.holds }, heardOnPlace: [...place.heard], permission }
  })
  if (apex.heard.includes(WORDS.asks)) throw new Error("the asking Fin's turn ran on the wrong device")
  await step("the first device is back, and the Fin's result wakes the Apex", async () => {
    await listen()
    // Its result is another notice than its ask's: the digest that carries it is the wake.
    const wake = await until("the Apex's wake with its result", async () => (await digests()).find((request) => request.status === "completed" && request.digest?.notices.some((each) => each.id.startsWith(`notice:${asker.child}:`) && each.id !== asked)), 5 * 60_000)
    const strip = await until("the Fin to read as ended", async () => {
      const found = await stripOf(asker.child)
      return found?.state.kind === "ended" ? found : undefined
    })
    return { request: wake.id, notices: wake.digest?.notices.map((each) => each.id), state: strip.state, heardOnApex: [...apex.heard] }
  })

  // The person rejects: nothing runs, and the device shows it, whatever the model said when its tool call failed.
  const denier = await step("a fourth Fin on ask starts on the second device, and its harness asks to run a command", async () => {
    const answer = StartedSchema.parse(await apex.call("mako:agents-start", [caller, { brief: { objective: `Run the command you're given. Reply with the single word ${WORDS.deny}.` }, harness: "opencode", name: "denier", title: `Rejection proof ${tag}`, access: "ask", place: where, clientKey: `deny-${tag}`, mode: "background" }]))
    if (answer.refused || !answer.child) throw new Error(`the start was refused: ${answer.refused}: ${answer.why}`)
    const child = answer.child
    const strip = await until("its ask to reach its Apex's device", async () => {
      const found = await stripOf(child)
      return found?.state.kind === "blocked" ? found : undefined
    })
    return { child, name: answer.name, state: strip.state }
  })
  {
    const before = rejected(await place.searched(marker(WORDS.deny)))
    if (!before.ok) throw new Error(`before anyone answered: ${before.why}`)
  }
  const rejectAskedAt = Date.now()
  await step("the person rejects it in the Fin's own Thread, and the command never runs on the device", async () => {
    say("ASK", { device: names.place, thread: denier.child, name: denier.name, title: `Rejection proof ${tag}`, decision: "reject", ...(denier.state.question && { question: denier.state.question }), apex: { thread: apexThread.thread, title: `Placed Fins proof ${tag}` } })
    // Its turn ends once the rejection reaches its harness: the Fin reads as ended, or as blocked no more.
    const strip = await until("the rejected Fin's turn to end", async () => {
      const found = await stripOf(denier.child)
      return found && found.state.kind !== "blocked" && found.state.kind !== "working" ? found : undefined
    }, 10 * 60_000)
    // A rejection is proven by a search that completed and found nothing: one that couldn't look fails the step.
    const proven = rejected(await place.searched(marker(WORDS.deny)))
    if (!proven.ok) throw new Error(proven.why)
    // The device took an answer to the permission since the ask, and nothing ran: the model's word after its failed call counts for nothing.
    const permission = await permissionLines()
    if (!answered(permission, rejectAskedAt).length) throw new Error(`the device's host logged no answer to the permission since the ask: ${JSON.stringify(permission)}`)
    return { msToAnswer: Date.now() - rejectAskedAt, state: strip.state, marker: { name: marker(WORDS.deny), holds: null }, heardOnPlace: [...place.heard], permission }
  })

  // What each host logged of the calls between them, with the correlation IDs the gateway carried.
  const between = (lines: string[]) => lines.filter((line) => /agents-(place|capabilities|notice|list|read|answer|respond)|ask routed|start placed|notice (sent|waits|taken)|edge written|cloned a project|"wake"|\bwake\b/.test(line)).map((line) => line.slice(0, 600))
  report.apex = DetailSchema.parse(JSON.parse(JSON.stringify({ ...apexThread, fin: fin.child, held: held.child, asker: asker.child, denier: denier.child })))
  report.log = { apex: between(await apex.log()), place: between(await place.log()) }
  const cloned = (await place.log()).find((line) => line.includes("cloned a project"))?.slice(0, 400)
  if (cloned) report.worktree = cloned
  ok = true
} finally {
  report.ok = ok
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2))
  if (!relay.listening) await listen().catch(() => undefined)
  for (const device of devices) await device.stop().catch((error: Error) => say("STEP", { name: `stop ${device.name}`, ok: false, problem: error.message }))
  await cut().catch(() => undefined)
  if (!values.keep) await rm(root, { recursive: true, force: true })
  say("DONE", { ok, report: join(out, "report.json"), steps: steps.length, failed: steps.filter((each) => !each.ok).map((each) => each.name) })
  process.exit(ok ? 0 : 1)
}
