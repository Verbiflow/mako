/**
 * The phone's Setup reads its page on mount: a read asked for before the screen installs its source (the page's effect
 * runs before the screen's) is made once the source arrives, and the page lands in the store without a focus.
 */
import assert from "node:assert/strict"
import type { SetupView } from "@mako/host/contracts/setup"
import { readSetup, setSetupSource, setupStore } from "@/state/setup"

const page: SetupView = { project: "shop", root: "shop", repository: "acme/shop", places: [], at: 0 }
const asked: string[] = []

assert.equal(await readSetup("shop"), undefined, "nothing answers before a source is installed")
assert.equal(setupStore.get().byFolder.shop, undefined)

setSetupSource({
  read: async (project) => {
    asked.push(project)
    return page
  },
  act: async () => ({ done: true }),
})
await new Promise((done) => setTimeout(done, 0))
assert.deepEqual(asked, ["shop"], "the read asked before the source is made as it's installed, with no focus")
assert.deepEqual(setupStore.get().byFolder.shop, page)

await readSetup("shop")
assert.deepEqual(asked, ["shop", "shop"], "a focus reads again")
setSetupSource(undefined)
console.log("Setup on the phone: the first read waits for the source and is made when it arrives")
