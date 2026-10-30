import assert from "node:assert/strict"
import { MachineWorkspace } from "@mako/host/usage/machine-workspace"
import { declareSessionMethods, type SessionMethodsDeps } from "@mako/host/workspaces/session-methods"
import { HostMethods } from "@mako/host/transport/methods"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { startFailure } from "@mako/host/contracts/cloud-threads"

/**
 * The Thread's folder on a cloud machine, as a move asks for it (`MachineWorkspace`): made, it's answered at once; one
 * the agent couldn't make is asked for again, once per ask, several askers sharing it, and the move goes on with the
 * agent's new word, or the old one if none came in time or the agent can't be asked.
 */

// Made: answered as soon as the agent says, and nothing asked again.
{
  let asked = 0
  const workspace = new MachineWorkspace(() => (asked += 1, true))
  const waiting = workspace.settled()
  workspace.opened("/Users/ada/work/app")
  assert.deepEqual(await waiting, { path: "/Users/ada/work/app" })
  assert.deepEqual(await workspace.settled(), { path: "/Users/ada/work/app" })
  assert.equal(asked, 0)
  assert.equal(workspace.problem, undefined)
}

// Failed, then made on asking again: the move gets the folder; several asking at once share the one ask.
{
  let asked = 0
  const workspace = new MachineWorkspace(() => {
    asked += 1
    // The agent clones again and says it's made, as it does over its channel.
    queueMicrotask(() => workspace.opened("/Users/ada/work/app"))
    return true
  })
  workspace.failed("the agent's clone failed for /Users/ada/work/app: Clone succeeded, but checkout failed.")
  assert.match(workspace.problem ?? "", /checkout failed/)
  const [first, second] = await Promise.all([workspace.settled(), workspace.settled()])
  assert.deepEqual([first, second], [{ path: "/Users/ada/work/app" }, { path: "/Users/ada/work/app" }])
  assert.equal(asked, 1, "one ask for both")
  assert.equal(workspace.problem, undefined, "made now")
}

// Failed again on asking: the move hears the newest reason.
{
  const workspace = new MachineWorkspace(() => {
    queueMicrotask(() => workspace.failed("the agent's clone failed: Repository not found."))
    return true
  })
  workspace.failed("the agent's clone failed: Could not resolve host: github.com")
  assert.deepEqual(await workspace.settled(), { problem: "the agent's clone failed: Repository not found.", reason: "the agent's clone failed: Repository not found." })
}

// An agent that can't be asked, or doesn't answer in time: the old reason, and the next ask tries again.
{
  const unasked = new MachineWorkspace(() => false)
  unasked.failed("no agent")
  assert.deepEqual(await unasked.settled(), { problem: "no agent", reason: "no agent" })

  // The wait's timer doesn't hold a process open (the host's server does): this test holds it.
  const held = setInterval(() => undefined, 1_000)
  let asked = 0
  const silent = new MachineWorkspace(() => (asked += 1, true), 20)
  silent.failed("the agent's clone failed: early EOF")
  assert.deepEqual(await silent.settled(), { problem: "the agent's clone failed: early EOF", reason: "the agent's clone failed: early EOF" })
  assert.deepEqual(await silent.settled(), { problem: "the agent's clone failed: early EOF", reason: "the agent's clone failed: early EOF" })
  assert.equal(asked, 2, "each move's ask tries again")
  clearInterval(held)
}

// A start asks it as a move does (`unmade`): nothing to say while the agent never said it failed (a Thread with no
// repository works in the host's home); once it failed, asked again first, and the agent's own words if it still did.
{
  const none = new MachineWorkspace(() => assert.fail("nothing failed, so nothing is asked again"))
  assert.equal(await none.unmade(), undefined, "no repository: answered at once, never waiting on the agent")
  none.opened("/home/node/work/acme/shop")
  assert.equal(await none.unmade(), undefined)

  let asked = 0
  const access = "Mako can't read acme/shop on GitHub yet: give Mako's GitHub App access to it for acme at https://github.com/apps/mako/installations/new."
  const still = new MachineWorkspace(() => {
    asked += 1
    queueMicrotask(() => still.failed(`the agent's clone failed for /home/node/work/acme/shop: ${access}`, access))
    return true
  })
  still.failed(`the agent's clone failed for /home/node/work/acme/shop: ${access}`, access)
  assert.equal(await still.unmade(), access, "the agent's words alone, not the host's step and path")
  assert.equal(asked, 1)

  const given = new MachineWorkspace(() => (queueMicrotask(() => given.opened("/home/node/work/acme/shop")), true))
  given.failed("the agent's clone failed: Repository not found.", "Repository not found.")
  assert.equal(await given.unmade(), undefined, "access given since: the clone is made on asking again, and the start goes on")
}

// The boot every cloud start reads its folder from fails with the agent's words while the folder isn't made, so no
// client (the web, a phone, a Mac) starts a harness outside the repository; made, or with no repository, it boots.
{
  const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
  let unmade: string | undefined = "Mako can't read acme/shop on GitHub yet: give Mako's GitHub App access to it for acme at https://github.com/apps/mako/installations/new."
  let readied = 0
  const deps: SessionMethodsDeps = {
    liveSummaries: () => [],
    ready: async () => {
      readied += 1
      throw new Error("booted")
    },
    withHost: () => assert.fail("no tab is used"),
    platform: "linux",
    machine: async () => ({ fileManager: null, chooseFolder: false }),
    unmadeFolder: async () => unmade,
  }
  declareSessionMethods(methods, deps)
  const boot = () => methods.invoke("mako:boot", []).then(() => "went on", (error: Error) => error.message)
  const refused = await boot()
  assert.equal(readied, 0, "nothing of the host's tabs is read, so its home folder never reaches a start")
  assert.deepEqual(startFailure(refused), {
    said: "This Thread's repository couldn't be set up in the cloud, so nothing was started. Mako can't read acme/shop on GitHub yet: give Mako's GitHub App access to it for acme.",
    install: "https://github.com/apps/mako/installations/new",
  })
  unmade = undefined
  assert.equal(await boot(), "booted")
  assert.equal(readied, 1)
}

console.log("PASS: a cloud machine's folder: made, answered at once; failed, asked for again once per ask and shared, with the agent's new word, or the old one if it can't be asked or doesn't answer in time; a boot while it isn't made fails with the agent's words")
