import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
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
console.log("Native source selection: six harnesses, configured roots, relocated catalog source, exact-source preference (under either encoding) and ambiguous/archive/unresumable rejection")
