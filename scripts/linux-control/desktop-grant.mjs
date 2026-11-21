// What a person does once in Settings on GNOME, before their next login: "Install helper". It runs the host's own
// grant (`desktop-grants.ts`, bundled as $MAKO_DESKTOP_GRANTS, the method `mako:computer-permissions-request` calls),
// with the session bus up and the Shell not yet started, and checks the states either side of it: needed, then
// installed and waiting for the login. desktop-probe.mjs, in the Shell started after, finds it granted.
//
//   MAKO_DESKTOP_GRANTS=… MAKO_CUA_EMBEDDED=… MAKO_EVIDENCE=/evidence node desktop-grant.mjs
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

const { desktopGrantContext, desktopPermissions, grantDesktopPermissions } = await import(process.env.MAKO_DESKTOP_GRANTS)
const { cuaDriverExecutable } = await import(process.env.MAKO_CUA_EMBEDDED)
const gnome = { session: "wayland", compositor: "gnome", xwayland: true }
const context = desktopGrantContext(() => cuaDriverExecutable())
const before = await desktopPermissions(gnome, context)
assert.deepEqual(before, [{ id: "gnome-shell-helper", state: "needed" }], "nothing is installed until the person asks")
await grantDesktopPermissions(gnome, context)
const after = await desktopPermissions(gnome, context)
assert.deepEqual(after, [{ id: "gnome-shell-helper", state: "restart" }], "installed, and waiting for the next login")
await writeFile(join(process.env.MAKO_EVIDENCE ?? "/tmp", "gnome-grant.json"), JSON.stringify({ before, after }))
console.log(JSON.stringify({ name: "permissions: install GNOME's Shell helper as Settings does", before, after }))
