import "./lib/scratch-git.mjs"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { createRequire } from "node:module"
import type { Duplex } from "node:stream"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { connect as tlsConnect } from "node:tls"
import { promisify, parseArgs } from "node:util"
import { z } from "zod"
import { holdHostLease } from "@mako/host/base/host-idle"
import { invokeRuntime, runtimeInfo } from "@mako/host/transport/connection"
import { hostCommand, runtimeLocation } from "@mako/host/transport/service"
import { PackagedApp } from "./lib/packaged-app.mjs"
import { assertOwnHarnessStores } from "./lib/proof-host.ts"
import { assertScratchEnvironment, scratchKeychain, seedScratchHome } from "./scratch-harness-home.ts"
import { scriptedModel } from "./scripted-model.ts"

/**
 * The Mac's half of a "Continue in the cloud" proof against a deployed cloud: a host of this checkout's build on a
 * scratch home with no sign-in of the person's, its OpenCode answered by the scripted model on this Mac, signed in to
 * `--cloud` (https) as whatever account the driver signs its sign-in page in as. It reaches the cloud only through a
 * relay on `--relay-port`, so `offline` takes it off the network as a closed lid does, its host still running.
 *
 * Every turn asks for one word ("Reply with the single word X."), and the scripted model says it back: the words it
 * heard are the turns that ran on this Mac, and a turn that ran anywhere else never reaches it.
 *
 * With `--window`, the desktop runs too, as a packaged app's on its own profile (`PackagedApp`, a built checkout), so
 * `shot` can take its window; else the host alone, screenless. Either way its host opens no browser on this Mac: its
 * sign-in page is printed for the driver to open.
 *
 * Lines on stdin drive it; each answers with one line on stdout, JSON after its word:
 * - (at start) `SIGN IN <url>`, then once signed in with the cloud, `READY {dataRoot, project}`.
 * - `start <title> <word>`: a Thread in its own worktree of the project, on OpenCode, its first turn that word, waited
 *   for; its worktree's branch then tracks the repository's default branch, which a cloud machine can clone.
 *   `STARTED {conversation, thread, folder, branch}`
 * - `say <conversation> <word>`: a turn sent as the composer sends one, not waited for. `SAID {request, at}`
 * - `read <conversation>`: the conversation as this Mac reads it now: where it runs, each request's status and the
 *   words its text says. `READ {elsewhere, requests, words}`
 * - `synced [ms]`: waits for the sync window's copies and records to be up. `SYNCED {…}`
 * - `heard`: every word the scripted model was asked for, in order: the turns that ran here. `HEARD [...]`
 * - `offline`, `online`: the relay cut, or listening again on the same port. `OFFLINE {at}`, `ONLINE {at}`
 * - `return <conversation>`: the Thread brought back from the cloud, as Bring back does. `RETURNED {outcome, ms}`
 * - `shot <path> [title]`: the window's screenshot, the Thread named by its title selected first. `SHOT <path>`
 * - `quit` (or stdin's end): signs out, stops the host (and the window), removes the root unless `--keep`.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/prove-continue-mac.ts --root <empty folder> --cloud https://… \
 *     --relay-port <port> [--repository https://github.com/octocat/Hello-World] [--window] [--keep]
 */
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    cloud: { type: "string" },
    "relay-port": { type: "string" },
    repository: { type: "string", default: "https://github.com/octocat/Hello-World" },
    window: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
})
if (!values.root || !values.cloud || !values["relay-port"]) throw new Error("--root, --cloud and --relay-port are required")
const root = values.root
const cloud = new URL(values.cloud)
if (cloud.protocol !== "https:") throw new Error("--cloud is a deployed gateway, on https")
const relayPort = Number(values["relay-port"])
if ((await readdir(root).catch(() => [])).length) throw new Error(`${root} isn't empty: give the proof a folder of its own`)
const run = promisify(execFile)
const say = (word: string, json?: string) => console.log(json === undefined ? word : `${word} ${json}`)

