import assert from "node:assert/strict"
import { loopSlices, type CpuProfile } from "@mako/host/base/loop-profile"

/**
 * What the held-loop profile names (`npm run test:loop-profile`): the host's own functions, in a checkout and in the
 * installed app, where they're under `node_modules/@mako` and it once named none, and never a dependency's.
 */
const frame = (id: number, functionName: string, url: string, children?: number[]): CpuProfile["nodes"][number] => ({ id, callFrame: { functionName, url, lineNumber: 9 }, ...(children && { children }) })
const framesAt = (url: string) => {
  const profile: CpuProfile = {
    nodes: [frame(1, "(root)", "", [2]), frame(2, "hold", url)],
    startTime: 0,
    samples: [2, 2, 2, 2],
    timeDeltas: [10_000, 10_000, 10_000, 10_000],
  }
  return loopSlices(profile, 1).flatMap((slice) => slice.frames.map(({ frame: name }) => name))
}

assert.deepEqual(framesAt("file:///work/mako/packages/host/dist/conversations/agents.js"), ["hold host/conversations/agents.js:10"], "a checkout's build")
assert.deepEqual(framesAt("file:///work/mako/packages/host/src/conversations/agents.ts"), ["hold host/conversations/agents.ts:10"], "a checkout's source")
assert.deepEqual(framesAt("file:///Applications/Mako.app/Contents/Resources/app.asar/node_modules/@mako/host/dist/conversations/agents.js"), ["hold host/conversations/agents.js:10"], "the installed app's")
assert.deepEqual(framesAt("file:///Applications/Mako.app/Contents/Resources/app.asar/node_modules/zod/index.js"), [], "a dependency's isn't ours")
assert.deepEqual(framesAt("file:///work/mako/packages/host/node_modules/zod/index.js"), [], "nor one inside a package")
assert.deepEqual(framesAt("file:///Applications/Mako.app/Contents/Resources/app.asar/node_modules/@mako/host/node_modules/zod/index.js"), [], "nor one inside an installed package")
assert.deepEqual(framesAt("node:internal/timers"), [], "nor Node's")

console.log("loop profile: names the host's own functions in a checkout and in the installed app, and no one else's")
