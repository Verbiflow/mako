import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ComputerDriverClient } from "@mako/control-runtime/host"
import { Appshots, type WindowCapturer } from "@mako/host/control/appshots"
import { computerPermissions } from "@mako/host/control/computer-permissions"
import { GNOME_HELPER, KWIN_CAPTURE_ENTRY, desktopPermissions, desktopPermissionsPending, grantDesktopPermissions, revokeDesktopPermissions, withExtension, withoutExtension, type DesktopGrantContext } from "@mako/host/control/desktop-grants"
import { integrationCatalog } from "@mako/host/tools/integrations"
import type { MakoComputerPermissions } from "@mako/host/contracts/mcp-skills-integrations"
import { desktopAskHint, linuxDesktop } from "@mako/control-runtime/desktop"
import { fileResponse, localFile } from "@mako/host/workspaces/file-response"
import { onMac, onWindows } from "@mako/host/base/platform"
import { hostCommand } from "@mako/host/transport/service"
import { HOST_HEAP_GROWTH, HOST_NODE_OPTIONS } from "@mako/host/base/process-warnings"
import { AgentViewsApp, NO_DESKTOP_WINDOWS } from "@mako/host/control/agent-views"
import { DesktopChannel } from "@mako/host/control/desktop-channel"

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
  assert.deepEqual(packaged.args, [...HOST_NODE_OPTIONS, "/Applications/Mako.app/Contents/Resources/app.asar/dist-electron/host/entry.js"])
  assert.equal(packaged.env.ELECTRON_RUN_AS_NODE, "1")
  assert.equal(packaged.env.MAKO_HOST_EXECUTABLE, electron, "the host learns the executable that starts it and the agent views app")
  assert.equal(packaged.env.KEEP, "yes")
  const checkout = hostCommand({ executable: process.execPath, args: ["/src/mako"], env: {} })
  assert.equal(checkout.executable, process.execPath)
  assert.deepEqual(checkout.args, [...HOST_NODE_OPTIONS, "/src/mako/dist-electron/entry.js"])
  // `mako-host`, as a machine starts it, gives Node the same options on its first line.
  const program = (await readFile("packages/host/src/mako-host.ts", "utf8")).split("\n")[0]
  assert.equal(program, `#!/usr/bin/env -S node ${HOST_NODE_OPTIONS.join(" ")}`)
  assert.ok(HOST_NODE_OPTIONS.includes(HOST_HEAP_GROWTH), "the host collects as it goes")
  const limitWith = (options: readonly string[]) => Number(execFileSync(process.execPath, [...options, "-p", "require('node:v8').getHeapStatistics().heap_size_limit"], { encoding: "utf8" }).trim())
  assert.equal(limitWith(HOST_NODE_OPTIONS), limitWith([]), "and its heap may still reach what it could: growing less can't run it out of memory")
  assert.ok(HOST_NODE_OPTIONS.filter((option) => option !== HOST_HEAP_GROWTH).every((option) => /^--disable-warning=[A-Z0-9_]+$/.test(option)), "only warnings Mako has checked, each by its code")

  // With no Electron to start, agents read that Mako's own windows need the desktop app.
  const channel = new DesktopChannel()
  const noDesktop = new AgentViewsApp({ channel, launch: () => undefined })
  await assert.rejects(noDesktop.ready(), { message: NO_DESKTOP_WINDOWS })
  noDesktop.close()
  await assert.rejects(noDesktop.ready(), /closing/)
  channel.close()

  // Without a desktop to read macOS's privacy settings, nothing is granted and nothing is claimed.
  const unknown = computerPermissions({ packaged: false, appRoot: process.cwd() }, undefined, undefined)
  // Windows has no grant to read: the driver works from the start.
  if (onWindows()) assert.deepEqual(unknown, { supported: false, persistentAcrossUpdates: true, accessibility: true, screenRecording: "granted" })
  else {
    assert.equal(unknown.supported, onMac())
    assert.equal(unknown.accessibility, false)
    assert.equal(unknown.screenRecording, "unknown")
  }
  const read = computerPermissions({ packaged: false, appRoot: process.cwd() }, { accessibility: () => true, screen: () => "granted" }, undefined)
  if (onMac()) assert.deepEqual([read.accessibility, read.screenRecording], [true, "granted"])
  // A display alone (a CI job's xvfb-run, a container's Xvfb) is no person's desktop: computer use there stays
  // unsupported. A session the person logged into, or one that opts in, is.
  assert.equal(linuxDesktop({ DISPLAY: ":99" }, "linux"), undefined, "a bare display drives nothing")
  const desktop = linuxDesktop({ DISPLAY: ":0", XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "XFCE" }, "linux")
  assert.deepEqual(desktop, { session: "x11", compositor: "other", xwayland: false })
  assert.deepEqual(linuxDesktop({ DISPLAY: ":0", MAKO_DESKTOP_CONTROL: "1" }, "linux")?.session, "x11", "startx's session opts in")
  if (!onMac()) {
    assert.deepEqual(computerPermissions({ packaged: false, appRoot: process.cwd() }, undefined, desktop), { supported: true, persistentAcrossUpdates: true, accessibility: true, screenRecording: "granted" })
  }
  // What KDE and GNOME ask of the person, read and acted on in a home of the test's own. Nothing is written until the
  // person's action, each state offers that one action, and taking it away restores the start.
  const kde = linuxDesktop({ WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" }, "linux")
  const gnome = linuxDesktop({ WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, "linux")
  assert.equal(kde?.compositor, "kde")
  assert.equal(gnome?.compositor, "gnome")
  if (!onWindows()) {
    const home = await mkdtemp(join(tmpdir(), "mako-desktop-grants-"))
    try {
      const install = join(home, "install")
      await mkdir(join(install, "wayland-helper", GNOME_HELPER), { recursive: true })
      const driver = join(install, "cua-driver")
      await writeFile(driver, "")
      await writeFile(join(install, "wayland-helper", GNOME_HELPER, "metadata.json"), JSON.stringify({ uuid: GNOME_HELPER, version: 11 }))
      await writeFile(join(install, "wayland-helper", GNOME_HELPER, "extension.js"), "// helper\n")
      // GNOME's settings, its extensions tool and the session bus, as the programs the grants run answer. The list
      // is kept as the text `gsettings` prints, so what an edit does to it is seen byte for byte.
      interface GnomeDesk {
        listed: string
        off: boolean
        tool: boolean
        running: number | undefined
        ran: string[][]
      }
      const desk: GnomeDesk = { listed: "['other@example']", off: false, tool: true, running: undefined, ran: [] }
      const context = (env: NodeJS.ProcessEnv = {}, program = driver): DesktopGrantContext => ({
        env,
        home,
        driver: async () => program,
        program: async (name) => (name === "gnome-extensions" && !desk.tool ? null : `/usr/bin/${name}`),
        run: async (file, args) => {
          desk.ran.push([file, ...args])
          const [verb, , key, value] = args
          if (file === "/usr/bin/gsettings" && verb === "get") return key === "disable-user-extensions" ? `${desk.off}\n` : `${desk.listed}\n`
          if (file === "/usr/bin/gsettings" && verb === "set") {
            if (key === "disable-user-extensions") desk.off = value === "true"
            else desk.listed = value!
            return ""
          }
          // GNOME's own tool touches its own entry and nothing else.
          if (file === "/usr/bin/gnome-extensions") {
            desk.listed = verb === "enable" ? withExtension(desk.listed, args[1]!) : withoutExtension(desk.listed, args[1]!)
            return ""
          }
          if (file === "/usr/bin/gdbus" && desk.running !== undefined) return `(uint32 ${desk.running},)\n`
          throw new Error("The name org.cua.WinRects was not provided by any .service files")
        },
      })
      const entry = join(home, ".local", "share", "applications", KWIN_CAPTURE_ENTRY)
      // KDE: not allowed yet, and reading the state wrote nothing.
      assert.deepEqual(await desktopPermissions(kde, context()), [{ id: "kwin-window-capture", state: "needed" }])
      await assert.rejects(readFile(entry, "utf8"), "reading a state writes nothing")
      await grantDesktopPermissions(kde, context())
      const text = await readFile(entry, "utf8")
      assert.match(text, /^X-KDE-DBUS-Restricted-Interfaces=org\.kde\.KWin\.ScreenShot2$/m)
      assert.match(text, /^NoDisplay=true$/m, "the entry stays out of the app menu")
      assert.equal(/^Exec=(.+)$/m.exec(text)?.[1], await realpath(driver), "the entry names the driver itself")
      assert.deepEqual(await desktopPermissions(kde, context()), [{ id: "kwin-window-capture", state: "granted" }])
      // Another driver (an update's) is not the one allowed: the action is offered again.
      const newer = join(home, "newer-driver")
      await writeFile(newer, "")
      assert.deepEqual(await desktopPermissions(kde, context({}, newer)), [{ id: "kwin-window-capture", state: "needed" }])
      // Plasma 5 has no input to give: its row says so and offers nothing to press.
      assert.deepEqual(await desktopPermissions(kde, context({ KDE_SESSION_VERSION: "5" })), [{ id: "kwin-window-capture", state: "granted" }, { id: "pointer-input", state: "unavailable" }])
      await revokeDesktopPermissions(kde, context())
      await assert.rejects(readFile(entry, "utf8"))
      assert.deepEqual(await desktopPermissions(kde, context()), [{ id: "kwin-window-capture", state: "needed" }])
      // A driver at a path that is not plain (a space, a quote, anything an entry would need quoted) is never
      // written into one: the row says why, and the action refuses.
      for (const odd of ["with space", "semi;colon", "quo'te"]) {
        const program = join(home, odd)
        await writeFile(program, "")
        assert.deepEqual(await desktopPermissions(kde, context({}, program)), [{ id: "kwin-window-capture", state: "blocked", reason: "driver-path" }])
        await assert.rejects(grantDesktopPermissions(kde, context({}, program)), /can't be allowed/)
        assert.deepEqual(await desktopPermissions(gnome, context({}, program)), [{ id: "gnome-shell-helper", state: "blocked", reason: "driver-path" }])
      }
      await assert.rejects(readFile(entry, "utf8"), "nothing was written for them")

      // GNOME: needed, then installed and waiting for the next login, then granted once the Shell runs it.
      const helper = join(home, ".local", "share", "gnome-shell", "extensions", GNOME_HELPER)
      assert.deepEqual(await desktopPermissions(gnome, context()), [{ id: "gnome-shell-helper", state: "needed" }])
      assert.ok(desk.ran.every(([file, verb]) => verb !== "set" && file !== "/usr/bin/gnome-extensions"), "reading a state changes no setting")
      await assert.rejects(readFile(join(helper, "extension.js"), "utf8"))
      await grantDesktopPermissions(gnome, context())
      assert.equal(await readFile(join(helper, "extension.js"), "utf8"), "// helper\n")
      assert.equal(await readFile(join(helper, "driver"), "utf8"), `${await realpath(driver)}\n`, "the helper is told the one program it answers")
      assert.equal(desk.listed, `['other@example', '${GNOME_HELPER}']`, "the person's other extensions stay enabled")
      assert.ok(desk.ran.some(([file, verb, id]) => file === "/usr/bin/gnome-extensions" && verb === "enable" && id === GNOME_HELPER), "GNOME's own tool makes the edit")
      assert.ok(desk.ran.every(([file, verb, , key]) => !(file === "/usr/bin/gsettings" && verb === "set" && key === "enabled-extensions")), "the list itself is never rewritten while the tool is there")
      assert.ok(desk.ran.every(([file]) => file!.startsWith("/usr/bin/")), "programs run by their whole path")
      assert.deepEqual(await desktopPermissions(gnome, context()), [{ id: "gnome-shell-helper", state: "restart" }])
      // GNOME with every user extension turned off would never load it: that is its own step, on the same action.
      desk.off = true
      assert.deepEqual(await desktopPermissions(gnome, context()), [{ id: "gnome-shell-helper", state: "extensions-off" }])
      assert.equal(desktopPermissionsPending([{ id: "gnome-shell-helper", state: "extensions-off" }]), true)
      await grantDesktopPermissions(gnome, context())
      assert.equal(desk.off, false, "the person's click turned user extensions on")
      assert.deepEqual(await desktopPermissions(gnome, context()), [{ id: "gnome-shell-helper", state: "restart" }])
      // The Shell still running an older helper is not this one loaded.
      desk.running = 10
      assert.deepEqual(await desktopPermissions(gnome, context()), [{ id: "gnome-shell-helper", state: "restart" }])
      desk.running = 11
      assert.deepEqual(await desktopPermissions(gnome, context()), [{ id: "gnome-shell-helper", state: "granted" }])
      assert.equal(desktopPermissionsPending([{ id: "gnome-shell-helper", state: "restart" }]), true)
      assert.equal(desktopPermissionsPending([{ id: "kwin-window-capture", state: "blocked", reason: "driver-path" }]), true)
      assert.equal(desktopPermissionsPending([{ id: "kwin-window-capture", state: "granted" }, { id: "pointer-input", state: "unavailable" }]), false)
      await revokeDesktopPermissions(gnome, context())
      assert.equal(desk.listed, "['other@example']")
      await assert.rejects(readFile(join(helper, "extension.js"), "utf8"))
      desk.running = undefined
      assert.deepEqual(await desktopPermissions(gnome, context()), [{ id: "gnome-shell-helper", state: "needed" }])

      // The person's list is theirs. An id with an apostrophe, which GNOME prints in double quotes, and one with an
      // escape survive an install and an uninstall byte for byte, through GNOME's tool.
      for (const listed of [`["it's@example", 'other@example']`, `['a@example', "quo\\"ted@example"]`, "@as []"]) {
        desk.listed = listed
        await grantDesktopPermissions(gnome, context())
        assert.ok(desk.listed.endsWith(`'${GNOME_HELPER}']`), desk.listed)
        if (listed !== "@as []") assert.ok(desk.listed.startsWith(listed.slice(0, -1)), `everything before the new entry is untouched: ${desk.listed}`)
        await revokeDesktopPermissions(gnome, context())
        assert.equal(desk.listed, listed, "the list is as it was")
      }
      // Without GNOME's tool the edit is Mako's own: made on a list of plain ids, refused on any other.
      desk.tool = false
      desk.listed = "['a@example', 'b@example']"
      await grantDesktopPermissions(gnome, context())
      assert.equal(desk.listed, `['a@example', 'b@example', '${GNOME_HELPER}']`)
      await revokeDesktopPermissions(gnome, context())
      assert.equal(desk.listed, "['a@example', 'b@example']")
      for (const listed of [`["it's@example", 'other@example']`, `['a@example', "quo\\"ted@example"]`]) {
        desk.listed = listed
        assert.deepEqual(await desktopPermissions(gnome, context()), [{ id: "gnome-shell-helper", state: "blocked", reason: "extension-list" }])
        await assert.rejects(grantDesktopPermissions(gnome, context()), /won't rewrite; nothing was installed/)
        assert.equal(desk.listed, listed, "a list Mako can't edit safely is left alone")
        await assert.rejects(readFile(join(helper, "extension.js"), "utf8"), "and nothing is installed beside it")
      }
      desk.tool = true
      desk.listed = "['other@example']"
      // An install with no helper beside its driver says so and installs nothing.
      await assert.rejects(grantDesktopPermissions(gnome, context({}, newer)), /no Shell helper/)
      // X11 and wlroots ask for nothing.
      assert.deepEqual(await desktopPermissions(desktop, context()), [])
      assert.deepEqual(await desktopPermissions(linuxDesktop({ WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "wayland", SWAYSOCK: "/s" }, "linux"), context()), [])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
  // A refusal only the person can lift names their action for the agent, by the name Settings gives it.
  assert.match(desktopAskHint("KWin did not authorize window capture: no desktop entry for this program asks for org.kde.KWin.ScreenShot2", kde), /"Allow window capture" in Mako's Settings/)
  assert.match(desktopAskHint("foreground_unavailable: this Wayland compositor does not expose a verified activation adapter", gnome), /"Install helper" in Mako's Settings.*log out and back in once/)
  assert.equal(desktopAskHint("The window closed", kde), "")
  assert.equal(desktopAskHint("surface_identity_unproven", desktop), "", "no hint where the desktop asks for nothing")
  // The connectors card says the same thing in a line.
  const linuxGranted = { supported: true, persistentAcrossUpdates: true, accessibility: true, screenRecording: "granted" as const }
  const installed = { executable: "/usr/bin/cua-driver", version: "1", verified: "1", outdated: false, detail: "" }
  const local = (asked: MakoComputerPermissions["desktop"]) =>
    integrationCatalog({ cwd: "/", generatedAt: 0, servers: [], providers: [] }, { ...linuxGranted, desktop: asked }, false, [], installed).integrations.find((record) => record.id === "computer-use")?.connection
  assert.deepEqual(local([{ id: "kwin-window-capture", state: "needed" }]), { kind: "needs-permission", detail: "Allow window capture" })
  assert.deepEqual(local([{ id: "gnome-shell-helper", state: "needed" }]), { kind: "needs-permission", detail: "Install Mako's Shell helper" })
  assert.deepEqual(local([{ id: "gnome-shell-helper", state: "restart" }]), { kind: "unavailable", detail: "Log out and back in once to finish" })
  assert.deepEqual(local([{ id: "gnome-shell-helper", state: "extensions-off" }]), { kind: "needs-permission", detail: "Turn on GNOME's user extensions" })
  assert.deepEqual(local([{ id: "kwin-window-capture", state: "blocked", reason: "driver-path" }]), { kind: "unavailable", detail: "Reinstall Mako at a plain path" })
  assert.deepEqual(local([{ id: "gnome-shell-helper", state: "blocked", reason: "extension-list" }]), { kind: "unavailable", detail: "Install GNOME's gnome-extensions tool" })
  assert.equal(local([{ id: "kwin-window-capture", state: "granted" }, { id: "pointer-input", state: "unavailable" }])?.kind, "ready")

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
  const shots = new Appshots({ connect: async () => driver, warm: async () => {} }, () => capturer)
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
