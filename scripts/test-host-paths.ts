/**
 * The project paths a person may type, on the platform the host runs on and Windows' by its rules anywhere: `~/` and
 * `/` everywhere, and on Windows `~\`, a drive (`C:\`, `C:/`) or a share; what a new project or a chat's is made at.
 *
 *   npx tsx scripts/test-host-paths.ts
 */
import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import { expandPath, trimmedPath, typedWholePath, wholePathAdvice, windowsSharePath } from "@mako/host/workspaces/project-folders"

for (const typed of ["/Users/someone/app", "~/app"]) {
  assert.ok(typedWholePath(typed, false), typed)
  assert.ok(typedWholePath(typed, true), typed)
}
for (const typed of ["C:\\Users\\someone\\app", "c:/work/app", "~\\app", "\\\\server\\share\\app"]) {
  assert.ok(typedWholePath(typed, true), `${typed} is whole on Windows`)
  assert.ok(!typedWholePath(typed, false), `${typed} isn't elsewhere`)
}
for (const typed of ["app", "C:app", "..\\app", "\\\\server", "\\\\?\\C:\\work", "\\\\.\\pipe\\x", "//?/C:/work", "//./C:/work"]) assert.ok(!typedWholePath(typed, true), `${typed} isn't whole`)
assert.ok(windowsSharePath("\\\\server\\share") && windowsSharePath("//server/share") && !windowsSharePath("C:\\work"))
assert.equal(trimmedPath("C:\\work\\app\\\\", true), "C:\\work\\app")
assert.equal(trimmedPath("C:\\", true), "C:\\", "a drive keeps its own separator")
assert.equal(trimmedPath("/work/app//", false), "/work/app")
assert.equal(trimmedPath("C:\\work\\", false), "C:\\work\\", "elsewhere a backslash is a name's")
assert.match(wholePathAdvice(true), /C:\\/)
assert.match(wholePathAdvice(false), /~\/ or \//)
if (process.platform === "win32") {
  assert.equal(expandPath("C:\\work\\app", homedir()), "C:\\work\\app")
  assert.equal(expandPath("c:/work/app", homedir()), "c:\\work\\app")
  assert.equal(expandPath("~\\app", homedir()), join(homedir(), "app"))
}
assert.equal(expandPath("~/app", homedir()), join(homedir(), "app"))
console.log("PASS: typed project paths, Windows' and the host's own")
