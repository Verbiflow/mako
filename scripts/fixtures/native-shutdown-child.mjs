import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = process.argv[2]
process.on("SIGTERM", () => {
  writeFileSync(join(root, "stopping"), String(process.pid))
})
writeFileSync(join(root, "ready"), String(process.pid))
const timer = setInterval(() => {
  if (existsSync(join(root, "release"))) {
    clearInterval(timer)
    process.exit(0)
  }
}, 10)
// Only a test-owned child; bound cleanup if the test itself fails.
setTimeout(() => process.exit(2), 15_000).unref()
