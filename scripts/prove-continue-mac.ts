import "./lib/scratch-git.mjs"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFile, copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { createRequire } from "node:module"
import type { Duplex } from "node:stream"
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
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"
import { ACCESS_TIER_NAMES, accessModeId } from "@mako/host/contracts/access"

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
 * - `start-as <access> <title> <word>`: `start` on that access (`full`, `auto`, `ask`, …), as its mode in the composer.
 * - `move <conversation> <token> <word> [ms]`: a turn whose agent calls the `mako` server's `thread_move`, then runs a
 *   command that sleeps five minutes and writes `handoff-<token>.txt`, then says the word. Waits until the Thread runs
 *   elsewhere, or `ms` (ten minutes) pass. `MOVED {answer, elsewhere, ms, read}`: `answer` is what thread_move told the agent.
 * - `asks <conversation>`: what its agent asked, as the card shows it. `ASKS [...]`
 * - `allow <conversation> <ask>`: Move to the cloud on that card, then waits until its Thread runs elsewhere. `ALLOWED {elsewhere, ms}`
 * - `back <conversation>`: `mako thread move back --conversation <id>` from a shell outside any Thread, this checkout's
 *   CLI against this host's socket. `BACK {answer, ms}`
 * - `shot <path> [title]`: the window's screenshot, the Thread named by its title selected first. `SHOT <path>`
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
// A move turn: the agent calls thread_move, then a command that runs on while the handoff pauses it, then its word.
const MOVE = /Move this Thread to the cloud with thread_move \(proof ([A-Za-z0-9-]+)\)/g
/** What thread_move told the agent, by the move turn's token. */
const moveAnswers = new Map<string, string>()
const moving = (text: string): ScriptedReply | undefined => {
  const token = [...text.matchAll(MOVE)].at(-1)?.[1]
  if (!token) return undefined
  // Nothing else in a request says this: not the worktree, whose folder is named from the Thread's title.
  const key = `thread-move-key:${token}`
  // What the harness sent on the move turn, kept beside the root for a run that goes wrong.
  void appendFile(`${root}.move-${token}.heard`, `${text}\n\n`).catch(() => undefined)
  // OpenCode keeps MCP tools in Code Mode, so the agent's call goes through its `execute`.
  if (!text.includes(key)) return { call: { id: `call_move_${token}`, name: "execute", arguments: { code: `return await tools.mako.thread_move(${JSON.stringify({ to: "cloud", clientKey: key })})` } } }
  const outcome = /\\?"outcome\\?":\s*\\?"([a-z-]+)/.exec(text.slice(text.lastIndexOf(key)))?.[1]
  if (outcome && !moveAnswers.has(token)) moveAnswers.set(token, outcome)
  const file = `handoff-${token}.txt`
  if (!text.includes(file)) return { call: { id: `call_sleep_${token}`, name: "shell", arguments: { command: `sleep 300 && echo ${token} > ${file}`, timeout: 600_000 } } }
  return undefined
}
const model = await scriptedModel({
  reply: (text) => {
    const move = moving(text)
    if (move) return move
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
// With `--branch`, a branch of the repository's own on GitHub besides its default, which the project folder has
// checked out, so the Thread's worktree can have it by the same name.
const defaultBranch = (await run("git", ["-C", project, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim()
const remoteBranches = (await run("git", ["-C", project, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])).stdout.split("\n").filter((name) => name.startsWith("origin/") && name !== "origin/HEAD" && name !== defaultBranch)
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

// The host: screenless on its own, or the desktop's on a profile of its own, both on the scratch home through the relay.
const cloudUrl = `http://127.0.0.1:${relayPort}`
const hostEnv: NodeJS.ProcessEnv = { ...scratch.env, ...opencodeBin && { PATH: [opencodeBin, scratch.env["PATH"]].filter(Boolean).join(delimiter) }, MAKO_CLOUD_URL: cloudUrl, MAKO_SCREENLESS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
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
  return { elsewhere: shot.elsewhere ?? null, threadId: shot.threadId ?? null, requests: shot.requests.map(({ id: request, status, error }) => ({ request, status, ...error && { error } })), words }
}
/** Where the conversation's folder is once its Thread runs elsewhere, waited for up to `ms`; null if it stayed. */
const awayWithin = async (conversation: string, ms: number) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 1_000))) {
    const where = (await snapshot(conversation)).elsewhere
    if (where) return where
  }
  return null
}
/** What a conversation's agent asked, as its control keeps it. */
const AsksSchema = z.object({ control: z.object({ asks: z.array(z.object({ id: z.string() }).loose()).optional() }).loose().optional() }).loose()
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
  if (command === "start" || command === "start-as") {
    const access = command === "start-as" ? z.enum(ACCESS_TIER_NAMES).parse(rest.shift()) : undefined
    const word = rest.pop()!
    const title = rest.join(" ")
    const conversationId = randomUUID()
    const request = randomUUID()
    await call("mako:live-start", ["opencode", project, { conversationId, title, worktree: true, ...access && { modeId: accessModeId(access) }, ...branchOnGitHub && { worktreeStart: { kind: "branch", branch: branchOnGitHub } }, initialRequest: { id: request, text: `Reply with the single word ${word}.`, attachments: [] } }])
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
  } else if (command === "move") {
    const [conversation, token, word, wait] = rest
    if (!conversation || !token || !word) {
      say("UNKNOWN", JSON.stringify({ line }))
      continue
    }
    const began = Date.now()
    const text = `Move this Thread to the cloud with thread_move (proof ${token}), finish the work, then reply with the single word ${word}.`
    await call("mako:live-prompt", [conversation, randomUUID(), text, []])
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && !moveAnswers.has(token); ) await new Promise((resolve) => setTimeout(resolve, 500))
    const elsewhere = await awayWithin(conversation, Number(wait) || 10 * 60_000)
    say("MOVED", JSON.stringify({ answer: moveAnswers.get(token) ?? null, elsewhere, ms: Date.now() - began, read: await read(conversation) }))
  } else if (command === "asks") say("ASKS", JSON.stringify(AsksSchema.parse(await call("mako:live-snapshot", [rest[0]!])).control?.asks ?? []))
  else if (command === "allow") {
    const [conversation, ask] = rest
    const began = Date.now()
    await call("mako:agent-ask-answer", [conversation, ask, true])
    say("ALLOWED", JSON.stringify({ elsewhere: await awayWithin(conversation!, 10 * 60_000), ms: Date.now() - began }))
  } else if (command === "back") {
    const began = Date.now()
    // The person's own shell: no Session of a Thread's, so the CLI names the conversation and waits for the end.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("MAKO_")))
    const answer = await run(process.execPath, [join(process.cwd(), "packages", "client", "dist", "cli.js"), "thread", "move", "back", "--conversation", rest[0]!, "--socket", runtimeLocation(dataRoot).socket, "--json"], { env, timeout: 15 * 60_000 })
      .then(({ stdout }) => stdout, (error: { stdout?: string; message: string }) => error.stdout || JSON.stringify({ failed: error.message }))
    say("BACK", JSON.stringify({ answer: JSON.parse(answer.trim() || "null"), ms: Date.now() - began }))
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
