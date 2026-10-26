import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkspaceClients } from "@mako/host/workspaces/clients"
import { hostClient, withHostClient } from "@mako/host/base/host-client"
import { ArtifactPreviews } from "@mako/host/workspaces/artifact-previews"
import { childBackend } from "@mako/host/workspaces/watch-backend"

const gitRunner = new Git()
const services = { git: gitRunner, previews: new ArtifactPreviews(() => []), watch: childBackend(), attachments: join(tmpdir(), "mako-test-attachments") }

const root = await mkdtemp(join(tmpdir(), "mako-workspace-clients-"))
const clients = new WorkspaceClients(() => {}, services)
try {
  const a = join(root, "a")
  const b = join(root, "b")
  await Promise.all([mkdir(a), mkdir(b)])
  const [first, second, repeated] = await Promise.all([clients.ready("a"), clients.ready("b"), clients.ready("a")])
  assert.equal(first, repeated)
  assert.notEqual(first.activeId, second.activeId)
  await Promise.all([first.active.setCwd(a), second.active.setCwd(b)])
  const gate = Promise.withResolvers<void>()
  const readA = withHostClient("a", async () => {
    await gate.promise
    return (await clients.ready(hostClient())).active.workspace
  })
  const readB = withHostClient("b", async () => (await clients.ready(hostClient())).active.workspace)
  assert.equal(await readB, b)
  gate.resolve()
  assert.equal(await readA, a)
  assert.equal(hostClient(), "app")
  await clients.release("a")
  assert.equal((await clients.ready("b")).active.workspace, b)
  assert.equal((await clients.ready("b")).activeId, second.activeId)
  assert.notEqual((await clients.ready("a")).activeId, second.activeId)

  const home = join(root, "home")
  await mkdir(home)
  await assert.rejects(clients.home(join(root, "missing")), "a home that isn't there is refused")
  await clients.home(home)
  assert.equal((await clients.ready("b")).active.workspace, home, "an open client gets a tab in the home in front")
  assert.equal((await clients.ready("b")).ids.length, 2, "and keeps the tab it had")
  assert.equal((await clients.ready("gateway:client:device")).active.workspace, home, "a new client starts in the home")
  console.log("Workspace clients: concurrent startup, independent cwd/git boundaries, async request ownership, scoped disposal, and a home every client starts in verified")
} finally {
  await clients.dispose()
  await rm(root, { recursive: true, force: true })
}
