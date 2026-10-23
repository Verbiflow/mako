import assert from "node:assert/strict"
import { MachineWorkspace } from "@mako/host/usage/machine-workspace"

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
  assert.deepEqual(await workspace.settled(), { problem: "the agent's clone failed: Repository not found." })
}

// An agent that can't be asked, or doesn't answer in time: the old reason, and the next ask tries again.
{
  const unasked = new MachineWorkspace(() => false)
  unasked.failed("no agent")
  assert.deepEqual(await unasked.settled(), { problem: "no agent" })

  // The wait's timer doesn't hold a process open (the host's server does): this test holds it.
  const held = setInterval(() => undefined, 1_000)
  let asked = 0
  const silent = new MachineWorkspace(() => (asked += 1, true), 20)
  silent.failed("the agent's clone failed: early EOF")
  assert.deepEqual(await silent.settled(), { problem: "the agent's clone failed: early EOF" })
  assert.deepEqual(await silent.settled(), { problem: "the agent's clone failed: early EOF" })
  assert.equal(asked, 2, "each move's ask tries again")
  clearInterval(held)
}

console.log("PASS: a cloud machine's folder: made, answered at once; failed, asked for again once per ask and shared, with the agent's new word, or the old one if it can't be asked or doesn't answer in time")
