import "./lib/scratch-git.mjs"
// Full access asks nothing. Each harness Mako drives against a stand-in for
// its model starts in the mode its session lists as full access, through
// Mako's own host, and its model runs the calls that ask in every lesser
// mode, or in a harness's widest one: a write outside the project from the
// shell and from the harness's own write tool, a request on the network, a
// `git push`, and two `rm`s whose targets a static check can't read (a
// command's output, and a variable set from one), as agents write them. No
// card may open at any point of the turn, and the turn must end.
//
// Every call runs, with one exception that is Claude Code's own: an `rm` on
// a target that could expand to `/` or the home folder trips a safety check
// it keeps for a person even under bypassPermissions, and never lets a rule
// allow. Mako declines those in Full access, as Claude's own desktop host
// does in bypass, and the model hears Claude's reason, which names the
// rewrite that passes; the rewrite then runs unasked.
//
// It also times each call: from the model's reply carrying the call to the
// harness's next request carrying its result, the harness's own overhead
// plus the command. `--json <file>` writes those timings.
//
//   npm run test:full-access-never-asks [-- <harness>...] [--json <file>]
//
// Harnesses run as Mako finds them (the Agent SDK's own Claude Code; PATH,
// CODEX_EXECUTABLE, OPENCODE_BIN_PATH, DEVIN_CLI_PATH), each in a sandbox of
// its own; one that isn't installed is skipped. Cursor runs only on its own
// model, through an SDK that has no permission request at all: its listing
// is checked instead.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { LiveRequestSchema } from "@mako/host/conversations/live-journal"
import { script, type Call, type Step } from "./decode-scenarios.ts"
import { sandboxed, type Sandbox } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel } from "./scripted-model.ts"
import { scriptedWindsurf } from "./scripted-windsurf.ts"
import { startHost, type StartedHost } from "./linux-host/host-process.mjs"

const SnapshotSchema = z.object({
  session: z.object({
    status: z.string(),
    error: z.string().optional(),
    modes: z.array(z.object({ id: z.string(), access: z.string().optional(), enforcement: z.string().optional() }).loose()),
    currentMode: z.string().nullable(),
    launchMode: z.string().optional(),
  }).loose(),
  permissions: z.array(z.object({ id: z.string(), title: z.string().optional() }).loose()),
  requests: z.array(LiveRequestSchema),
}).loose()
type Snapshot = z.infer<typeof SnapshotSchema>
const DescriptorsSchema = z.array(z.object({
  provider: z.string(),
  capabilities: z.object({ approvals: z.object({ state: z.string(), reason: z.string().optional() }).loose() }).loose(),
}).loose())
const AvailabilitySchema = z.record(z.string(), z.boolean())

/** Each harness's shell and write tools, as its model calls them (the vocabularies in `harness-decode-pairs.ts`). */
const TOOLS = new Map<string, { shell: (command: string) => Call; write: (path: string, content: string) => Call }>([
  ["claude", { shell: (command) => ({ name: "Bash", arguments: { command, description: command.slice(0, 60) } }), write: (file_path, content) => ({ name: "Write", arguments: { file_path, content } }) }],
  ["codex", { shell: (cmd) => ({ name: "exec_command", arguments: { cmd } }), write: (path, content) => ({ name: "apply_patch", input: `*** Begin Patch\n*** Add File: ${path}\n+${content.trimEnd()}\n*** End Patch\n` }) }],
  ["grok", { shell: (command) => ({ name: "run_terminal_command", arguments: { command, description: command.slice(0, 60) } }), write: (file_path, content) => ({ name: "write", arguments: { file_path, content } }) }],
  ["opencode", { shell: (command) => ({ name: "shell", arguments: { command } }), write: (path, content) => ({ name: "write", arguments: { path, content } }) }],
  ["devin", { shell: (command) => ({ name: "exec", arguments: { command } }), write: (file_path, content) => ({ name: "write", arguments: { file_path, content } }) }],
])

/**
 * The calls a harness refuses in its widest mode, without asking anyone, and
 * what its model hears: the floor it keeps under every access level. Claude
 * Code's rm safety check asks a person even under bypassPermissions, and Mako
 * declines it in Full access (`ClaudePermissions`); Codex, on approval policy
 * `never`, rejects every `rm -f` style command itself. Both reasons name the
 * rewrite that passes, which runs unasked.
 */
const FLOORS = new Map<string, { what: string; says: string }>([
  ["claude", { what: "Claude Code's rm safety check declined unasked", says: "Dangerous rm operation" }],
  ["codex", { what: "Codex rejected the rm -f style commands itself", says: "rm -f style commands are not permitted" }],
])

