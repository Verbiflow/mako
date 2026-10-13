import assert from "node:assert/strict"
import { readFile, realpath } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { AuthoringChange, AuthoringTarget } from "@mako/host/contracts/native-authoring"
import { authoringWorld } from "./native-authoring-world.ts"

const execute = promisify(execFile)
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/**
 * What Mako writes for Claude Code, read back by the Claude Code the SDK
 * bundles, with no model request: the SDK lists a command Mako created, and
 * the CLI's init-only run executes a SessionStart hook Mako added, with
 * Claude's own event on its stdin.
 */
const world = await authoringWorld("claude")
const apply = async (target: AuthoringTarget, change: AuthoringChange) => {
  const plan = await world.authoring.preview(world.project, target, change)
  await world.authoring.apply(world.project, target, change, plan.revision)
}
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 20_000)
const input = Promise.withResolvers<void>()
controller.signal.addEventListener("abort", () => input.resolve(), { once: true })
try {
  const commands = { provider: "claude", family: "commands" as const, cwd: world.project }
  const project = (await world.authoring.view(world.project, commands)).sources.find((source) => source.scope === "project")!
  await apply(commands, { kind: "create", sourceId: project.id, draft: { kind: "command", invocation: "mako:proof", text: "---\ndescription: Native authoring discovery acceptance\n---\nReview $ARGUMENTS.\n" } })
  const session = query({ prompt: (async function* () { await input.promise; yield* [] })(), options: { cwd: world.project, settingSources: ["project"], strictMcpConfig: true, abortController: controller } })
  try {
    await session.initializationResult()
    const listed = await session.supportedCommands()
    assert.ok(listed.some((command) => command.name === "mako:proof"), "The bundled Claude Code lists the command Mako created, named with its folder")
    console.log("Bundled Claude SDK listed the command Mako created as /mako:proof; no model prompt was sent")
  } finally { session.close() }

  // The CLI's init-only run fires SessionStart without a model request; the hook records the event it was given.
  const proof = join(world.root, "hook-proof.json")
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(proof)},fs.readFileSync(0,'utf8'))`
  const hooks = { provider: "claude", family: "hooks" as const, cwd: world.project }
  const settings = (await world.authoring.view(world.project, hooks)).sources.find((source) => source.scope === "project")!
  await apply(hooks, { kind: "create", sourceId: settings.id, draft: { kind: "hook", event: "SessionStart", type: "command", run: `${shellQuote(process.execPath)} -e ${shellQuote(script)}` } })
  const binary = join(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")
  await execute(binary, ["--init-only", "--setting-sources", "project", "--strict-mcp-config"], { cwd: world.project, timeout: 20_000, maxBuffer: 256 * 1024 })
  const event = z.object({ hook_event_name: z.literal("SessionStart"), cwd: z.string(), session_id: z.string().min(1) }).parse(JSON.parse(await readFile(proof, "utf8")))
  assert.equal(event.cwd, await realpath(world.project))
  assert.match(await readFile(settings.path, "utf8"), /"permissions"/, "the project's other settings stay beside the hook")
  console.log("Bundled Claude ran the SessionStart hook Mako added beside the project's other settings, and gave it its native event; no model prompt was sent")
} finally {
  clearTimeout(timeout)
  controller.abort()
  await world.cleanup()
}
