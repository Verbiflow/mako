import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { hostCommand } from "@mako/host/base/host-command"

const nodeCommand = promisify(execFile)
for (const stream of ["stdout", "stderr"] as const) {
  for (const maxBuffer of [1, 3, 4, 5, 6, 9, 10, 20]) {
    const args = ["-e", `process.${stream}.write("日本🙂abc")`]
    const reference = await nodeCommand(process.execPath, args, { encoding: "utf8", maxBuffer }).catch((error: { code: string; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
    const actual = await hostCommand(process.execPath, args, { maxBuffer }).catch((error: { code: string; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
    assert.deepEqual(actual, reference, `${stream}, maxBuffer=${maxBuffer}: decoded slicing must match Node execFile`)
  }
}
console.log("UTF-8 stdout/stderr and maxBuffer overflow match Node execFile, including multibyte and surrogate boundaries")
