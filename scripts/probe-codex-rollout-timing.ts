import { spawn } from "node:child_process"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { z } from "zod"
import type { JsonObject } from "@mako/host/contracts/json"
import { resolveCodexExecutable } from "@mako/host/harnesses/codex/executable"
import { CODEX_CLIENT_CAPABILITIES, codexInteractiveConfig } from "@mako/host/harnesses/codex/settings"
import { rpcPeer, sandboxed, stop } from "./harness-sandbox.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

/**
 * When Codex writes each rollout record during a live turn, against the
 * app-server notification for the same item: the evidence behind decoding
 * live from the rollout (docs/audits/2026-10-12/codex-one-decoder).
 *
 *   npx tsx --tsconfig tsconfig.app.json scripts/probe-codex-rollout-timing.ts
 *       a shell call, a patch and an answer against the scripted model, sealed
 *   npx tsx --tsconfig tsconfig.app.json scripts/probe-codex-rollout-timing.ts --model gpt-5.4-mini
 *       one tiny real turn on the person's own Codex sign-in and home
 *
 * The rollout is polled every millisecond from its offset, so a record's
 * time is when its whole line was readable. Prints kinds, ids and times
 * only, never content.
 */

const args = process.argv.slice(2)
const realModel = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined
const PROMPT = "Run `echo probe` in the shell, then create probe.txt containing the word probe with apply_patch, then reply with the single word done."

interface Seen {
  at: number
  source: "wire" | "rollout"
  kind: string
  id?: string
}

/** What names a record or a notification: its kind, and the item or call it is about. */
const RolloutLine = z.object({
  type: z.string(),
  payload: z.object({ type: z.string().optional(), call_id: z.string().optional(), id: z.string().optional(), item: z.object({ type: z.string(), id: z.string().optional() }).loose().optional() }).loose().optional(),
})
const NotifiedItem = z.object({ itemId: z.string().optional(), item: z.object({ type: z.string(), id: z.string() }).loose().optional() }).loose()

const Thread = z.object({ thread: z.object({ id: z.string(), path: z.string().nullish() }).loose() }).loose()

function scripted(): (heard: string) => ScriptedReply | undefined {
  const steps: ScriptedReply[] = [
    { reasoning: "Run the command first.", text: "Running it.", call: { id: "call_1", name: "exec_command", arguments: { cmd: "echo probe" } } },
    { reasoning: "Now the file.", call: { id: "call_2", name: "apply_patch", input: "*** Begin Patch\n*** Add File: probe.txt\n+probe\n*** End Patch\n" } },
    { reasoning: "Both done.", text: "done" },
  ]
  let next = 0
  return () => steps[next++]
}

/** Each whole line appended to `path` since the last call, stamped when it became readable. */
function tail(path: string, seen: Seen[]): () => void {
  let offset = 0
  let partial = ""
  return () => {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    if (size <= offset) return
    const fd = openSync(path, "r")
    const bytes = Buffer.allocUnsafe(size - offset)
    const read = readSync(fd, bytes, 0, bytes.length, offset)
    closeSync(fd)
    offset += read
    const at = performance.now()
    const text = partial + bytes.toString("utf8", 0, read)
    const lines = text.split("\n")
    partial = lines.pop() ?? ""
    for (const line of lines) {
      try {
        const record = RolloutLine.parse(JSON.parse(line))
        const inner = record.payload?.type
        const item = inner === "item_completed" ? record.payload?.item : undefined
        const id = item?.id ?? record.payload?.call_id ?? record.payload?.id
        seen.push({ at, source: "rollout", kind: [record.type, inner, item?.type].filter(Boolean).join(" "), id })
      } catch {
        seen.push({ at, source: "rollout", kind: "(unreadable line)" })
      }
    }
  }
}

