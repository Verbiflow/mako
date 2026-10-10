import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ComputerDriverClient } from "@mako/control-runtime/host"
import { Appshots, type WindowCapturer } from "../electron/appshots.ts"
import { computerPermissions } from "../electron/computer-permissions.ts"
import { fileResponse, localFile } from "../electron/file-response.ts"
import { onMac } from "../electron/platform.ts"
import { hostCommand } from "../electron/runtime-service.ts"
import { AgentViewsApp, NO_DESKTOP_WINDOWS } from "../electron/agent-views.ts"
import { DesktopChannel } from "../electron/desktop-channel.ts"

/**
 * The host as Node: how a launcher starts it, and the host's own answers
 * where only a desktop app can give them. Runs under plain Node and
 * Electron's Helper in Node mode alike (`test-host.ts`).
 */
const root = await mkdtemp(join(tmpdir(), "mako-host-node-"))
try {
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

  // Always Node: Electron's Helper on the bundle's or checkout's entry, plain Node where there is no Electron.
  const electron = "/Applications/Mako.app/Contents/MacOS/Mako"
  const packaged = hostCommand({ executable: electron, args: [], env: { KEEP: "yes" } })
  assert.deepEqual(packaged.args, ["/Applications/Mako.app/Contents/Resources/app.asar/dist-electron/entry.js"])
  assert.equal(packaged.env.ELECTRON_RUN_AS_NODE, "1")
  assert.equal(packaged.env.MAKO_HOST_EXECUTABLE, electron, "the host learns the executable that starts it and the agent views app")
  assert.equal(packaged.env.KEEP, "yes")
  const checkout = hostCommand({ executable: process.execPath, args: ["/src/mako"], env: {} })
  assert.equal(checkout.executable, process.execPath)
  assert.deepEqual(checkout.args, ["/src/mako/dist-electron/entry.js"])

  // With no Electron to start, agents read that Mako's own windows need the desktop app.
  const channel = new DesktopChannel()
  const noDesktop = new AgentViewsApp({ channel, launch: () => undefined })
  await assert.rejects(noDesktop.ready(), { message: NO_DESKTOP_WINDOWS })
  noDesktop.close()
  await assert.rejects(noDesktop.ready(), /closing/)
  channel.close()

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

  console.log(`host as Node (${process.versions.electron ? `Electron ${process.versions.electron} as Node` : `Node ${process.versions.node}`}): file previews read whole files and ranges themselves; hostCommand always starts Node on the bundle's or checkout's entry and tells the host its executable; with no Electron, agents are told Mako's windows need the desktop; no privacy readings claim nothing; app shots list the driver's windows and add pictures and live sources only from a capturer`)
} finally {
  await rm(root, { recursive: true, force: true })
}
