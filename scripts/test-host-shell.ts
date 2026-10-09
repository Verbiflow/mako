import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ComputerDriverClient } from "@mako/control-runtime/host"
import { Appshots, type WindowCapturer } from "../electron/appshots.ts"
import { computerPermissions } from "../electron/computer-permissions.ts"
import { fileResponse, localFile } from "../electron/file-response.ts"
import { nodeShell } from "../electron/host-shell.ts"
import { onMac } from "../electron/platform.ts"
import { hostCommand } from "../electron/runtime-service.ts"

/**
 * The host without Electron: the shell it runs in under Node, how a launcher
 * picks that runtime, and the host's own answers where Electron's main
 * process used to give them. Runs under plain Node and Electron's Helper in
 * Node mode alike (`test-host.mjs`).
 */
const root = await mkdtemp(join(tmpdir(), "mako-host-shell-"))
try {
  // Node's shell draws no windows and says so for Mako's own window.
  const shell = nodeShell()
  assert.equal(shell.runtime, "node")
  assert.deepEqual(shell.disagreements, [])
  assert.equal(shell.singleInstance(), true)
  assert.deepEqual(shell.clients(), [])
  assert.equal(shell.windowOpen() || shell.windowVisible(), false)
  assert.equal(shell.deskPage, undefined)
  assert.equal(shell.privacy ?? shell.capturer ?? shell.updater ?? shell.nativeCrashes, undefined)
  await assert.rejects(shell.createWindow(), /needs Electron/)
  await assert.rejects(shell.openPreviewWindow(), /needs Electron/)
  assert.deepEqual(await shell.notifier.notify(1, { id: "n1", subject: "s", title: "t", body: "b", silent: true }), { delivered: false, reason: "unsupported" })
  assert.equal(await shell.notifier.permission(), "unsupported")
  await shell.ready()

  // A file preview reads the file itself, whole or by range, as Electron's file fetch did.
  const file = join(root, "notes.txt")
  await writeFile(file, "0123456789")
  const whole = await fileResponse(await localFile(file), file, new Request("mako-file://x"))
  assert.equal(whole.status, 200)
  assert.equal(await whole.text(), "0123456789")
  assert.equal(whole.headers.get("content-length"), "10")
  const part = await fileResponse(await localFile(file), file, new Request("mako-file://x", { headers: { range: "bytes=2-4" } }))
  assert.equal(part.status, 206)
  assert.equal(await part.text(), "234")
  await assert.rejects(localFile(join(root, "missing.txt")))
  await assert.rejects(localFile(root), /Not a file/)

  // The switch: Electron's main process by default, its Helper in Node mode on request.
  const electron = "/Applications/Mako.app/Contents/MacOS/Mako"
  const inherited = { ELECTRON_RUN_AS_NODE: "1", KEEP: "yes" }
  const main = hostCommand({ executable: electron, args: [], env: inherited })
  assert.equal(main.executable, electron)
  assert.deepEqual(main.args, [])
  assert.equal(main.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(main.env.MAKO_HOST_EXECUTABLE, electron)
  assert.equal(main.env.KEEP, "yes")
  const packaged = hostCommand({ executable: electron, args: [], env: { MAKO_HOST_RUNTIME: "node" } })
  assert.deepEqual(packaged.args, ["/Applications/Mako.app/Contents/Resources/app.asar/dist-electron/entry.js"])
  assert.equal(packaged.env.ELECTRON_RUN_AS_NODE, "1")
  assert.equal(packaged.env.MAKO_HOST_EXECUTABLE, electron)
  const checkout = hostCommand({ executable: process.execPath, args: ["/src/mako"], env: { MAKO_HOST_RUNTIME: "node" } })
  assert.deepEqual(checkout.args, ["/src/mako/dist-electron/entry.js"])

  // Without a desktop to read macOS's privacy settings, nothing is granted and nothing is claimed.
  const unknown = computerPermissions(undefined)
  assert.equal(unknown.supported, onMac())
  assert.equal(unknown.accessibility, false)
  assert.equal(unknown.screenRecording, "unknown")
  const read = computerPermissions({ accessibility: () => true, screen: () => "granted" })
  if (onMac()) assert.deepEqual([read.accessibility, read.screenRecording], [true, "granted"])

  // App shots list windows from the driver; pictures and live sources come from a capturer when there is one.
  const driver: ComputerDriverClient = {
    listTools: async () => [],
    callTool: async () => ({
      content: [],
      structuredContent: { windows: [
        { pid: 10, window_id: 2, app_name: "Notes", title: "", is_on_screen: true },
        { pid: 11, window_id: 3, app_name: "Calendar", title: "Today", is_on_screen: true },
        { pid: 12, window_id: 4, app_name: "Hidden", title: "", is_on_screen: false },
      ] },
    }),
    onClose: () => {},
    close: async () => {},
  }
  let capturer: WindowCapturer | undefined
  const shots = new Appshots(async () => ({ command: "driver", args: [] }), async () => driver, () => capturer)
  assert.deepEqual((await shots.windows(true)).map((window) => [window.app, window.thumbnail]), [["Calendar", undefined], ["Notes", undefined]])
  assert.equal(await shots.source({ pid: 10, windowId: 2 }), null)
  capturer = {
    windows: async () => [{ windowId: 2, name: "Notes — Groceries", thumbnail: { mimeType: "image/jpeg", data: "AAAA" } }],
    source: async (windowId) => `window:${windowId}:0`,
  }
  const pictured = await shots.windows(true)
  assert.deepEqual(pictured.map((window) => [window.title, window.thumbnail?.data]), [["Notes — Groceries", "AAAA"]])
  assert.equal(await shots.source({ pid: 10, windowId: 2 }), "window:2:0")
  assert.equal(await shots.source({ pid: 12, windowId: 4 }), null)
  await shots.close()

  console.log(`host shell (${process.versions.electron ? `Electron ${process.versions.electron} as Node` : `Node ${process.versions.node}`}): Node's shell draws no windows and says Mako's own window needs Electron; file previews read whole files and ranges themselves; MAKO_HOST_RUNTIME=node starts Electron's Helper on the bundle's or checkout's entry and the host learns Electron's executable; no privacy readings claim nothing; app shots list the driver's windows and add pictures and live sources only from a capturer`)
} finally {
  await rm(root, { recursive: true, force: true })
}
