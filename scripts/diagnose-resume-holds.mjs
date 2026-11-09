// This process is evidence only after the required, uninstrumented CI step failed.
// It cannot replace that result; the workflow keeps the original step's failure.
import { fileURLToPath } from "node:url"

if (process.env.MAKO_RESUME_DIAGNOSTICS !== "1") throw new Error("Resume diagnostics require MAKO_RESUME_DIAGNOSTICS=1")
const { installHostProbes, report } = await import("./lib/resume-diagnostics.mjs")
await installHostProbes(fileURLToPath(new URL("..", import.meta.url)))
try {
  await import("./test-resume-holds.ts")
} finally {
  // Let performance-observer GC entries arrive after the measured work has ended.
  await new Promise((resolve) => setImmediate(resolve))
  report()
}