async function probe(home: string, cwd: string, env: NodeJS.ProcessEnv, model: string): Promise<Seen[]> {
  const executable = await resolveCodexExecutable()
  if (!executable) throw new Error("Codex is not installed")
  const child = spawn(executable, ["app-server"], { cwd, env: { ...env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] })
  const seen: Seen[] = []
  let done = () => {}
  const peer = rpcPeer(child, {
    jsonrpc: false,
    timeoutMs: 180_000,
    refusal: "the probe answers nothing",
    received(message) {
      const params = NotifiedItem.catch({}).parse(message.params ?? {})
      const item = params.item
      const itemId = params.itemId ?? item?.id
      seen.push({ at: performance.now(), source: "wire", kind: [message.method, item?.type].filter(Boolean).join(" "), id: itemId })
      if (message.method === "turn/completed") done()
    },
    answer: (message) => (message.method?.endsWith("requestApproval") ? { decision: "accept" } : undefined),
  })
  let timer: NodeJS.Timeout | undefined
  try {
    await peer.call("initialize", { clientInfo: { name: "mako-rollout-probe", version: "0" }, capabilities: CODEX_CLIENT_CAPABILITIES })
    peer.notify("initialized")
    const thread = Thread.parse(await peer.call("thread/start", { cwd, model, config: codexInteractiveConfig() }))
    const path = thread.thread.path
    if (!path) throw new Error("Codex named no rollout")
    const poll = tail(path, seen)
    timer = setInterval(poll, 1)
    const finished = new Promise<void>((resolve) => (done = resolve))
    const started = performance.now()
    seen.push({ at: started, source: "wire", kind: "(turn/start sent)" })
    await peer.call("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: PROMPT, text_elements: [] }] })
    await finished
    // What Codex writes after the turn's end.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    poll()
    return seen
  } finally {
    if (timer) clearInterval(timer)
    peer.close()
    await stop(child)
  }
}

function report(seen: Seen[]): void {
  const zero = seen.find((entry) => entry.kind === "(turn/start sent)")?.at ?? 0
  const ordered = [...seen].sort((a, b) => a.at - b.at)
  let deltas = 0
  for (const entry of ordered) {
    if (entry.kind.startsWith("item/") && entry.kind.includes("/delta") || entry.kind.endsWith("Delta")) {
      deltas++
      continue
    }
    if (deltas) console.log(`${"".padStart(9)}  wire     (${deltas} deltas)`)
    deltas = 0
    console.log(`${(entry.at - zero).toFixed(1).padStart(9)}  ${entry.source.padEnd(8)} ${entry.kind}${entry.id ? `  ${entry.id}` : ""}`)
  }
  // Each item the wire completed, against the rollout record of the same id.
  console.log("\nitem/completed → rollout record with the same id (ms; negative: the rollout was first)")
  for (const entry of ordered.filter((candidate) => candidate.source === "wire" && candidate.kind.startsWith("item/completed"))) {
    const records = ordered.filter((candidate) => candidate.source === "rollout" && candidate.id === entry.id)
    const lag = records.map((record) => `${record.kind} ${(record.at - entry.at).toFixed(1)}`)
    console.log(`  ${entry.kind} ${entry.id}: ${lag.join(" · ") || "no record with this id"}`)
  }
}

if (realModel) {
  const cwd = await realpath(await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mako-rollout-probe-")))
  await mkdir(join(cwd, ".git"), { recursive: true })
  report(await probe(join(process.env.HOME ?? "", ".codex"), cwd, process.env, realModel))
} else {
  await sandboxed("mako-rollout-probe", "codex", async (sandbox) => {
    const model = await scriptedModel({ reply: scripted() })
    const home = join(sandbox.home, ".codex")
    await mkdir(home, { recursive: true })
    await writeFile(join(home, "config.toml"), `openai_base_url = "${model.url}/v1"\nchatgpt_base_url = "${model.url}/backend-api"\n\n[features]\nplugins = false\n`)
    await writeFile(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "mako-rollout-probe" } satisfies JsonObject))
    try {
      report(await probe(home, sandbox.project, sandbox.env, "gpt-5.5"))
    } finally {
      await model.close()
    }
  })
}