/** What each call is for, in the order the model makes them. */
const CALLS = ["rm on a command's output", "rm on a variable set from one", "shell write outside the project", "write tool outside the project", "network request", "git push", "rewritten rm"] as const
type CallName = typeof CALLS[number]

/** Where the calls act, made before the host starts: a project with a remote, and folders outside it. */
async function stage(sandbox: Sandbox): Promise<{ outside: string; remote: string }> {
  const outside = join(sandbox.root, "outside")
  const remote = join(sandbox.root, "remote.git")
  for (const folder of ["doomed1", "doomed2/a", "doomed2/b", "doomed3"]) await mkdir(join(outside, folder), { recursive: true })
  await writeFile(join(sandbox.project, "doomed1.txt"), join(outside, "doomed1"))
  await writeFile(join(sandbox.project, "doomed2.txt"), join(outside, "doomed2"))
  await writeFile(join(sandbox.project, "notes.md"), "The release ships on Friday.\n")
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: sandbox.env, stdio: "ignore" })
  git(sandbox.root, "init", "-q", "--bare", remote)
  git(sandbox.project, "init", "-q")
  git(sandbox.project, "-c", "user.name=Mako", "-c", "user.email=tests@mako.invalid", "commit", "-q", "--allow-empty", "-m", "Start")
  git(sandbox.project, "remote", "add", "origin", remote)
  return { outside, remote }
}

/** Reads the snapshot no faster than four times a second until `done` holds, failing the moment a card opens. */
async function untilNoCard(read: () => Promise<Snapshot>, done: (snapshot: Snapshot) => boolean, label: string): Promise<Snapshot> {
  const deadline = Date.now() + 180_000
  for (;;) {
    const snapshot = await read()
    assert.deepEqual(snapshot.permissions.map((request) => request.title), [], `${label}: Full access asked the person`)
    if (done(snapshot)) return snapshot
    if (snapshot.session.status === "failed" || snapshot.session.status === "closed") throw new Error(`${label}: the session ${snapshot.session.status}: ${snapshot.session.error ?? "no error"}`)
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await delay(250)
  }
}

