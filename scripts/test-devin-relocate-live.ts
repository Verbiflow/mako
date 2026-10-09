// A Devin session going on in another folder, as a Thread's move into its
// worktree needs: the real Devin CLI in a sandbox, signed in through the
// account's linked credentials. A session made in one folder loads in
// another under the same ID with its turns, and its next turn remembers them
// and works in the new folder. Sends two short prompts; skips without Devin.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { acpClientCapabilities } from "../electron/providers/acp-source.ts"
import { devinAcpSource } from "../electron/providers/devin/acp.ts"
import { devinExecutable } from "../electron/providers/devin/executable.ts"
import { environmentForExecutable } from "../electron/executable.ts"
import { type RpcMessage, rpcPeer, sandboxed, stop } from "./harness-sandbox.ts"

const executable = devinExecutable()
const signedIn = join(homedir(), ".local/share/devin/credentials.toml")
if (!executable || !existsSync(signedIn)) {
  console.log(`devin relocate: Devin is ${executable ? "not signed in" : "not installed"}; skipped`)
  process.exit(0)
}

const Update = z.object({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string(), content: z.looseObject({ type: z.string(), text: z.string().optional() }).optional() }),
})
const NewSession = z.looseObject({ sessionId: z.string() })
const Prompted = z.looseObject({ stopReason: z.string() })
const word = `heron${Date.now() % 10_000}`

await sandboxed("devin-relocate", "devin", async (sandbox) => {
  await mkdir(join(sandbox.home, ".local/share/devin"), { recursive: true })
  await symlink(signedIn, join(sandbox.home, ".local/share/devin/credentials.toml"))
  const main = join(sandbox.root, "main")
  const worktree = join(sandbox.root, "worktree")
  await mkdir(main)
  await mkdir(worktree)
  const launch = await devinAcpSource.launch({ appPath: process.cwd(), execPath: process.execPath, cwd: main, env: sandbox.env })
  assert.ok(launch)
  const env = environmentForExecutable(executable, sandbox.env)
  launch.configureEnvironment(env)
  const capabilities = acpClientCapabilities(devinAcpSource)

  const agent = async (cwd: string) => {
    const child = spawn(executable, launch.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    const updates: z.infer<typeof Update>[] = []
    const peer = rpcPeer(child, {
      jsonrpc: true, timeoutMs: 180_000, refusal: "test",
      received: (message: RpcMessage) => {
        if (message.method !== "session/update") return
        const parsed = Update.safeParse(message.params)
        if (parsed.success) updates.push(parsed.data)
      },
    })
    // SAFETY: ACP's capability types are JSON; the peer's parameter type cannot see that through their optional fields.
    await peer.call("initialize", { protocolVersion: 1, clientCapabilities: capabilities } as never)
    const text = (kind: string, from = 0) => updates.slice(from).flatMap(({ update }) => update.sessionUpdate === kind ? [update.content?.text ?? ""] : []).join("")
    return {
      updates, text, peer,
      prompt: async (sessionId: string, message: string) => {
        const from = updates.length
        const done = Prompted.parse(await peer.call("session/prompt", { sessionId, prompt: [{ type: "text", text: message }] }))
        assert.equal(done.stopReason, "end_turn")
        return text("agent_message_chunk", from)
      },
      close: async () => { peer.close(); await stop(child) },
    }
  }

  const first = await agent(main)
  const { sessionId } = NewSession.parse(await first.peer.call("session/new", { cwd: main, mcpServers: [] }))
  await first.prompt(sessionId, `Remember this word: ${word}. Reply with exactly: noted`)
  await first.close()

  const store = join(sandbox.home, ".local/share/devin/cli/sessions.db")
  const moved = await agent(worktree)
  try {
    await moved.peer.call("session/load", { sessionId, cwd: worktree, mcpServers: [] })
    assert.match(moved.text("user_message_chunk"), new RegExp(word), "the session loads in the other folder with its turns")
    const answer = await moved.prompt(sessionId, "On one line: the word I asked you to remember, then the absolute path of your current working directory. Nothing else.")
    assert.match(answer, new RegExp(word), `its next turn remembers the first folder's turns: ${answer}`)
    assert.ok(answer.includes(worktree.replace(/^\/private/, "")), `it works in the new folder: ${sandbox.scrub(answer)}`)
    assert.ok(!answer.includes(`${main.replace(/^\/private/, "")}`), `not the old one: ${sandbox.scrub(answer)}`)
  } finally {
    await moved.close()
  }
  const after = new DatabaseSync(store, { readOnly: true })
  const folder = z.array(z.object({ working_directory: z.string() })).parse(after.prepare("SELECT working_directory FROM sessions WHERE id = ?").all(sessionId))[0]?.working_directory
  after.close()
  assert.equal(folder, main, "Devin keeps the folder the session started in on record, as Claude keeps its file there")
  console.log("devin relocate: loaded in the new folder under the same id with its turns; its next turn remembered them and named the new folder")
})
