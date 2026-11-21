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
// Each press of the row's one action: install, then (where GNOME has user extensions turned off) turn them on.
const steps = []
for (let state = before[0].state; state === "needed" || state === "extensions-off"; ) {
  await grantDesktopPermissions(gnome, context)
  state = (await desktopPermissions(gnome, context))[0].state
  steps.push(state)
  assert.ok(steps.length <= 2, `the action converges: ${steps.join(", ")}`)
}
const after = await desktopPermissions(gnome, context)
assert.deepEqual(after, [{ id: "gnome-shell-helper", state: "restart" }], "installed, and waiting for the next login")
await writeFile(join(process.env.MAKO_EVIDENCE ?? "/tmp", "gnome-grant.json"), JSON.stringify({ before, steps, after }))
console.log(JSON.stringify({ name: "permissions: install GNOME's Shell helper as Settings does", before, steps, after }))
