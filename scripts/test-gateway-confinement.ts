import "./lib/scratch-git.mjs"
// What another device may ask of a host through the gateway: only the calls its clients send (`GATEWAY_ALLOWED`), and
// of those, any that names a path reads only the Thread's folders, after symlinks, never a folder of keys, through the
// descriptor it verified. Each path-reading channel is tried with a key and a `.png` symlink to it.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Git } from "@mako/git"
import { HostMethods } from "@mako/host/transport/methods"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { withHostClient } from "@mako/host/base/host-client"
import { GATEWAY_ALLOWED, MACHINE_REFUSED, gatewayAllows } from "@mako/host/contracts/gateway-allowed"
import { GATEWAY_REFUSED, fromHostOperation, hostCallInput, toHostOperation } from "@mako/host/contracts/host-operations"
import { hostChannels } from "@mako/host/contracts/host-call-inputs"
import { WorkspaceGit } from "@mako/host/git/workspace-git"
import { ArtifactPreviews } from "@mako/host/workspaces/artifact-previews"
import { ConversationFiles, OUTSIDE_THREAD_WORDS, WorkspaceFiles } from "@mako/host/workspaces/files"
import { confinedRoots, openConfined, secretPath } from "@mako/host/workspaces/confined-read"

const run = promisify(execFile)
const scratch = await mkdtemp(join(tmpdir(), "mako-gateway-confinement-"))
try {
  const root = join(scratch, "project")
  const dataDir = join(scratch, "thread-data")
  const elsewhere = join(scratch, "elsewhere")
  await Promise.all([mkdir(root, { recursive: true }), mkdir(dataDir, { recursive: true }), mkdir(join(elsewhere, ".ssh"), { recursive: true })])
  await run("git", ["init", "-q", "."], { cwd: root })
  const key = join(elsewhere, ".ssh", "id_rsa")
  await writeFile(key, "PRIVATE KEY")
  await writeFile(join(root, "notes.md"), "The Thread's notes")
  await writeFile(join(dataDir, "out.md"), "The Thread's data")
  // The two ways a key is reached from inside: a `.png` link to it in the folder, and a `.ssh` folder inside the root.
  await symlink(key, join(root, "shot.png"))
  await mkdir(join(root, ".ssh"))
  await writeFile(join(root, ".ssh", "id_rsa"), "PRIVATE KEY IN THE REPO")
  const git = new Git()
  const previews = new ArtifactPreviews(() => [])
  const owned = async () => dataDir
  const withheld = (read: { withheld?: string; contents: string; previewUrl?: string }, why: string) => {
    assert.equal(read.withheld, OUTSIDE_THREAD_WORDS, why)
    assert.equal(read.contents, "", `${why}: nothing of it is read`)
    assert.equal(read.previewUrl, undefined, `${why}: and nothing is signed`)
  }
  const keyed = (path: string) => [
    [key, "the key, by its absolute path"],
    ["~/.ssh/id_rsa", "~/.ssh/id_rsa"],
    [join(path, "shot.png"), "a .png symlink to the key"],
    [join(path, ".ssh", "id_rsa"), "a key in a .ssh folder inside the Thread's folder"],
  ] as const

  // mako:read-live-file (a conversation's read): confined to its folder, its repository and its data folder.
  {
    const files = new ConversationFiles(git, previews)
    assert.equal((await files.read(root, "notes.md", owned, undefined, true)).contents, "The Thread's notes")
    assert.equal((await files.read(root, join(dataDir, "out.md"), owned, undefined, true)).contents, "The Thread's data")
    for (const [path, why] of keyed(root)) {
      for (const purpose of [undefined, "preview"] as const) {
        const read = await files.read(root, path, owned, purpose, true).catch((error: Error) => ({ withheld: OUTSIDE_THREAD_WORDS, contents: "", error }))
        withheld(read, `read-live-file${purpose ? " (preview)" : ""}: ${why}`)
      }
    }
  }

  // mako:read-file (a cloud folder's read, a window's workspace): the same confinement.
  {
    const workspace = new WorkspaceFiles(root, new WorkspaceGit(git, root), previews)
    assert.equal((await workspace.read("notes.md", { confined: true })).contents, "The Thread's notes")
    for (const [path, why] of keyed(root)) {
      const read = await workspace.read(path, { confined: true }).catch(() => ({ withheld: OUTSIDE_THREAD_WORDS, contents: "" }))
      withheld(read, `read-file: ${why}`)
    }
    assert.equal((await workspace.read(key)).contents, "PRIVATE KEY", "this Mac's own window still reads what the person opens")
  }

  // A Thread rooted at the home folder, or above it, opens nothing of it.
  {
    const home = join(scratch, "home")
    await mkdir(join(home, "project"), { recursive: true })
    await writeFile(join(home, "diary.md"), "Private")
    assert.deepEqual(await confinedRoots([home, scratch, "/"], home), [], "the home folder, its parent and / are no root")
    assert.deepEqual(await confinedRoots([join(home, "project")], home), [join(await (await import("node:fs/promises")).realpath(home), "project")], "a folder below it is")
    assert.equal(await openConfined(join(home, "diary.md"), await confinedRoots([home], home)), undefined)
  }

  // The descriptor read is the file verified: a key's folder is refused by name, and a link swapped in reads nothing.
  {
    assert.ok(secretPath("/Users/me/.ssh/id_rsa") && secretPath("/Users/me/.aws/credentials") && secretPath("/Users/me/.gnupg/x") && secretPath("/Users/me/Library/Keychains/login.keychain-db"))
    assert.ok(!secretPath("/Users/me/project/sshd.md"))
    const roots = await confinedRoots([root])
    const opened = await openConfined(join(root, "notes.md"), roots)
    assert.ok(opened, "a file in the folder opens")
    await opened!.handle.close()
    assert.equal(await openConfined(join(root, "shot.png"), roots), undefined, "a link out of the folder doesn't")
  }

  // Off the allowlist: every call no other device's client sends is refused through the gateway, by name and unrun.
  {
    const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
    const ran: string[] = []
    for (const channel of ["mako:thread-file", "mako:stage-file-path", "mako:resolve-turn-media", "mako:watch-file"] as const) {
      assert.equal(GATEWAY_ALLOWED.has(channel), false, `${channel} isn't another device's call`)
      const refused = fromHostOperation(toHostOperation(channel, hostCallInput([key], false), { id: randomUUID(), target: { kind: "runtime", runtimeId: "laptop" }, actor: { kind: "client", client: "web", deviceId: "phone" }, correlationId: "c", attempt: 1 }))
      assert.ok(refused.kind === "refused" && refused.problem.type.endsWith("forbidden"), `${channel} is refused at the gateway`)
      // SAFETY: each handler only records that it ran; its arguments are never read.
      methods.handle(channel, (() => { ran.push(channel) }) as never)
      await assert.rejects(withHostClient("gateway:web:phone", () => methods.invoke(channel, [key], "gateway:web:phone")), new RegExp(GATEWAY_REFUSED))
    }
    assert.deepEqual(ran, [], "and no handler ran")
    const declared = new Set<string>(hostChannels)
    for (const channel of GATEWAY_ALLOWED) assert.ok(declared.has(channel), `${channel} is a host call`)
  }
  // A machine (`gateway:runtime:`) is never the person: what would start an agent, make a Session, run an app or answer
  // an approval here is refused to it, while a person's own device makes it and the machine keeps its agent's doors.
  {
    const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
    const ran: string[] = []
    const personal = ["mako:live-start", "mako:live-capture", "mako:thread-create-session", "mako:thread-app-start", "mako:live-prompt", "mako:live-permission"] as const
    for (const channel of personal)
      // SAFETY: each handler only records that it ran; its arguments are never read.
      methods.handle(channel, (() => { ran.push(channel) }) as never)
    const machine = "gateway:runtime:m-1.g1"
    const operation = (channel: string, actor: Parameters<typeof toHostOperation>[2]["actor"]) =>
      fromHostOperation(toHostOperation(channel, hostCallInput([], false), { id: randomUUID(), target: { kind: "runtime", runtimeId: "laptop" }, actor, correlationId: "c", attempt: 1 }))
    for (const channel of personal) {
      assert.equal(GATEWAY_ALLOWED.has(channel), true, `${channel} is a person's device's call`)
      const refused = operation(channel, { kind: "runtime", runtimeId: "m-1.g1" })
      assert.ok(refused.kind === "refused" && refused.problem.type.endsWith("forbidden"), `${channel} is refused to a machine at the gateway`)
      assert.ok(operation(channel, { kind: "client", client: "web", deviceId: "phone" }).kind === "call", `${channel} reaches the host from the person's phone`)
      await assert.rejects(methods.invoke(channel, [], machine), new RegExp(MACHINE_REFUSED.split(":")[0]!), `${channel} is refused to a machine in the method table`)
    }
    assert.deepEqual(ran, [], "no handler of the person's ran for a machine")
    assert.ok(gatewayAllows("mako:live-start", "gateway:web:phone"), "the person's phone starts one")
    assert.ok(gatewayAllows("mako:agents-list", machine) && operation("mako:agents-list", { kind: "runtime", runtimeId: "m-1.g1" }).kind === "call", "a machine keeps its agent's doors")
    assert.ok(gatewayAllows("mako:simulators-list", "gateway:runtime:borrower"), "and a borrower its simulator")
    // The gateway itself (`gateway:<thread>`), packing a Thread off its machine, asks whether its conversation still
    // runs; no other runtime may, and the gateway's id opens nothing else.
    assert.ok(operation("mako:live-state", { kind: "runtime", runtimeId: "gateway:t-1" }).kind === "call", "the gateway's own runtime reads a conversation's state")
    assert.ok(gatewayAllows("mako:live-state", "gateway:runtime:gateway:t-1"))
    const stateRefused = operation("mako:live-state", { kind: "runtime", runtimeId: "m-1.g1" })
    assert.ok(stateRefused.kind === "refused" && stateRefused.problem.type.endsWith("forbidden"), "a machine doesn't")
    for (const runtimeId of ["borrower", "gateway:t-1"]) {
      const started = operation("mako:live-start", { kind: "runtime", runtimeId })
      assert.ok(started.kind === "refused" && started.problem.type.endsWith("forbidden"), `${runtimeId} still can't start a conversation`)
    }
    await assert.rejects(methods.invoke("mako:live-start", [], "gateway:runtime:borrower"), new RegExp(MACHINE_REFUSED.split(":")[0]!))
  }

  console.log("PASS: another device reaches only the allowlisted calls; a machine only its agent's doors, simulators and moves; read-live-file and read-file read only the Thread's folders after symlinks, never a key, through the descriptor they verified; a Thread at ~ opens nothing")
} finally {
  await rm(scratch, { recursive: true, force: true })
}
