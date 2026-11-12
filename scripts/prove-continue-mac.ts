import "./lib/scratch-git.mjs"
import { execFile, execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { createRequire } from "node:module"
import type { Duplex } from "node:stream"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { connect as tlsConnect } from "node:tls"
import { promisify, parseArgs } from "node:util"
import { z } from "zod"
import { holdHostLease } from "@mako/host/base/host-idle"
import { invokeRuntime, runtimeInfo } from "@mako/host/transport/connection"
import { hostCommand, runtimeLocation } from "@mako/host/transport/service"
import { PackagedApp } from "./lib/packaged-app.mjs"
import { assertOwnHarnessStores } from "./lib/proof-host.ts"
import { assertScratchEnvironment, scratchInstall, scratchKeychain, seedScratchHome } from "./scratch-harness-home.ts"
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
 * With `--opencode <version>`, that version of OpenCode is installed in the root and first on the host's `PATH`, else
 * it runs the person's. Give it the version the cloud's machines run: a Session goes to the cloud only from a version
 * no newer than theirs, and comes back only into theirs or a newer one, so with any other the Thread stays there.
 *
 * With `--window`, the desktop runs too, as a packaged app's on its own profile (`PackagedApp`, a built checkout), so
 * `shot` can take its window; else the host alone, screenless. Either way its host opens no browser on this Mac: its
 * sign-in page is printed for the driver to open.
 *
 * With `--other <repository>`, the project folder holds two repositories, the first and that one beside it, each
 * cloned as the host clones one (`--filter=blob:none`); with `--private`, Git here reaches a private one through the
 * person's own `gh` sign-in, read where it is for each call and never copied (as `prove-cloud-moves.ts --private`).
 *
 * Lines on stdin drive it; each answers with one line on stdout, JSON after its word:
 * - (at start) `SIGN IN <url>`, then once signed in with the cloud, `READY {dataRoot, project, opencode}`.
 * - `start <title> <word>`: a Thread on OpenCode in its own worktree of the project, its first turn that word, waited
 *   for. The worktree is on a branch of its own, as Mako makes one, tracking the repository's default branch, which
 *   the project folder has checked out and a cloud machine clones by that name; with `--branch`, on that branch of
 *   the repository's on GitHub, by the same name. `STARTED {conversation, thread, folder, branch, upstream}`
 * - `say <conversation> <word>`: a turn sent as the composer sends one, not waited for. `SAID {request, at}`
 * - `read <conversation>`: the conversation as this Mac reads it now: each request's status, the words its history says
 *   (its records' and the live blocks after them, as the window shows it), and where its folder is when it isn't here.
 *   `READ {elsewhere, requests, words}`
 * - `continues`: each continue in the cloud this Mac pressed or heard of, as its Diagnostics show them. `CONTINUES [...]`
 * - `synced [ms]`: waits until the account can show each Session of the sync window and holds its records whole, so a
 *   continue can go on from them. `SYNCED {ms, up, …}`
 * - `heard`: every word the scripted model was asked for, in order: the turns that ran here. `HEARD [...]`
 * - `offline`, `online`: the relay cut, or listening again on the same port. `OFFLINE {at}`, `ONLINE {at}`
 * - `return <conversation>`: the Thread brought back from the cloud, as Bring back does. `RETURNED {outcome, ms}`
 * - `shot <path> [title]`: the window's screenshot, the Thread named by its title selected first. `SHOT <path>`
 * - `start-here <title> <word>`: as `start`, in the project folder itself (the main checkout), no worktree.
 * - `join <conversation> <folder> <word>`: another Session of that conversation's Thread, as a `+` tab makes one, in
 *   `<folder>` of the project folder, its first turn that word, waited for. `JOINED {conversation}`
 * - `hold <conversation> <word>`: a turn the scripted model holds mid-way (it answers after a quarter of an hour), sent
 *   and waited for until it runs. `HOLDING {request}`
 * - `person <file> <text>`: the person's own uncommitted edit of a file in the project folder. `PERSON {path}`
 * - `status <conversation>`: the project folder's uncommitted files, and the conversation's folder, branch and
 *   uncommitted files. `STATUS {project, folder, branch, changed}`
 * - `sleep` (with `--sleep-watch`): the stand-in sleep watch says the Mac is about to sleep, as macOS tells the real
 *   one, and the host hands off before it lets the Mac sleep. `SLEPT {ms}` once it let it.
 * - `shutdown`: the desktop app's word that the Mac is shutting down (`mako:machine-leaving`), answered once the host's
 *   handoff did, its hold at most. `SHUTDOWN {ms}`
 * - `quit` (or stdin's end): signs out, stops the host (and the window), removes the root unless `--keep`. The host's
 *   log is kept beside it, as `<root>.host.log`.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/prove-continue-mac.ts --root <empty folder> --cloud https://… \
 *     --relay-port <port> [--repository https://github.com/octocat/Hello-World] [--branch test] [--opencode 2.2.3]
 *     [--window] [--keep]
 */
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    cloud: { type: "string" },
    "relay-port": { type: "string" },
    repository: { type: "string", default: "https://github.com/octocat/Hello-World" },
    branch: { type: "string" },
    opencode: { type: "string" },
    window: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    "sleep-watch": { type: "boolean", default: false },
    other: { type: "string" },
    private: { type: "boolean", default: false },
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
/** A word `hold` asks for: its turn stays mid-way here, the model answering only after this long. */
const HELD = "HOLD"
const HELD_MS = 15 * 60_000
const model = await scriptedModel({
  reply: (text) => {
    const word = [...text.matchAll(ONE_WORD)].at(-1)?.[1]
    if (!word) return { text: "OK" }
    heard.push(word)
    if (word.startsWith(HELD)) return new Promise((resolve) => setTimeout(() => resolve({ text: word }), HELD_MS).unref())
    return { text: word }
  },
  aside: "Continue proof",
})
await mkdir(join(home, ".config", "opencode"), { recursive: true })
await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", enabled_providers: ["anthropic"], provider: { anthropic: { options: { baseURL: `${model.url}/v1`, apiKey: "continue-proof" } } } }, null, 2))
/** Git reaching a private repository as the person's does, through their own `gh` sign-in, read for each call. */
function privateGit(): NodeJS.ProcessEnv {
  const gh = execFileSync("/usr/bin/which", ["gh"], { encoding: "utf8" }).trim()
  const config = process.env.GH_CONFIG_DIR ?? join(homedir(), ".config", "gh")
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.https://github.com.helper", GIT_CONFIG_VALUE_0: `!GH_CONFIG_DIR='${config}' '${gh}' auth git-credential` }
}
const gitEnv: NodeJS.ProcessEnv = { ...scratch.env, ...values.private && privateGit() }
const named = (url: string) => new URL(url).pathname.split("/").at(-1) ?? "project"
// The project folder: the repository itself, or with `--other` a folder holding it and the other beside it.
const project = join(home, "projects", values.other ? "project" : named(values.repository))
const first = values.other ? join(project, named(values.repository)) : project
await mkdir(values.other ? project : join(home, "projects"), { recursive: true })
await run("git", ["clone", "-q", ...values.other ? ["--filter=blob:none"] : [], values.repository, first], { env: gitEnv })
if (values.other) await run("git", ["clone", "-q", "--filter=blob:none", values.other, join(project, named(values.other))], { env: gitEnv })
// With `--branch`, a branch of the repository's own on GitHub besides its default, which the project folder has
// checked out, so the Thread's worktree can have it by the same name.
const defaultBranch = (await run("git", ["-C", first, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim()
const remoteBranches = (await run("git", ["-C", first, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])).stdout.split("\n").filter((name) => name.startsWith("origin/") && name !== "origin/HEAD" && name !== defaultBranch)
const branchOnGitHub = values.branch ? `origin/${values.branch}` : undefined
if (branchOnGitHub && !remoteBranches.includes(branchOnGitHub)) throw new Error(`${values.repository} has no branch on GitHub besides ${defaultBranch} named ${values.branch}`)

const opencodeBin = values.opencode ? join(root, "opencode", "bin") : undefined
if (opencodeBin) {
  await scratchInstall("npm", ["install", "-g", "--prefix", join(root, "opencode"), "--allow-scripts=@opencode/cli", `@opencode/cli@${values.opencode}`], { env: { ...scratch.env } })
  const installed = (await run(join(opencodeBin, "opencode"), ["--version"], { env: { ...scratch.env } })).stdout.trim()
  if (/\d+\.\d+\.\d+\S*/.exec(installed)?.[0] !== values.opencode) throw new Error(`npm installed OpenCode ${installed}, not ${values.opencode}`)
}

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

// With `--sleep-watch`, the host's sleep watch is a stand-in for the native helper, where a checkout's host looks for it:
// `sleep` has it say the Mac is about to sleep, as macOS tells the real one, and it lets the Mac sleep once the host
// says so. The checkout's own helper goes back as the run ends.
const sleepHelper = join(process.cwd(), "build", "mako-sleep-watch")
const realHelper = `${sleepHelper}.proof-real`
const sleepWatch = join(root, "sleep-watch")
if (values["sleep-watch"]) {
  await mkdir(sleepWatch, { recursive: true })
  if (existsSync(sleepHelper) && !existsSync(realHelper)) await rename(sleepHelper, realHelper)
  await writeFile(sleepHelper, `#!${process.execPath}
const fs = require("fs"), path = require("path"), readline = require("readline")
const dir = ${JSON.stringify(sleepWatch)}
fs.writeFileSync(path.join(dir, "ready"), String(Date.now()))
console.log("ready")
let id = 0
setInterval(() => {
  const asked = path.join(dir, "sleep")
  if (!fs.existsSync(asked)) return
  fs.rmSync(asked)
  id += 1
  console.log("will-sleep " + id)
}, 100)
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const [word, n] = line.trim().split(" ")
  if (word !== "allow") return
  fs.writeFileSync(path.join(dir, "slept-" + n), String(Date.now()))
  console.log("slept " + n + " answer")
})
process.stdin.on("end", () => process.exit(0))
`, { mode: 0o755 })
}

// The host: screenless on its own, or the desktop's on a profile of its own, both on the scratch home through the relay.
const cloudUrl = `http://127.0.0.1:${relayPort}`
const hostEnv: NodeJS.ProcessEnv = { ...gitEnv, ...opencodeBin && { PATH: [opencodeBin, scratch.env["PATH"]].filter(Boolean).join(delimiter) }, MAKO_CLOUD_URL: cloudUrl, MAKO_SCREENLESS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
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
say("READY", JSON.stringify({ dataRoot, project, opencode: values.opencode ?? null }))

const SnapshotSchema = z.object({
  session: z.object({ cwd: z.string().nullish() }).loose(),
  threadId: z.string().optional(),
  elsewhere: z.string().optional(),
  requests: z.array(z.object({ id: z.string(), status: z.string(), error: z.string().optional() }).loose()).default([]),
  blocks: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).default([]),
  base: z.object({ entries: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()) }).loose().nullish(),
}).loose()
const snapshot = async (id: string) => SnapshotSchema.parse(await call("mako:live-snapshot", [id]))
const said = (entries: ReadonlyArray<{ type: string; text?: string }>) => entries.filter((entry) => entry.type === "text").map((entry) => entry.text?.trim() ?? "")
// The window's history: the base, the session's whole history as its records hold it (a Thread back from the cloud
// has the machine's turns there), then the live blocks it doesn't hold yet.
const read = async (id: string) => {
  const shot = await snapshot(id)
  const kept = said(shot.base?.entries ?? [])
  const words = [...kept, ...said(shot.blocks).filter((word) => !kept.includes(word))]
  return { elsewhere: shot.elsewhere ?? null, threadId: shot.threadId ?? null, cwd: shot.session.cwd ?? null, requests: shot.requests.map(({ id: request, status, error }) => ({ request, status, ...error && { error } })), words }
}
const SyncSchema = z.object({ state: z.string(), stale: z.number().optional(), sending: z.number().optional(), tiers: z.array(z.object({ sessions: z.number(), inCloud: z.number() }).loose()).optional() }).loose()

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
  if (values["sleep-watch"] && existsSync(realHelper)) await rename(realHelper, sleepHelper)
  await cut()
  await model.close()
  scratch.dispose()
  // The host's log outlives the root it's in, for what the proof says of its run.
  await copyFile(join(dataRoot, "logs", "host.log"), `${root}.host.log`).catch(() => undefined)
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
    await call("mako:live-start", ["opencode", project, { conversationId, title, worktree: true, ...branchOnGitHub && { worktreeStart: { kind: "branch", branch: branchOnGitHub } }, initialRequest: { id: request, text: `Reply with the single word ${word}.`, attachments: [] } }])
    for (const deadline = Date.now() + 5 * 60_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
      const status = (await snapshot(conversationId)).requests.find((entry) => entry.id === request)?.status
      if (status && !["queued", "held", "dispatching"].includes(status)) break
      if (Date.now() > deadline) throw new Error(`the first turn didn't end within five minutes: ${JSON.stringify(await read(conversationId))}`)
    }
    const shot = await snapshot(conversationId)
    const folder = shot.session.cwd ?? ""
    if (!branchOnGitHub) await run("git", ["-C", folder, "branch", "--quiet", `--set-upstream-to=${defaultBranch}`])
    const upstream = (await run("git", ["-C", folder, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout.trim()
    say("STARTED", JSON.stringify({ conversation: conversationId, thread: shot.threadId, folder, branch: (await run("git", ["-C", folder, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), upstream, ...await read(conversationId) }))
  } else if (command === "start-here") {
    const word = rest.pop()!
    const title = rest.join(" ")
    const conversationId = randomUUID()
    const request = randomUUID()
    await call("mako:live-start", ["opencode", project, { conversationId, title, initialRequest: { id: request, text: `Reply with the single word ${word}.`, attachments: [] } }])
    for (const deadline = Date.now() + 5 * 60_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
      const status = (await snapshot(conversationId)).requests.find((entry) => entry.id === request)?.status
      if (status && !["queued", "held", "dispatching"].includes(status)) break
      if (Date.now() > deadline) throw new Error(`the first turn didn't end within five minutes: ${JSON.stringify(await read(conversationId))}`)
    }
    const shot = await snapshot(conversationId)
    say("STARTED", JSON.stringify({ conversation: conversationId, thread: shot.threadId, folder: shot.session.cwd ?? "", ...await read(conversationId) }))
  } else if (command === "join") {
    const [conversation, folder, word] = rest
    const thread = conversation && (await snapshot(conversation)).threadId
    if (!thread || !folder || !word) {
      say("UNKNOWN", JSON.stringify({ line }))
      continue
    }
    const placed = z.object({ session: z.string() }).loose().parse(await call("mako:thread-create-session", [randomUUID(), thread]))
    const conversationId = randomUUID()
    const request = randomUUID()
    await call("mako:live-start", ["opencode", join(project, folder), { conversationId, title: folder, session: placed.session, initialRequest: { id: request, text: `Reply with the single word ${word}.`, attachments: [] } }])
    for (const deadline = Date.now() + 5 * 60_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
      const status = (await snapshot(conversationId)).requests.find((entry) => entry.id === request)?.status
      if (status && !["queued", "held", "dispatching"].includes(status)) break
      if (Date.now() > deadline) throw new Error(`the joined Session's first turn didn't end within five minutes: ${JSON.stringify(await read(conversationId))}`)
    }
    const joined = await snapshot(conversationId)
    say("JOINED", JSON.stringify({ conversation: conversationId, thread: joined.threadId, folder: joined.session.cwd ?? "", ...await read(conversationId) }))
  } else if (command === "hold") {
    const [conversation, word] = rest
    if (!conversation || !word?.startsWith(HELD)) {
      say("UNKNOWN", JSON.stringify({ line }))
      continue
    }
    const request = randomUUID()
    await call("mako:live-prompt", [conversation, request, `Reply with the single word ${word}.`, []])
    for (const deadline = Date.now() + 2 * 60_000; !heard.includes(word); await new Promise((resolve) => setTimeout(resolve, 200)))
      if (Date.now() > deadline) throw new Error(`the held turn never reached the model: ${JSON.stringify(await read(conversation))}`)
    say("HOLDING", JSON.stringify({ request, ...await read(conversation) }))
  } else if (command === "person") {
    const [file, ...text] = rest
    await writeFile(join(project, file!), `${text.join(" ")}\n`)
    say("PERSON", JSON.stringify({ path: join(project, file!) }))
  } else if (command === "status") {
    // A folder's uncommitted files, by each repository it holds when it isn't one itself.
    const changed = async (folder: string) => {
      const repositories = existsSync(join(folder, ".git")) ? [""] : (await readdir(folder)).filter((name) => existsSync(join(folder, name, ".git")))
      const each = await Promise.all(repositories.map(async (name) => (await run("git", ["-C", join(folder, name), "status", "--porcelain"])).stdout.split("\n").filter(Boolean).map((entry) => (name ? `${entry.slice(0, 3)}${name}/${entry.slice(3)}` : entry))))
      return each.flat()
    }
    const folder = (await snapshot(rest[0]!)).session.cwd ?? ""
    const there = folder && existsSync(folder)
    say("STATUS", JSON.stringify({ project: await changed(project), folder, branch: there ? (await run("git", ["-C", folder, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() : null, changed: there ? await changed(folder) : null }))
  } else if (command === "sleep") {
    if (!values["sleep-watch"]) {
      say("UNKNOWN", JSON.stringify({ line, reason: "started without --sleep-watch" }))
      continue
    }
    // The host starts its sleep watch once it may hand off (signed in with the cloud), within a minute.
    for (const deadline = Date.now() + 90_000; !existsSync(join(sleepWatch, "ready")); await new Promise((resolve) => setTimeout(resolve, 250)))
      if (Date.now() > deadline) throw new Error("the host never started its sleep watch")
    const began = Date.now()
    const slept = new Set((await readdir(sleepWatch)).filter((name) => name.startsWith("slept-")))
    await writeFile(join(sleepWatch, "sleep"), "")
    for (const deadline = began + 60_000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
      if ((await readdir(sleepWatch)).some((name) => name.startsWith("slept-") && !slept.has(name))) break
      if (Date.now() > deadline) throw new Error("the host never let the Mac sleep")
    }
    say("SLEPT", JSON.stringify({ ms: Date.now() - began }))
  } else if (command === "shutdown") {
    const began = Date.now()
    await call("mako:machine-leaving", ["shutdown"])
    say("SHUTDOWN", JSON.stringify({ ms: Date.now() - began }))
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
    let up = false
    for (const limit = Number(rest[0]) || 2 * 60_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
      sync = SyncSchema.parse(await call("mako:sync-status", []))
      const tiers = sync.tiers ?? []
      // Each Session the account can show and holds whole: a continue goes on from its records.
      up = tiers.some((tier) => tier.sessions > 0) && tiers.every((tier) => tier.inCloud >= tier.sessions) && !sync.stale && !sync.sending
      if (up || Date.now() - began > limit) break
    }
    say("SYNCED", JSON.stringify({ ms: Date.now() - began, up, ...sync }))
  } else if (command === "heard") say("HEARD", JSON.stringify(heard))
  else if (command === "continues") say("CONTINUES", JSON.stringify(await call("mako:continue-readings", [])))
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
