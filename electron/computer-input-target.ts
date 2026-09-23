import { z } from "zod"
import type { ComputerDriverClient } from "./computer-driver-client.js"

const target = z.object({
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
})
const apps = z.object({
  structuredContent: z.object({
    apps: z.array(z.object({ pid: z.number().int(), active: z.boolean() })),
  }),
})
const windows = z.object({
  structuredContent: z.object({
    windows: z.array(
      z.object({
        pid: z.number().int(),
        window_id: z.number().int(),
        z_index: z.number().nullable(),
        focused: z.boolean().nullable().optional(),
        is_on_screen: z.boolean(),
      })
    ),
  }),
})

/** Foreground delivery is global input in the native driver. Refuse an already-mismatched window. */
export async function verifyForegroundInput(
  client: Pick<ComputerDriverClient, "callTool">,
  value: Parameters<typeof target.parse>[0],
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const expected = target.parse(value)
  if (platform === "linux") {
    const result = z.object({
      structuredContent: z.object({
        platform: z.literal("linux"),
        backend: z.enum(["x11", "wayland"]),
        windows: z.array(z.object({
          pid: z.number().int(),
          window_id: z.number().int(),
          is_on_screen: z.boolean(),
          focused: z.boolean().nullable(),
        })),
      }),
    }).safeParse(await client.callTool(
      "list_windows", { pid: expected.pid, on_screen_only: true },
      { signal, timeout: 5000 }
    ))
    if (!result.success ||
      !result.data.structuredContent.windows.some((window) =>
        window.pid === expected.pid && window.window_id === expected.window_id &&
        window.is_on_screen && window.focused === true))
      throw new Error("Foreground input was not sent: the Linux driver could not verify keyboard focus on the exact target window.")
    return
  }
  const active = apps
    .parse(
      await client.callTool("list_apps", {}, {
        signal,
        timeout: 5000,
      })
    )
    .structuredContent.apps.find((app) => app.active)
  if (active?.pid !== expected.pid)
    throw new Error(
      "Foreground input was not sent: the selected application is not frontmost. Use a background route, or explicitly focus the intended window before foreground input."
    )
  const visible = windows
    .parse(
      await client.callTool(
        "list_windows",
        { pid: expected.pid, on_screen_only: true },
        { signal, timeout: 5000 }
      )
    )
    .structuredContent.windows.filter((window) => window.is_on_screen)
  // New native drivers attest AX key-window identity plus WindowServer focus.
  // A tooltip can rank above the key window without becoming an input target.
  if (visible.some(window => window.focused !== undefined)) {
    if (!visible.some(window => window.pid === expected.pid && window.window_id === expected.window_id && window.focused === true))
      throw new Error("Foreground input was not sent: the exact window's keyboard focus could not be verified.")
    return
  }
  // Older running daemons have no focus field; retain their conservative guard
  // until the host next starts the installed driver.
  const front = visible.reduce<(typeof visible)[number] | null>(
    (current, window) =>
      window.z_index !== null &&
      (current?.z_index === null ||
        current?.z_index === undefined ||
        window.z_index > current.z_index)
        ? window
        : current,
    null
  )
  if (front?.pid !== expected.pid || front.window_id !== expected.window_id)
    throw new Error(
      "Foreground input was not sent: the selected window is not frontmost. Observe the intended window before continuing."
    )
}
