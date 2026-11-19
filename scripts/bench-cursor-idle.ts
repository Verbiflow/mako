/**
 * What an idle Cursor child holds after a conversation, and what reopening it costs: the two numbers a Cursor
 * provider's idle window weighs. Mako's own child (`child.js`, through `CursorSdkClient`, on Electron's Node as the
 * host runs it) works through turns against a stand-in Cursor service on a local port (`CURSOR_BACKEND_URL`), so no
 * account or model is used and nothing leaves the machine. Each turn is the local work a real one makes the child do:
 * the service asks it to read files and run shell commands, one after another as a model would, and the child runs
 * each on this machine and streams the result back over the bidi stream; then a reply and the turn's end. After each
 * turn the child rests and its resident memory is read. Then the agent is closed, as hibernation closes it, and opened
 * again in a new child, timed to ready, as a wake does.
 *
 *   npm run bench:cursor-idle [-- --turns 12 --calls 16 --file-kb 300]
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { CursorSdkClient } from "@mako/host/harnesses/cursor/sdk/client"

const args = process.argv.slice(2)
const option = (name: string, fallback: number) => (args.includes(`--${name}`) ? Number(args[args.indexOf(`--${name}`) + 1]) : fallback)
const TURNS = option("turns", 12)
const CALLS = option("calls", 16)
const FILE_KB = option("file-kb", 300)
const REST_MS = option("rest-ms", 3_000)
const electron = join(process.cwd(), "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
const entry = join(process.cwd(), "packages/host/dist/harnesses/cursor/sdk/child.js")

function field(no: number, bytes: Buffer): Buffer {
  const length: number[] = []
  for (let left = bytes.length; ; left >>>= 7) {
    if (left < 128) { length.push(left); break }
    length.push((left & 127) | 128)
  }
  return Buffer.concat([Buffer.from([(no << 3) | 2]), Buffer.from(length), bytes])
}
const varint = (no: number, value: number) => {
  const bytes = [no << 3]
  for (let left = value; ; left >>>= 7) {
    if (left < 128) { bytes.push(left); break }
    bytes.push((left & 127) | 128)
  }
  return Buffer.from(bytes)
}
const text = (no: number, value: string) => field(no, Buffer.from(value))
const frame = (flags: number, body: Buffer) => {
  const head = Buffer.alloc(5)
  head[0] = flags
  head.writeUInt32BE(body.length, 1)
  return Buffer.concat([head, body])
}
// AgentServerMessage.exec_server_message (2): ExecServerMessage { id (1), exec_id (15), read_args (7) | shell_args (2) }.
const exec = (id: number, args: Buffer) => field(2, Buffer.concat([varint(1, id), text(15, `bench-${id}`), args]))
const read = (path: string, call: string) => field(7, Buffer.concat([text(1, path), text(2, call)]))
// ShellArgs { command (1), working_directory (2), timeout (3), tool_call_id (4), parsing_result (8): parsed, nothing flagged }.
const shell = (command: string, cwd: string, call: string) => field(2, Buffer.concat([text(1, command), text(2, cwd), varint(3, 30_000), text(4, call), field(8, Buffer.alloc(0))]))
// AgentServerMessage.interaction_update (1): InteractionUpdate { text_delta (1) { text (1) } | turn_ended (14) {} }.
const reply = (words: string) => field(1, field(1, text(1, words)))
const turnEnded = () => field(1, field(14, Buffer.concat([varint(1, 1_000), varint(2, 100)])))

const root = mkdtempSync(join(tmpdir(), "mako-cursor-idle-"))
const home = join(root, "home")
const cwd = join(root, "work")
const stateRoot = join(root, "state")
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
const words = "the quick brown fox jumps over the lazy dog and keeps on running through the field\n"
for (let file = 0; file < 4; file++) writeFileSync(join(cwd, `f${file}.txt`), words.repeat(Math.ceil((FILE_KB * 1024) / words.length)))

/** What the stand-in answers in JSON: a token, the model list, or a refusal. */
type ServiceReply = { accessToken: string } | { items: { id: string; displayName: string }[] } | { code: string; message: string }

let appended = 0
let appendedBytes = 0
const appends: (() => void)[] = []
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    const json = (status: number, body: ServiceReply) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    switch (request.url) {
      case "/auth/exchange_user_api_key":
        return json(200, { accessToken: "mako-bench" })
      case "/v1/models":
        return json(200, { items: [{ id: "composer-2.5", displayName: "Composer" }] })
      case "/agent.v1.AgentService/RunSSE":
        void runTurn(response)
        return
      case "/aiserver.v1.BidiService/BidiAppend":
        appended++
        appendedBytes += chunks.reduce((total, chunk) => total + chunk.length, 0)
        for (const waiter of appends.splice(0)) waiter()
        response.writeHead(200, { "content-type": "application/proto" })
        return response.end()
      default:
        // Any other unary call (a team's repositories, settings) gets its message's defaults: nothing configured.
        if (request.url?.startsWith("/aiserver.v1.")) {
          response.writeHead(200, { "content-type": "application/proto" })
          return response.end()
        }
        return json(404, { code: "not_found", message: `the bench answers no ${request.url}` })
    }
  })
})

