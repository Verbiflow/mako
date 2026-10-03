import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { claudeCommands, claudeHooks } from "../electron/providers/claude/authoring.ts"

const execute = promisify(execFile)
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

// Native discovery uses the bundled binary and sends no model prompt.
const root = await mkdtemp(join(tmpdir(), "mako-authoring-native-"))
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 20_000)
const input = Promise.withResolvers<void>()
controller.signal.addEventListener("abort", () => input.resolve(), { once: true })
try {
  await claudeCommands.write(root, "mako-proof", "---\ndescription: Native authoring discovery acceptance\n---\nReview $ARGUMENTS.\n", null)
  const session = query({ prompt: (async function* () { await input.promise; yield* [] })(), options: { cwd: root, settingSources: ["project"], strictMcpConfig: true, abortController: controller } })
  try {
    await session.initializationResult()
    const commands = await session.supportedCommands()
    assert.ok(commands.some((command) => command.name === "mako-proof"), "The bundled Claude binary must discover the saved project command")
    console.log("Bundled Claude SDK discovered the authored native command; no model prompt was sent")
  } finally { session.close() }
  // The native CLI's init-only route runs SessionStart without a model request.
  // Record its real stdin payload, rather than invoking our hook script directly.
  const proof = join(root, "hook-proof.json")
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(proof)},fs.readFileSync(0,'utf8'))`
  await claudeHooks.write(root, "configuration", JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}` }] }] }), null)
  const binary = join(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")
  await execute(binary, ["--init-only", "--setting-sources", "project", "--strict-mcp-config"], { cwd: root, timeout: 20_000, maxBuffer: 256 * 1024 })
  const event = z.object({ hook_event_name: z.literal("SessionStart"), cwd: z.string(), session_id: z.string().min(1) }).parse(JSON.parse(await readFile(proof, "utf8")))
  assert.equal(event.hook_event_name, "SessionStart")
  assert.equal(event.cwd, await realpath(root))
  console.log("Bundled Claude executed the authored SessionStart hook and supplied its native event; no model prompt was sent")
} finally {
  clearTimeout(timeout)
  controller.abort()
  await rm(root, { recursive: true, force: true })
}
