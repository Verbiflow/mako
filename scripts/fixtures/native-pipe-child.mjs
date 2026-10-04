import { spawn } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [mode, root] = process.argv.slice(2)
if (mode === "leader") {
  const child = spawn(process.execPath, [import.meta.filename, "descendant", root], { stdio: ["ignore", process.stdout, process.stderr] })
  child.unref()
  writeFileSync(join(root, "leader-pid"), String(process.pid))
  process.stdout.write("leader\n")
} else {
  const deadline = Date.now() + 15_000
  const timer = setInterval(() => {
    if (!existsSync(join(root, "release-pipes")) && Date.now() < deadline) return
    clearInterval(timer)
    process.stdout.write("descendant:" + "🦉".repeat(16_384) + "\n")
  }, 10)
}