/** One turn: each call waits for the child to send its result back, as a model waits for a tool's. */
async function runTurn(response: ServerResponse) {
  response.writeHead(200, { "content-type": "application/connect+proto" })
  for (let call = 0; call < CALLS; call++) {
    const id = Math.floor(Math.random() * 1e9)
    const callId = `call-${id}`
    const args = call % 2 ? shell(`cat f${call % 4}.txt`, cwd, callId) : read(join(cwd, `f${call % 4}.txt`), callId)
    const before = appended
    response.write(frame(0, exec(id, args)))
    const deadline = Date.now() + 10_000
    while (appended === before && Date.now() < deadline) await new Promise<void>((resolve) => { appends.push(resolve); setTimeout(resolve, 200) })
    // A result may come in several appends (a shell's output streams); let them land.
    await sleep(30)
  }
  response.write(frame(0, reply("Done reading.")))
  response.write(frame(0, turnEnded()))
  response.end(frame(2, Buffer.from("{}")))
}

const rss = (pid: number) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) * 1024
const mb = (bytes: number) => Math.round(bytes / 1048576)

async function child(port: number, onResult: () => void) {
  const client = new CursorSdkClient({
    owner: randomUUID(),
    cwd,
    env: { PATH: process.env.PATH, HOME: home, CURSOR_API_KEY: "mako-bench", CURSOR_BACKEND_URL: `http://127.0.0.1:${port}` },
    entry,
    execPath: electron,
    onEvent: (event) => { if (event.event === "result") onResult() },
  })
  return client
}

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
// SAFETY: a server listening on a TCP port reports its address as an AddressInfo.
const { port } = server.address() as AddressInfo
const agentId = randomUUID()
const model = { id: "composer-2.5" }
const readings: { turn: number; idleMb: number }[] = []
try {
  let ended = () => {}
  const client = await child(port, () => ended())
  const pid = client.pid ?? assert.fail("the child has a pid")
  await client.hello()
  await client.request("open", { cwd, stateRoot, strictStores: false, agentId, create: true, name: "Idle bench", model })
  await sleep(REST_MS)
  const opened = rss(pid)
  let peak = opened
  for (let turn = 1; turn <= TURNS; turn++) {
    const done = new Promise<void>((resolve) => { ended = resolve })
    const sampler = setInterval(() => { peak = Math.max(peak, rss(pid)) }, 100)
    await client.request("send", { turn: randomUUID(), text: `Turn ${turn}: read the files.`, model })
    await Promise.race([done, sleep(120_000).then(() => assert.fail(`turn ${turn} never ended`))])
    clearInterval(sampler)
    await sleep(REST_MS)
    readings.push({ turn, idleMb: mb(rss(pid)) })
  }
  await sleep(30_000)
  const rested = rss(pid)
  const closeStart = performance.now()
  await client.close(10_000)
  const closeMs = Math.round(performance.now() - closeStart)
  // A wake: a new child, opened on the same agent, to ready.
  const wakes: number[] = []
  let wokeRss = 0
  for (let wake = 0; wake < 5; wake++) {
    const start = performance.now()
    const again = await child(port, () => {})
    await again.hello()
    await again.request("open", { cwd, stateRoot, strictStores: false, agentId, create: false, model })
    wakes.push(Math.round(performance.now() - start))
    await sleep(REST_MS)
    wokeRss = rss(again.pid ?? 0)
    await again.close(10_000)
  }
  wakes.sort((a, b) => a - b)
  // SAFETY: an npm package's manifest names its version.
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "node_modules/@cursor/sdk/package.json"), "utf8")) as { version: string }
  console.log(JSON.stringify({
    sdk: manifest.version,
    turns: TURNS, callsPerTurn: CALLS, fileKb: FILE_KB,
    openedMb: mb(opened), peakMb: mb(peak), idleAfterTurnsMb: readings.map((reading) => reading.idleMb), idleAfter30sMb: mb(rested),
    // What the child sent back over the bidi stream: its tools' results, so the turns did their work.
    appends: appended, appendedMb: mb(appendedBytes),
    closeMs, wakeToReadyMs: wakes, wokeIdleMb: mb(wokeRss),
  }))
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
}