const args = process.argv.slice(2)
const jsonAt = args.indexOf("--json")
const jsonFile = jsonAt === -1 ? undefined : args[jsonAt + 1]
const only = args.filter((arg, index) => !arg.startsWith("--") && (jsonAt === -1 || index !== jsonAt + 1))
/** Each harness's call timings, ms from the reply that made the call to the request that carried its result. */
const timings: Record<string, Partial<Record<CallName, number>>> = {}
const bin = await mkdtemp(join(tmpdir(), "mako-host-bin-"))
const program = resolve("packages/host/dist/mako-host.js")
await chmod(program, 0o755)
await symlink(program, join(bin, "mako-host"))
try {
  for (const harness of ["claude", "codex", "grok", "opencode", "devin", "cursor"].filter((name) => !only.length || only.includes(name)))
    await sandboxed("mako-full-access-never-asks", harness, async (sandbox) => {
      const env: NodeJS.ProcessEnv = { ...sandbox.env, PATH: `${bin}:${sandbox.env.PATH}` }
      const data = join(sandbox.root, "mako")
      const start = (): Promise<StartedHost> => startHost({ dataRoot: data, output: join(sandbox.root, "host-output.log"), env })
      const tools = TOOLS.get(harness)
      if (!tools) {
        // Cursor: its listing, as the host gives it, is all there is to check without its own model.
        const host = await start()
        try {
          const approvals = DescriptorsSchema.parse(await host.call("mako:harness-descriptors")).find((descriptor) => descriptor.provider === harness)?.capabilities.approvals
          assert.ok(approvals, `the host lists ${harness}`)
          assert.notEqual(approvals.state, "implemented", `${harness} declares approvals, and this test has no stand-in to run them`)
          console.log(`${harness}: nothing can ask, as it declares: ${approvals.reason ?? approvals.state}`)
        } finally {
          await host.stop()
        }
        return
      }
      const { outside, remote } = await stage(sandbox)
      const url = { value: "" }
      const floor = FLOORS.get(harness)
      const steps: (Step & { what?: CallName })[] = [
        { what: "rm on a command's output", call: () => tools.shell("rm -rf $(cat doomed1.txt)") },
        { what: "rm on a variable set from one", call: () => tools.shell("D=$(cat doomed2.txt); for t in a b; do rm -rf $D/$t; done"), ...floor && { hears: floor.says } },
        { what: "shell write outside the project", call: () => tools.shell(`echo shell > ${join(outside, "shell.txt")}`), ...floor && { hears: floor.says } },
        { what: "write tool outside the project", call: () => tools.write(join(outside, "written.txt"), "written\n") },
        { what: "network request", call: () => tools.shell(`curl -sf ${url.value}/probe -o /dev/null && echo reached`) },
        { what: "git push", call: () => tools.shell("git push -q origin HEAD:refs/heads/probe && echo pushed") },
        // The rewrite each floor's reason asks for, which every harness then runs as is.
        { what: "rewritten rm", call: () => tools.shell(`rm -r ${join(outside, "doomed3")}`), hears: "reached" },
        { text: "Done." },
      ]
      const scenario = { name: "full-access-never-asks", about: "Calls that ask in lesser modes, in full access", files: {}, turns: [{ prompt: "Run the calls you are given, then say Done.", steps }] }
      // SAFETY: these steps make their calls themselves and never read the vocabulary; only plan and subagent steps do, and there are none.
      const scripted = script(scenario, {} as never, sandbox.project)
      /** When each conversation request arrived, and the call its reply made. */
      const heard: { at: number; what?: CallName }[] = []
      let taken = 0
      const reply = (request: string) => {
        const answered = scripted.reply(request)
        heard.push({ at: performance.now(), what: answered ? steps[taken++]?.what : undefined })
        return answered
      }
      const model = harness === "devin"
        ? await scriptedWindsurf({ reply, waits: scripted.waits })
        : await scriptedModel({ reply, answers: new Map([...SCRIPTED_GETS, ["/probe", "{}"]]) })
      url.value = model.url
      await pointAt(harness, sandbox, model.url, env, "mako-full-access")
      const host = await start()
      try {
        if (!AvailabilitySchema.parse(await host.call("mako:harness-availability"))[harness]) {
          console.log(`${harness}: skipped, not installed`)
          return
        }
        let id = randomUUID()
        const snapshot = async () => SnapshotSchema.parse(await host.call("mako:live-snapshot", id))
        const open = async (modeId?: string) => {
          await host.call("mako:live-start", harness, sandbox.project, { conversationId: id, modeId })
          return untilNoCard(snapshot, (current) => current.session.status === "ready", "the session to start")
        }
        const ready = await open()
        const full = ready.session.modes.find((mode) => mode.access === "full")
        assert.ok(full, `${harness} lists no full access: ${JSON.stringify(ready.session.modes)}`)
        if (full.enforcement === "launch") {
          await host.call("mako:live-close", id)
          id = randomUUID()
          await open(full.id)
        } else await host.call("mako:live-mode", id, full.id)

        const began = performance.now()
        await host.call("mako:live-prompt", id, randomUUID(), scenario.turns[0]!.prompt)
        const done = await untilNoCard(snapshot, (current) => current.session.status === "ready" && current.requests.length > 0 && current.requests.every((request) => request.status === "completed"), "the turn")
        const turnMs = performance.now() - began
        assert.equal((full.enforcement === "launch" ? done.session.launchMode : done.session.currentMode), full.id, `the turn ran in ${full.id}`)
        assert.ok(scripted.done(), `the model was asked for every step: ${scripted.taken.join(", ")}`)
        assert.deepEqual(scripted.unheard, [], "each step heard what the call before it returned")

        // What the calls did.
        assert.equal(existsSync(join(outside, "doomed1")), floor !== undefined, "the rm on a command's output")
        assert.equal(existsSync(join(outside, "doomed2", "a")) || existsSync(join(outside, "doomed2", "b")), floor !== undefined, "the rm on a variable set from one")
        assert.equal(existsSync(join(outside, "doomed3")), false, "the rewritten rm")
        assert.equal((await readFile(join(outside, "shell.txt"), "utf8")).trim(), "shell")
        assert.equal((await readFile(join(outside, "written.txt"), "utf8")).trim(), "written")
        assert.equal(execFileSync("git", ["rev-parse", "--verify", "-q", "refs/heads/probe"], { cwd: remote, env: sandbox.env, encoding: "utf8" }).trim().length, 40, "the push landed")

        const own: Partial<Record<CallName, number>> = {}
        for (const [index, request] of heard.entries()) {
          const next = heard[index + 1]
          if (request.what && next) own[request.what] = Math.round(next.at - request.at)
        }
        timings[harness] = own
        console.log(`${harness}: ${full.id}, ${CALLS.length} calls, no card; turn ${Math.round(turnMs)} ms; ${floor ? `${floor.what}, the rewrite ran; ` : ""}ms per call: ${CALLS.map((what) => `${what} ${own[what] ?? "-"}`).join(", ")}`)
      } finally {
        await host.stop()
        await model.close()
      }
    })
  if (jsonFile) await writeFile(jsonFile, JSON.stringify(timings, null, 2) + "\n")
} finally {
  await rm(bin, { recursive: true, force: true })
}
