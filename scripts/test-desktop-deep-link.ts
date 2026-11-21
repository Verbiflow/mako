import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { deepLinkInArgv, localFolderRefusal, openProjectLink, parseDeepLink, projectLinkOpener, resolveLinkedFolder, type FolderReader } from "../electron/desktop-deep-link.ts"
import { LINKED_FOLDER_MAX_LENGTH, linkableLocalFolder, windowsRemoteOrDevicePath } from "@mako/host/contracts/local-folder"
import { refuseRemoteFolder } from "@mako/host/workspaces/session-methods"

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
// Text that would show as something else in the question: direction overrides and isolates, zero-width characters,
// DEL and the C1 controls; and a path too long to show whole.
for (const mark of ["\u202e", "\u202a", "\u2066", "\u2069", "\u200b", "\u200f", "\ufeff", "\u007f", "\u0085", "\u009f"])
  assert.equal(parseDeepLink(open(`C:\\work\\${mark}gpj.exe`), true)?.kind, "refused", `misleading text U+${mark.codePointAt(0)?.toString(16)}`)
assert.equal(parseDeepLink(open(`C:\\${"a".repeat(LINKED_FOLDER_MAX_LENGTH)}`), true)?.kind, "refused", "a path too long to show")
assert.equal(parseDeepLink(open(`C:\\${"a".repeat(LINKED_FOLDER_MAX_LENGTH - 3)}`), true)?.kind, "open-project")
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
    realpath: (path) => {
      asked.push(path)
      return reader ? reader.realpath(path) : Promise.reject(new Error("no file system here"))
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
  const real: FolderReader = { lstat, realpath }
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

  // The person is shown, and gets, the folder the path really names: `..` walked, never the path as written.
  const roundabout = [folder, "..", "project", ".", "..", "project"].join(sep)
  assert.notEqual(roundabout, folder)
  opened.length = asked.length = 0
  assert.equal(await openProjectLink(roundabout, steps(true, reader)), "opened")
  assert.deepEqual([asked, opened], [[folder], [folder]], "the resolved folder is asked about and opened")

  // Checked again after Open: a folder swapped for a link while the question was open isn't opened.
  const swapped = join(scratch, "swapped")
  await mkdir(swapped)
  opened.length = 0
  const outcome = await openProjectLink(swapped, {
    ...steps(true, reader),
    confirm: async () => {
      await rename(swapped, join(scratch, "moved"))
      await symlink(folder, swapped, "junction")
      return true
    },
  })
  assert.deepEqual([outcome, opened], ["refused", []], "what changed under the question isn't opened")

  // A drive the person mapped to a share: a link is refused by where it really leads, since a page mustn't steer Mako
  // to any server; the host's own open still takes it, since the person chose that server and picks projects on it.
  const mapped: FolderReader = { lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }), realpath: async () => "\\\\server\\share\\work" }
  assert.deepEqual(await resolveLinkedFolder("Z:\\work", true, mapped), { refusal: "it isn't a folder on this computer's drives" })
  opened.length = asked.length = 0
  assert.equal(await openProjectLink("Z:\\work", { ...steps(true, mapped), windows: true }), "refused")
  assert.deepEqual([asked, opened], [[], []], "a mapped drive's folder is neither asked about nor opened through a link")
  assert.doesNotThrow(() => refuseRemoteFolder("Z:\\work", true), "and opens through the host's own call")
  assert.doesNotThrow(() => refuseRemoteFolder("C:\\work", true))
  // Written as a share or a device path, the host refuses it whoever asks.
  for (const path of ["\\\\server\\share", "//server/share", "\\\\?\\UNC\\server\\share", "\\\\?\\C:\\work", "\\\\server@SSL\\dav"])
    assert.throws(() => refuseRemoteFolder(path, true), /not on a network share/, path)
  assert.doesNotThrow(() => refuseRemoteFolder("//server/share", false), "only Windows has shares to refuse")

  // One question at a time: a link that arrives while another is asked about is dropped.
  const dropped: string[] = []
  const answers: ((open: boolean) => void)[] = []
  const openLink = projectLinkOpener({
    ...steps(true, reader),
    confirm: () => new Promise<boolean>((resolve) => { answers.push(resolve) }),
    dropped: (path) => { dropped.push(path) },
  })
  const asking = async () => {
    while (answers.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    return answers.shift()!
  }
  opened.length = 0
  const waiting = openLink(folder)
  const first = await asking()
  assert.equal(await openLink(folder), "dropped")
  assert.equal(await openLink(join(scratch, "missing")), "dropped", "even one that would be refused: nothing is checked meanwhile")
  first(true)
  assert.deepEqual([await waiting, opened, dropped.length], ["opened", [folder], 2])
  const next = openLink(folder)
  ;(await asking())(false)
  assert.equal(await next, "declined", "the next link is asked about once the first is answered")

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
