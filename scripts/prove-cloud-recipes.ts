import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { invokeRuntime } from "@mako/host/transport/connection"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"

/**
 * The recipe kept by the account, live, from this Mac's own host: one cloud Thread's agent saves and publishes a
 * recipe (numbered by the account, proved on its machine as it's published); a second cloud Thread of the same
 * repository, on a machine with nothing of its own, reads that version by the same number with the first machine's
 * proof, and its publish with no draft says where the published version was proved. Each conversation is closed at
 * the end. Spends two short turns; prints no secret.
 *
 *   npx tsx scripts/prove-cloud-recipes.ts [--harness claude] [--repository https://github.com/octocat/Hello-World]
 */
const { values } = parseArgs({
  options: {
    harness: { type: "string", default: "claude" },
    repository: { type: "string", default: "https://github.com/octocat/Hello-World" },
  },
})
const harness = values.harness
const { socket } = runtimeLocation(runtimeDataRoot(appDataFolder(), {}))
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)

const SnapshotSchema = z.object({
  session: z.object({ status: z.string() }).loose(),
  permissions: z.array(z.object({ id: z.string(), options: z.array(z.object({ optionId: z.string(), kind: z.string().optional() }).loose()).default([]) }).loose()).default([]),
  requests: z.array(z.object({ id: z.string(), status: z.string() }).loose()).default([]),
  blocks: z.array(z.object({ type: z.string() }).loose()).default([]),
}).loose()
type Snapshot = z.infer<typeof SnapshotSchema>
const snapshot = async (id: string): Promise<Snapshot> => SnapshotSchema.parse(await call("mako:live-snapshot", [id]))
const reply = (shot: Snapshot) => shot.blocks.filter((block) => block.type === "text").map((block) => z.object({ text: z.string() }).loose().safeParse(block).data?.text ?? "").join("\n")

/** Waits for the request to settle, answering each permission once with its first allowing option. */
async function settled(id: string, request: string, timeoutMs = 300_000): Promise<Snapshot> {
  const answered = new Set<string>()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const shot = await snapshot(id)
    for (const permission of shot.permissions) {
      if (answered.has(permission.id)) continue
      answered.add(permission.id)
      const allow = permission.options.find((option) => option.kind === "allow_once") ?? permission.options[0]
      await call("mako:live-permission", [id, permission.id, { kind: "choice", optionId: allow?.optionId ?? null }])
    }
    const found = shot.requests.find((entry) => entry.id === request)
    if (found && !["queued", "dispatching", "running", "pending"].includes(found.status)) return shot
    if (Date.now() > deadline) throw new Error(`timed out; session ${shot.session.status}`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

async function cloudTurn(cwd: string, text: string): Promise<{ id: string; text: string; ms: number }> {
  const id = randomUUID()
  const request = randomUUID()
  const started = performance.now()
  await call("mako:live-start", [harness, cwd, { conversationId: id, initialRequest: { id: request, text, attachments: [] }, cloud: { repository: { url: values.repository } } }])
  const shot = await settled(id, request)
  return { id, text: reply(shot), ms: Math.round(performance.now() - started) }
}

const mark = `cloud recipe proof ${new Date().toISOString().slice(0, 16)}`
const server = `node -e "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')"`
const cwd = await mkdtemp(join(tmpdir(), "mako-cloud-recipe-proof-"))
const opened: string[] = []
let failed = false
const check = (ok: boolean, what: string, detail: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `\n     ${detail.replaceAll("\n", "\n     ")}`}`)
  if (!ok) failed = true
}
try {
  const first = await cloudTurn(cwd, `Use the recipe_save tool to save this project's recipe: two values, PORT set to "{port}" and PROOF set to "${mark}", and one process named web whose command is \`${server}\` and whose port is "{port}". Give the reason "${mark}". Then call recipe_publish. Reply with only the text recipe_publish returned, verbatim.`)
  opened.push(first.id)
  console.log(`first machine: ${(first.ms / 1000).toFixed(1)} s\n${first.text}\n`)
  const version = /Published version (\d+)/.exec(first.text)?.[1]
  check(Boolean(version), "the first machine published a version, numbered by the account", first.text)

  const second = await cloudTurn(cwd, "Call the app_status tool and copy the recipe's `version:` line and every line under `versions:` exactly as it returned them. Then call recipe_publish with no draft and copy what it returned, verbatim. Reply with only those copied lines.")
  opened.push(second.id)
  console.log(`second machine: ${(second.ms / 1000).toFixed(1)} s\n${second.text}\n`)
  check(Boolean(version) && new RegExp(`version: ${version}, published`).test(second.text), `a second machine, with nothing of its own, runs version ${version ?? "?"} from the account`, second.text)
  check(new RegExp(`runs version ${version ?? "\\d+"}, the published one, which passed its proof on a cloud machine`).test(second.text), "its publish with no draft finds the first machine's proof, kept by the account for that place", second.text)
  check(new RegExp(`${version ?? "\\d+"}: published[^\\n]*proved on a cloud machine`).test(second.text), "its history lists the version with where it was proved", second.text)
} finally {
  for (const id of opened) await call("mako:live-close", [id]).catch(() => undefined)
  await rm(cwd, { recursive: true, force: true })
}
console.log(failed ? "\nThe proof failed." : "\nEvery check passed.")
process.exit(failed ? 1 : 0)
