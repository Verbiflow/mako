import assert from "node:assert/strict"
import { loopSlices, type CpuProfile } from "@mako/host/base/loop-profile"

/**
 * What the held-loop profile names (`npm run test:loop-profile`): the host's own functions, in a checkout and in the
 * installed app, where they're bundled into `dist-electron/host` or under `node_modules/@mako` and it once named
 * none, and never a dependency's.
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
assert.deepEqual(framesAt("file:///Applications/Mako.app/Contents/Resources/app.asar/dist-electron/host/chunk-63VOYIZZ.js"), ["hold host/chunk-63VOYIZZ.js:10"], "the installed app's bundled host, which named nothing")
assert.deepEqual(framesAt("file:///work/mako/dist-electron/main/entry.js"), ["hold main/entry.js:10"], "a checkout's bundled main process")
assert.deepEqual(framesAt("file:///Applications/Mako.app/Contents/Resources/app.asar/dist-electron/host/vendor/x.js"), [], "nothing below a bundle's own chunks")
assert.deepEqual(framesAt("file:///Applications/Mako.app/Contents/Resources/app.asar/node_modules/zod/index.js"), [], "a dependency's isn't ours")
assert.deepEqual(framesAt("file:///work/mako/packages/host/node_modules/zod/index.js"), [], "nor one inside a package")
assert.deepEqual(framesAt("file:///Applications/Mako.app/Contents/Resources/app.asar/node_modules/@mako/host/node_modules/zod/index.js"), [], "nor one inside an installed package")
assert.deepEqual(framesAt("node:internal/timers"), [], "nor Node's")

// What held the loop with none of the host's functions on its stack is named by its innermost frame.
const outsideOf = (nodes: CpuProfile["nodes"], samples: number[]) =>
  loopSlices({ nodes, startTime: 0, samples, timeDeltas: samples.map(() => 10_000) }, 1).flatMap((slice) => slice.outside.map(({ frame: name }) => name))
assert.deepEqual(outsideOf([frame(1, "(root)", "", [2]), frame(2, "(garbage collector)", "")], [2, 2, 2]), ["(gc)"], "garbage collection")
assert.deepEqual(outsideOf([frame(1, "(root)", "", [2]), frame(2, "statSync", "")], [2, 2, 2]), ["statSync (native)"], "a native call")
assert.deepEqual(outsideOf([frame(1, "(root)", "", [2]), frame(2, "onStreamRead", "node:internal/stream_base_commons")], [2, 2]), ["onStreamRead node:internal/stream_base_commons"], "Node's")
assert.deepEqual(outsideOf([frame(1, "(root)", "", [2]), frame(2, "emit", "file:///A/app.asar/node_modules/@scope/watch/lib/index.js")], [2, 2]), ["emit @scope/watch"], "a dependency's, by its package")
assert.deepEqual(outsideOf([frame(1, "(root)", "", [2]), frame(2, "hold", "file:///work/mako/packages/host/dist/a.js", [3]), frame(3, "all", "")], [3, 3]), [], "a native call under the host's own is the host's, named by its caller")

console.log("loop profile: names the host's own functions in a checkout and in the installed app, and no one else's; what held it outside them, by its innermost frame")
