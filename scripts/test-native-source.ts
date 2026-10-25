import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bindingPath } from "@mako/host/conversations/live-runtime"
import { nativeSessionPath } from "@mako/host/threads/native-source"
import type { ThreadRef } from "@mako/sessions"

for (const harness of registeredHarnessIds()) {
  const first: ThreadRef = { harness, nativeId: "native-id", path: "/configured/store/first" }
  const second = { ...first, path: "/configured/store/second" }
  const identity = { harness, nativeId: first.nativeId }
  assert.equal(nativeSessionPath(identity, [first]), first.path)
  assert.equal(nativeSessionPath(identity, [first, second]), undefined, "duplicate IDs require a source, not list ordering")
  assert.equal(nativeSessionPath({ ...identity, nativePath: second.path }, [first, second]), second.path)
  assert.equal(nativeSessionPath({ ...identity, nativePath: "/old/source" }, [second]), second.path)
  assert.equal(nativeSessionPath(identity, [{ ...first, archived: true }]), undefined)
  assert.equal(nativeSessionPath(identity, [{ ...first, liveResume: false }]), undefined)
  assert.equal(nativeSessionPath(identity, [{ ...first, nativeId: "another" }]), undefined)
  assert.equal(nativeSessionPath(identity, [first, first]), first.path)
  const rollout = { ...first, path: "/configured/store/rollout.jsonl" }
  const compressed = { ...rollout, path: `${rollout.path}.zst` }
  assert.equal(nativeSessionPath({ ...identity, nativePath: rollout.path }, [compressed, second]), compressed.path, "the same file compressed in place is still the exact source")
}
// A binding takes the file under the encoding it is in now, even where the catalog still lists its other name.
const store = await mkdtemp(join(tmpdir(), "mako-native-source-"))
try {
  const rollout = join(store, "rollout.jsonl"), identity = { harness: "codex", nativeId: "native-id" }
  await writeFile(`${rollout}.zst`, "")
  assert.equal(bindingPath({ nativePath: () => rollout }, identity, rollout), `${rollout}.zst`, "a rollout compressed since the catalog listed it")
  assert.equal(bindingPath({}, identity, `${rollout}.zst`), `${rollout}.zst`)
  await writeFile(rollout, "")
  assert.equal(bindingPath({}, identity, `${rollout}.zst`), `${rollout}.zst`, "a file that is there keeps its name while its sibling is written")
  assert.equal(bindingPath({}, identity, join(store, "gone.jsonl")), join(store, "gone.jsonl"), "a file under neither encoding keeps its recorded name")
} finally { await rm(store, { recursive: true, force: true }) }
console.log("Native source selection: six harnesses, configured roots, relocated catalog source, exact-source preference (under either encoding), the file's encoding now and ambiguous/archive/unresumable rejection")
