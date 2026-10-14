import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { devinExecutable } from "@mako/host/harnesses/devin/executable"
import { storeReader } from "./decode-compare.ts"

/** Each harness's CLI, driven headless on this machine's sign-ins, for the record-store proofs. */
export interface Harness {
  /** Starts a session in `cwd`; its native id. */
  start(cwd: string, prompt: string): Promise<{ id: string; out: string }>
  resume(cwd: string, id: string, prompt: string): Promise<string>
  /** The session's transcript is an append-only file. */
  appends?: true
}

const devin = devinExecutable() ?? "devin"
const DevinSessionsSchema = z.array(z.object({ id: z.string() }))

export function run(command: string, argv: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", reject)
    child.once("close", (status) => {
      const out = Buffer.concat(stdout).toString("utf8")
      if (status === 0) resolve(out)
      else reject(new Error(`${command} ${argv.slice(0, 3).join(" ")} exited ${status}: ${(Buffer.concat(stderr).toString("utf8") || out).slice(-800)}`))
    })
  })
}

const jsonLines = (out: string) => out.split("\n").flatMap((line) => {
  try {
    return [JSON.parse(line)]
  } catch {
    return []
  }
})

export const HARNESSES = {
  claude: {
    appends: true,
    async start(cwd, prompt) {
      const out = await run("claude", ["-p", prompt, "--output-format", "json"], cwd)
      return { id: JSON.parse(out).session_id, out }
    },
    resume: async (cwd, id, prompt) => JSON.parse(await run("claude", ["-p", "--resume", id, prompt, "--output-format", "json"], cwd)).result,
  },
  codex: {
    appends: true,
    async start(cwd, prompt) {
      const out = await run("codex", ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", prompt], cwd)
      return { id: jsonLines(out).find((event) => event.type === "thread.started").thread_id, out }
    },
    resume: async (cwd, id, prompt) => jsonLines(await run("codex", ["exec", "resume", id, "--json", "--skip-git-repo-check", prompt], cwd))
      .filter((event) => event.type === "item.completed" && event.item.type === "agent_message").map((event) => event.item.text).join("\n"),
  },
  cursor: {
    async start(cwd, prompt) {
      const out = await run("cursor-agent", ["-p", "--output-format", "json", "--trust", prompt], cwd)
      return { id: JSON.parse(out).session_id, out }
    },
    resume: async (cwd, id, prompt) => JSON.parse(await run("cursor-agent", ["-p", "--output-format", "json", "--trust", "--resume", id, prompt], cwd)).result,
  },
  opencode: {
    async start(cwd, prompt) {
      const out = await run("opencode", ["run", "--format", "json", prompt], cwd)
      return { id: jsonLines(out).find((event) => event.sessionID)?.sessionID, out }
    },
    resume: async (cwd, id, prompt) => jsonLines(await run("opencode", ["run", "--format", "json", "-s", id, prompt], cwd))
      .filter((event) => event.type === "text").map((event) => event.part?.text ?? "").join("\n"),
  },
  grok: {
    appends: true,
    async start(cwd, prompt) {
      const id = randomUUID()
      const out = await run("grok", ["-p", prompt, "-s", id, "--always-approve"], cwd)
      return { id, out }
    },
    resume: (cwd, id, prompt) => run("grok", ["-r", id, "-p", prompt, "--always-approve"], cwd),
  },
  devin: {
    async start(cwd, prompt) {
      const out = await run(devin, ["-p", prompt, "--respect-workspace-trust", "false"], cwd)
      const listed = await run(devin, ["list", "--format", "json"], cwd)
      const [newest] = DevinSessionsSchema.parse(JSON.parse(listed))
      if (!newest) throw new Error("devin lists no session after starting one")
      return { id: newest.id, out }
    },
    resume: (cwd, id, prompt) => run(devin, ["-r", id, "-p", prompt, "--respect-workspace-trust", "false"], cwd),
  },
} satisfies Record<string, Harness>

/** The harness `name` names, or an error listing the ones there are. */
export function harnessNamed(name: string): Harness {
  const found = Object.entries(HARNESSES).find(([key]) => key === name)
  if (!found) throw new Error(`No harness ${name}; there are ${Object.keys(HARNESSES).join(", ")}`)
  return found[1]
}

/** Where the harness lists session `id`, waiting for it to appear. */
export async function nativePath(harness: string, id: string, home: string): Promise<string> {
  const reader = storeReader(harness, home)
  for (let attempt = 0; attempt < 20; attempt++) {
    const found = (await reader.discover()).find((file) => file.path.includes(id))
    if (found) return found.path
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`${harness} lists no session ${id}`)
}

/** Deletes a test session from the harness's own store. */
export async function removeSession(harness: string, id: string, home: string): Promise<void> {
  const reader = storeReader(harness, home)
  const left = (await reader.discover().catch(() => [])).find((file) => file.path.includes(id))
  if (left && !(await reader.remove(left.path).catch(() => false))) await rm(harness === "cursor" ? dirname(left.path) : left.path, { recursive: true, force: true })
}
