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
        is_on_screen: z.boolean(),
      })
    ),
  }),
})

/** Foreground delivery is global input in the native driver. Refuse an already-mismatched window. */
export async function verifyForegroundInput(
  client: Pick<ComputerDriverClient, "callTool">,
  value: Parameters<typeof target.parse>[0],
  signal: AbortSignal
): Promise<void> {
  const expected = target.parse(value)
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
  if (front?.window_id !== expected.window_id)
    throw new Error(
      "Foreground input was not sent: the selected window is not frontmost. Observe the intended window before continuing."
    )
}
