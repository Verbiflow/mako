import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deepLinkInArgv, localFolderRefusal, openProjectLink, parseDeepLink, type FolderReader } from "../electron/desktop-deep-link.ts"
import { linkableLocalFolder, windowsRemoteOrDevicePath } from "@mako/host/contracts/local-folder"

/** What a `mako:` link asks the desktop for, and which linked folders it may open: on its own, and here on this machine. */
const open = (path: string) => `mako://open?path=${encodeURIComponent(path)}`

// Windows: a drive's folder, and nothing that would make Windows connect to a server or reach a device.
assert.deepEqual(parseDeepLink(open("C:\\Users\\ada\\project"), true), { kind: "open-project", path: "C:\\Users\\ada\\project" })
assert.deepEqual(parseDeepLink(open("d:/work"), true), { kind: "open-project", path: "d:/work" })
const remote = [
  "\\\\attacker\\share",
  "//attacker/share",
  "\\/attacker/share",
  "\\\\?\\UNC\\attacker\\share",
  "\\\\?\\C:\\work",
  "\\\\.\\C:\\work",
  "\\\\.\\pipe\\x",
  "\\\\attacker@SSL\\dav",
  "\\\\attacker@SSL@8443\\dav\\x",
  "\\\\attacker@8080\\dav",
]
for (const path of remote) {
  assert.ok(windowsRemoteOrDevicePath(path) && !linkableLocalFolder(path, true), path)
  assert.equal(parseDeepLink(open(path), true)?.kind, "refused", `a share or device path is refused: ${path}`)
}
for (const path of ["C:relative", "project", "/work", "C:\\work:stream", "C:\\work\u0000", "C:\\x\\attacker@SSL\\dav"])
  assert.equal(parseDeepLink(open(path), true)?.kind, "refused", `not a drive's folder: ${JSON.stringify(path)}`)
// Elsewhere (macOS's `open-url`): an absolute path, never `//`.
assert.deepEqual(parseDeepLink(open("/Users/ada/project"), false), { kind: "open-project", path: "/Users/ada/project" })
assert.equal(parseDeepLink(open("//attacker/share"), false)?.kind, "refused")
assert.equal(parseDeepLink(open("project"), false)?.kind, "refused")
assert.deepEqual(parseDeepLink("mako://open", true), { kind: "focus" })

assert.deepEqual(parseDeepLink("mako://thread/session%3A42"), { kind: "open-thread", subject: "session:42" })
assert.deepEqual(parseDeepLink("mako://thread/"), { kind: "focus" })
assert.deepEqual(parseDeepLink("mako://"), { kind: "focus" })
assert.deepEqual(parseDeepLink("MAKO://thread/a"), { kind: "open-thread", subject: "a" })
assert.equal(parseDeepLink("https://runmako.co/thread/a"), undefined)
assert.equal(parseDeepLink("not a url"), undefined)
// Windows hands the link after `--` (the registration is `"Mako.exe" "--" "%1"`).
assert.deepEqual(deepLinkInArgv(["C:\\Mako\\Mako.exe", "--allow-file-access-from-files", "--", "mako://thread/abc"]), { kind: "open-thread", subject: "abc" })
assert.equal(deepLinkInArgv(["Mako.exe", "--at-login"]), undefined)
assert.equal(deepLinkInArgv(["Mako.exe", "C:\\Users\\ada\\project"]), undefined)

/** A reader that records every path it was asked about, over a real one or none. */
function watched(reader?: FolderReader): FolderReader & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    lstat: (path) => {
      asked.push(path)
      return reader ? reader.lstat(path) : Promise.reject(new Error("no file system here"))
    },
  }
}

// A share is refused from its text: not one file-system call, so nothing connects to it.
for (const path of remote) {
  const reader = watched()
  assert.equal(await localFolderRefusal(path, true, reader), "it isn't a folder on this computer's drives")
  assert.deepEqual(reader.asked, [], `nothing was read for ${path}`)
}

// The steps: refused paths never reach the question; a local folder opens only on Open.
const opened: string[] = []
const asked: string[] = []
const steps = (answer: boolean, reader: FolderReader) => ({
  windows: process.platform === "win32",
  reader,
  confirm: async (path: string) => {
    asked.push(path)
    return answer
  },
  open: (path: string) => {
    opened.push(path)
  },
  refused: () => undefined,
})

const scratch = await realpath(await mkdtemp(join(tmpdir(), "mako-deep-link-")))
try {
  const folder = join(scratch, "project")
  const file = join(scratch, "notes.txt")
  await mkdir(folder)
  await writeFile(file, "")
  const real: FolderReader = { lstat }
  const reader = watched(real)

  assert.equal(await openProjectLink(join(scratch, "missing"), steps(true, reader)), "refused", "a folder that isn't there")
  assert.equal(await openProjectLink(file, steps(true, reader)), "refused", "a file")
  assert.equal(await openProjectLink(process.platform === "win32" ? "\\\\127.0.0.1\\c$" : "//127.0.0.1/share", steps(true, reader)), "refused", "a share")
  assert.deepEqual(asked, [], "nothing refused was asked about")
  assert.ok(!reader.asked.some((path) => path.startsWith("\\\\") || path.startsWith("//")), "and no share was touched")

  assert.equal(await openProjectLink(folder, steps(false, reader)), "declined")
  assert.deepEqual([asked, opened], [[folder], []], "Cancel opens nothing")
  assert.equal(await openProjectLink(folder, steps(true, reader)), "opened")
  assert.deepEqual(opened, [folder], "a local folder opens once the person says Open")

  // A link or junction on the way could lead to a share: refused at the link, never followed.
  const link = join(scratch, "link")
  if (process.platform === "win32") {
    // A directory symlink to a share (the runner is an administrator); refused by its lstat alone.
    execFileSync("cmd.exe", ["/d", "/c", "mklink", "/D", link, "\\\\127.0.0.1\\c$"], { stdio: "ignore" })
  } else await symlink(folder, link)
  const linked = watched(real)
  assert.equal(await localFolderRefusal(join(link, "inside"), process.platform === "win32", linked), "it goes through a link or junction")
  assert.equal(linked.asked.at(-1), link, "the link itself was the last thing read")
} finally {
  await rm(scratch, { recursive: true, force: true })
}
console.log("desktop deep links: ok")
