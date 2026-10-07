// Grok's folder trust against the real grok binary in a sealed HOME, with no
// account and no model call. A project with an `.mcp.json` and an
// `AGENTS.md` is gated: a client that doesn't advertise
// `x.ai/folderTrust.interactive` is never asked, Mako's Grok source is, its
// "Trust project" answer is saved to the sealed `trusted_folders.toml`, and
// the next process doesn't ask again.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type ClientCapabilities } from "@agentclientprotocol/sdk"
import { parse as parseToml } from "smol-toml"
import { z } from "zod"
import { acpAnswer } from "../electron/acp-decoder.ts"
import { acpReadable, acpWritable } from "../electron/acp-stream.ts"
import type { JsonObject } from "../electron/codex-app-json.ts"
import { acpClientCapabilities } from "../electron/providers/acp-source.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"

const installed = (() => {
  try {
    execFileSync("grok", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

interface Asked {
  method: string
  params: JsonObject
  /** Whether `session/new` had answered when the request arrived. */
  afterOpen: boolean
}

const TrustSchema = z.object({ folders: z.record(z.string(), z.object({ trusted: z.boolean() })) })

if (!installed) console.log("Grok folder trust: skipped, grok is not installed")
else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grok-trust-")))
  const after: (() => void)[] = []
  try {
    const home = join(root, "home")
    const project = join(root, "project")
    mkdirSync(join(home, ".grok"), { recursive: true })
    mkdirSync(project, { recursive: true })
    execFileSync("git", ["init", "-q", project])
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: {} }))
    writeFileSync(join(project, "AGENTS.md"), "Answer in one word.\n")
    // A stand-in model, so Grok opens sessions with no account; nothing is prompted, so it's only listed.
    const models = createServer((_, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "double", object: "model" }] }))
    })
    await new Promise<void>((listening) => models.listen(0, "127.0.0.1", listening))
    after.push(() => models.close())
    const port = z.object({ port: z.number() }).parse(models.address()).port
    writeFileSync(join(home, ".grok", "config.toml"), `[models]\ndefault = "double"\n\n[model.double]\nmodel = "double"\nbase_url = "http://127.0.0.1:${port}/v1"\nname = "Double"\napi_key = "double-key"\napi_backend = "chat_completions"\ncontext_window = 128000\n`)
    const env = { PATH: process.env.PATH, HOME: home, GROK_HOME: join(home, ".grok"), GROK_TELEMETRY_ENABLED: "0", GROK_DISABLE_AUTOUPDATER: "1" }
    const launch = await grokAcpSource.launch({ appPath: "/app", execPath: process.execPath, cwd: project, env, access: "ask" })
    assert.ok(launch)

    const open = async (capabilities: ClientCapabilities, answer: string | null) => {
      const child = spawn(launch.command, launch.args, { cwd: project, env, stdio: ["pipe", "pipe", "ignore"] })
      const asked: Asked[] = []
      let opened = false
      const client: Client = {
        async requestPermission() {
          return { outcome: { outcome: "cancelled" } }
        },
        async sessionUpdate() {},
        async extNotification() {},
        async extMethod(method: string, params: JsonObject) {
          asked.push({ method, params, afterOpen: opened })
          const request = grokAcpSource.requests?.decode(method, params)
          assert.ok(request, `Mako reads ${method}`)
          return acpAnswer(request.ask, { kind: "choice", optionId: answer })
        },
      }
      const connection = new ClientSideConnection(() => client, ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)))
      try {
        await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: capabilities })
        const session = await connection.newSession({ cwd: project, mcpServers: [] })
        opened = true
        for (let waited = 0; waited < 3_000 && !asked.length; waited += 50) await delay(50)
        // Grok saves the grant before it reloads the project's servers.
        if (asked.length) await delay(300)
        return { asked, sessionId: session.sessionId }
      } finally {
        child.kill("SIGTERM")
      }
    }
    const trusted = () => {
      try {
        return TrustSchema.parse(parseToml(readFileSync(join(home, ".grok", "trusted_folders.toml"), "utf8"))).folders[project]?.trusted === true
      } catch {
        return false
      }
    }

    const silent = await open({ ...acpClientCapabilities(grokAcpSource), _meta: {} }, "trust")
    assert.deepEqual(silent.asked, [], "a client that can't answer is never asked, and the project's config is ignored")

    const first = await open(acpClientCapabilities(grokAcpSource), "trust")
    assert.equal(first.asked.length, 1, "Mako's Grok source is asked once")
    const [request] = first.asked
    assert.equal(request!.method, "_x.ai/folder_trust/request")
    assert.equal(request!.params.sessionId, first.sessionId)
    assert.equal(request!.params.workspace, project, "the grant covers the repository's root")
    assert.deepEqual(request!.params.configKinds, ["mcp", "instructions"], "Grok names what it ignores")
    assert.ok(trusted(), "Trust project is saved where Grok reads it")

    const second = await open(acpClientCapabilities(grokAcpSource), "trust")
    assert.deepEqual(second.asked, [], "a trusted project isn't asked about again")

    console.log(`Grok folder trust: asked only a client that can answer (${request!.afterOpen ? "after" : "before"} session/new answered), saved the grant, and didn't ask again`)
  } finally {
    for (const done of after) done()
    rmSync(root, { recursive: true, force: true })
  }
}