// A home of its own with no sign-in of the person's: OpenCode answers from the scripted model, through its own settings.
const scratch = seedScratchHome(root, {}, { keep: values.keep })
scratchKeychain(scratch.home)
const home = scratch.home
const heard: string[] = []
const ONE_WORD = /Reply with the single word ([A-Za-z0-9-]+)\./g
const model = await scriptedModel({
  reply: (text) => {
    const word = [...text.matchAll(ONE_WORD)].at(-1)?.[1]
    if (!word) return { text: "OK" }
    heard.push(word)
    return { text: word }
  },
  aside: "Continue proof",
})
await mkdir(join(home, ".config", "opencode"), { recursive: true })
await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", enabled_providers: ["anthropic"], provider: { anthropic: { options: { baseURL: `${model.url}/v1`, apiKey: "continue-proof" } } } }, null, 2))
const project = join(home, "projects", new URL(values.repository).pathname.split("/").at(-1) ?? "project")
await mkdir(join(home, "projects"), { recursive: true })
await run("git", ["clone", "-q", values.repository, project], { env: { ...scratch.env } })
const defaultBranch = (await run("git", ["-C", project, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim()

// The Mac's network: an http relay on this Mac's loopback to the cloud's https, sockets and all, so `offline` can cut it.
const carried = new Set<Duplex>()
const keep = (socket: Duplex) => {
  carried.add(socket)
  socket.once("close", () => carried.delete(socket))
  socket.on("error", () => socket.destroy())
}
const upstream = { host: cloud.hostname, port: Number(cloud.port) || 443 }
const relay = createServer((inbound, outbound) => {
  const headers = { ...inbound.headers, host: cloud.host }
  const onward = httpsRequest({ ...upstream, method: inbound.method, path: inbound.url, headers }, (answer) => {
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

// The host: screenless on its own, or the desktop's on a profile of its own, both on the scratch home through the relay.
const cloudUrl = `http://127.0.0.1:${relayPort}`
const hostEnv: NodeJS.ProcessEnv = { ...scratch.env, MAKO_CLOUD_URL: cloudUrl, MAKO_SCREENLESS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
assertScratchEnvironment(hostEnv, "the continue proof's host")
// SAFETY: the electron package's main export is the path of its executable.
const electron = createRequire(import.meta.url)("electron") as string
let desktop: PackagedApp | undefined
let host: ReturnType<typeof spawn> | undefined
let release: (() => Promise<void>) | undefined
let dataRoot: string
if (values.window) {
  // Every variable of this process's the scratch home leaves out stays out of the desktop's, and so its host's (the
  // desktop leaves out this process's own Mako variables itself).
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).filter((name) => !name.startsWith("MAKO_")).map((name) => [name, undefined]))
  desktop = new PackagedApp({ executable: electron, root, workspace: process.cwd(), args: [process.cwd()], env: { ...env, ...hostEnv, MAKO_PROD: "1" } })
  dataRoot = desktop.profile
  await desktop.start()
} else {
  dataRoot = join(home, "Library", "Application Support", "mako-continue-proof", "profile")
  const command = hostCommand({ executable: electron, args: [process.cwd()], env: { ...hostEnv, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: runtimeLocation(dataRoot).socket } })
  host = spawn(command.executable, command.args, { env: command.env, stdio: "ignore" })
  for (const deadline = Date.now() + 60_000; !(await runtimeInfo(runtimeLocation(dataRoot).socket).catch(() => null)); ) {
    if (Date.now() > deadline) throw new Error(`the host didn't start within a minute; its log is ${join(dataRoot, "logs", "host.log")}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  release = await holdHostLease(runtimeLocation(dataRoot).directory)
}
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(runtimeLocation(dataRoot).socket, client, channel, args)
await assertOwnHarnessStores(call, dataRoot)

const AccountSchema = z.object({ state: z.object({ status: z.string(), url: z.string().optional(), account: z.object({ entitlements: z.array(z.string()) }).loose().optional() }).loose() }).loose()
let account = AccountSchema.parse(await call("mako:cloud-sign-in", []))
if (account.state.status === "signing-in") say(`SIGN IN ${(account.state.url ?? "").replace(cloudUrl, cloud.origin)}`)
for (const deadline = Date.now() + 5 * 60_000; !(account.state.status === "signed-in" && account.state.account?.entitlements.includes("cloud")); ) {
  if (Date.now() > deadline) throw new Error(`the host isn't signed in with the cloud: ${account.state.status}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  account = AccountSchema.parse(await call("mako:cloud-account", []))
}
say("READY", JSON.stringify({ dataRoot, project }))

const SnapshotSchema = z.object({
  session: z.object({ cwd: z.string().nullish() }).loose(),
  threadId: z.string().optional(),
  elsewhere: z.string().optional(),
  requests: z.array(z.object({ id: z.string(), status: z.string(), error: z.string().optional() }).loose()).default([]),
  blocks: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).default([]),
}).loose()
const snapshot = async (id: string) => SnapshotSchema.parse(await call("mako:live-snapshot", [id]))
const read = async (id: string) => {
  const shot = await snapshot(id)
  const words = shot.blocks.filter((block) => block.type === "text").map((block) => block.text?.trim() ?? "")
  return { elsewhere: shot.elsewhere ?? null, threadId: shot.threadId ?? null, requests: shot.requests.map(({ id: request, status, error }) => ({ request, status, ...error && { error } })), words }
}
const SyncSchema = z.object({ state: z.string(), stale: z.number().optional(), sending: z.number().optional(), tiers: z.array(z.object({ sessions: z.number(), readable: z.number() }).loose()).optional() }).loose()

const stop = async () => {
  if (!relay.listening) await listen()
  await call("mako:cloud-sign-out", []).catch(() => undefined)
  if (desktop) await desktop.stop()
  if (host) {
    const exited = host.exitCode === null && host.signalCode === null ? new Promise((resolve) => host!.once("exit", resolve)) : Promise.resolve()
    host.kill("SIGTERM")
    await exited
  }
  await release?.()
  await cut()
  await model.close()
  scratch.dispose()
  if (!values.keep) await rm(root, { recursive: true, force: true })
  process.exit(0)
}

let selected: string | undefined
for await (const line of createInterface({ input: process.stdin })) {
  const [command, ...rest] = line.trim().split(/\s+/)
  if (command === "start") {
    const word = rest.pop()!
    const title = rest.join(" ")
    const conversationId = randomUUID()
    const request = randomUUID()
    await call("mako:live-start", ["opencode", project, { conversationId, title, worktree: true, initialRequest: { id: request, text: `Reply with the single word ${word}.`, attachments: [] } }])
    for (const deadline = Date.now() + 5 * 60_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
      const status = (await snapshot(conversationId)).requests.find((entry) => entry.id === request)?.status
      if (status && !["queued", "held", "dispatching"].includes(status)) break
      if (Date.now() > deadline) throw new Error(`the first turn didn't end within five minutes: ${JSON.stringify(await read(conversationId))}`)
    }
    const shot = await snapshot(conversationId)
    const folder = shot.session.cwd ?? ""
    const branch = (await run("git", ["-C", folder, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()
    await run("git", ["-C", folder, "branch", `--set-upstream-to=${defaultBranch}`])
    say("STARTED", JSON.stringify({ conversation: conversationId, thread: shot.threadId, folder, branch, upstream: defaultBranch, ...await read(conversationId) }))
  } else if (command === "say") {
    const [conversation, word] = rest
    if (!conversation || !word) {
      say("UNKNOWN", JSON.stringify({ line }))
      continue
    }
    const request = randomUUID()
    const at = Date.now()
    await call("mako:live-prompt", [conversation, request, `Reply with the single word ${word}.`, []])
    say("SAID", JSON.stringify({ request, at, answeredMs: Date.now() - at }))
  } else if (command === "read") say("READ", JSON.stringify(await read(rest[0]!)))
  else if (command === "synced") {
    const began = Date.now()
    let sync = SyncSchema.parse(await call("mako:sync-status", []))
    for (const limit = Number(rest[0]) || 2 * 60_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
      sync = SyncSchema.parse(await call("mako:sync-status", []))
      const tiers = sync.tiers ?? []
      const up = tiers.length > 0 && tiers.every((tier) => tier.readable >= tier.sessions) && !sync.stale && !sync.sending
      if (up || Date.now() - began > limit) break
    }
    say("SYNCED", JSON.stringify({ ms: Date.now() - began, ...sync }))
  } else if (command === "heard") say("HEARD", JSON.stringify(heard))
  else if (command === "offline") {
    await cut()
    say("OFFLINE", JSON.stringify({ at: Date.now() }))
  } else if (command === "online") {
    await listen()
    say("ONLINE", JSON.stringify({ at: Date.now() }))
  } else if (command === "return") {
    const began = Date.now()
    const outcome = await call("mako:thread-return", [rest[0]!, randomUUID()])
    say("RETURNED", JSON.stringify({ outcome, ms: Date.now() - began }))
  } else if (command === "shot") {
    const [path, ...title] = rest
    if (!desktop) say("SHOT", JSON.stringify({ path: null, reason: "no window: started without --window" }))
    else {
      const named = title.join(" ")
      if (named && named !== selected) {
        await desktop.waitFor(() => desktop!.evaluate(`[...document.querySelectorAll('[data-thread-row]')].some((row) => row.innerText.includes(${JSON.stringify(named)}))`), Boolean, `the Thread "${named}" in the sidebar`)
        await desktop.evaluate(`[...document.querySelectorAll('[data-thread-row]')].find((row) => row.innerText.includes(${JSON.stringify(named)})).click()`)
        await desktop.waitFor(() => desktop!.evaluate(`document.querySelector('[data-thread-row][data-active]')?.innerText.includes(${JSON.stringify(named)}) ?? false`), Boolean, `the Thread "${named}" open`)
        selected = named
      }
      say("SHOT", JSON.stringify({ path: await desktop.screenshot(path!) }))
    }
  } else if (command === "quit") break
  else say("UNKNOWN", JSON.stringify({ line }))
}
await stop()
