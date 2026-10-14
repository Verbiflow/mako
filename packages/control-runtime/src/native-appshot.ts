import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import {
  WindowRecordSchema,
  WindowStateSchema,
  treeWindowFrame,
  windowKind,
  windowOutline,
  writeWindowOutline,
  type WindowState,
} from "@mako/control/computer"
import type { Appshot, AppshotTarget, AppshotWindow } from "./contracts/appshots.js"
import { ControlImageSchema } from "./contracts/control-preview.js"
import type { JsonObject, JsonValue } from "./json.js"

/**
 * An Appshot: one window's picture and its outline, taken through the
 * native driver. The one capture path: the host's Appshots (the + menu's
 * chooser and the shortcut) and the control SDK's `window.appshot()` both
 * call it, each over its own driver connection, so a person's capture and
 * an agent's are the same picture and the same lines.
 *
 * Every call here is a read. Nothing focuses a window or sends input: the
 * driver's `list_windows` and `get_window_state` are the only tools it
 * names, and the warm-up below reads a 16-pixel picture.
 */

const execute = promisify(execFile)

/** A driver reply, already checked: a refusal rejects with the driver's words instead. */
export interface AppshotReply {
  content: readonly JsonValue[]
  structuredContent?: JsonObject
}

/** One driver read. The caller owns the connection, its session and how a refusal reads. */
export type AppshotRead = (
  name: "list_windows" | "get_window_state" | "check_permissions",
  args: JsonObject
) => Promise<AppshotReply>

const BoundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
const WindowListSchema = z.object({
  windows: z
    .array(
      z.looseObject({
        pid: z.number().int(),
        window_id: z.number().int(),
        app_name: z.string(),
        title: z.string(),
        is_on_screen: z.boolean(),
        on_current_space: z.boolean().nullable().optional(),
        z_index: z.number().nullable().optional(),
        bounds: BoundsSchema.optional(),
      })
    )
    .max(2000),
})
type ListedWindow = z.infer<typeof WindowListSchema>["windows"][number]
const PictureSchema = z.looseObject({
  app_name: z.string().optional(),
  window_title: z.string().optional(),
  window_bounds: BoundsSchema.optional(),
  screenshot_width: z.number().optional(),
  screenshot_height: z.number().optional(),
  screenshot_scale: z.number().optional(),
  screenshot_frame_valid: z.boolean().optional(),
})
const PermissionsSchema = z.looseObject({ screen_recording: z.boolean().optional() })

/**
 * How far the driver walks a window's tree for an Appshot. Web content nests
 * a few dozen wrappers deep before the page starts, which the driver's
 * default depth of 25 cuts off; the elements limit keeps a huge window's
 * walk near a second (818 elements read in 0.4 s, measured on 0.28.0).
 */
const WALK = { max_elements: 4000, max_depth: 64 }
/** The warm-up's picture: big enough to be a capture, too small to show anything. */
const WARM_SIDE = 16

/** The application in front, by pid, from LaunchServices: about 15 ms, and no permission needed. */
export async function frontmostPid(): Promise<number | null> {
  try {
    const front = (await execute("/usr/bin/lsappinfo", ["front"], { timeout: 2000 })).stdout.trim()
    if (!front) return null
    const info = (await execute("/usr/bin/lsappinfo", ["info", "-only", "pid", front], { timeout: 2000 })).stdout
    const pid = Number(/"pid"=(\d+)/.exec(info)?.[1])
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function onScreen(read: AppshotRead): Promise<ListedWindow[]> {
  const result = await read("list_windows", { on_screen_only: true })
  return WindowListSchema.parse(result.structuredContent)
    .windows.filter((window) => window.pid > 0 && window.window_id > 0 && window.is_on_screen)
}

function appshotWindow(window: ListedWindow): AppshotWindow {
  const shown: AppshotWindow = { pid: window.pid, windowId: window.window_id, app: window.app_name, title: window.title }
  if (window.bounds) shown.bounds = window.bounds
  return shown
}

/** A WindowServer strip with no title (`helper`) is never a window a person means. */
function meant(window: ListedWindow): boolean {
  const record = WindowRecordSchema.safeParse(window)
  return !record.success || windowKind(record.data) !== "helper"
}

/** Every window on screen, by application then title. */
export async function appshotWindows(read: AppshotRead): Promise<AppshotWindow[]> {
  return (await onScreen(read))
    .map(appshotWindow)
    .sort((a, b) => a.app.localeCompare(b.app) || a.title.localeCompare(b.title))
}

/**
 * The window the person is in: the front application's frontmost window,
 * or, when that application is one of `exclude` (Mako, which they pressed
 * the shortcut in), the frontmost window of any other, on this Space.
 */
export async function frontAppshotWindow(
  read: AppshotRead,
  exclude: readonly number[],
  frontmost: () => Promise<number | null> = frontmostPid
): Promise<AppshotWindow> {
  const excluded = new Set(exclude)
  const [front, windows] = await Promise.all([frontmost(), onScreen(read)])
  const candidates = windows
    .filter((window) => !excluded.has(window.pid) && window.on_current_space !== false && meant(window))
    .sort((a, b) => (b.z_index ?? -1) - (a.z_index ?? -1))
  const chosen =
    (front !== null && !excluded.has(front) ? candidates.find((window) => window.pid === front) : undefined) ?? candidates[0]
  if (!chosen) throw new Error("There's no window to capture. Open the window you want, then press the shortcut in it.")
  return appshotWindow(chosen)
}

/**
 * Take one Appshot. The picture and the tree are read side by side: the
 * picture alone is a fifth of a second once the driver is warm, the tree
 * about a third, and the two together in one call took longer than both in
 * parallel (0.57 s against 0.83 s on an 818-element window). Boxes are
 * measured from where the window was when its tree was read, at the
 * picture's scale; a window resized in between gets no boxes rather than
 * wrong ones. The picture names its own window, so a known target costs no
 * window list; a driver whose picture doesn't is asked for the list.
 *
 * A tree that can't be read still gives the picture, and says so. The tree
 * read is a new driver snapshot of the window: element tokens read before
 * it are superseded, as they are by any observation.
 */
export async function captureAppshot(
  read: AppshotRead,
  target: AppshotTarget,
  options: { known?: AppshotWindow; timed?: (ms: { picture: number; tree: number }) => void } = {}
): Promise<Appshot> {
  const args = { pid: target.pid, window_id: target.windowId }
  const started = performance.now()
  const ms = { picture: 0, tree: 0 }
  const [picture, tree] = await Promise.all([
    read("get_window_state", { ...args, include_accessibility_tree: false }).finally(() => {
      ms.picture = Math.round(performance.now() - started)
    }),
    read("get_window_state", { ...args, include_screenshot: false, ...WALK })
      .catch(() => null)
      .finally(() => {
        ms.tree = Math.round(performance.now() - started)
      }),
  ])
  options.timed?.(ms)
  const image = picture.content
    .map((value) => ControlImageSchema.safeParse(value))
    .find((value) => value.success)?.data
  if (!image)
    throw new Error("The window returned no picture. Check Screen Recording permission and try again.")
  const capturedAt = Date.now()
  const shot = PictureSchema.parse(picture.structuredContent ?? {})
  const known = options.known && options.known.pid === target.pid && options.known.windowId === target.windowId ? options.known : undefined
  const named =
    known ??
    (shot.app_name !== undefined
      ? { ...target, app: shot.app_name, title: shot.window_title ?? "" }
      : (await appshotWindows(read)).find((window) => window.pid === target.pid && window.windowId === target.windowId))
  if (!named) throw new Error("That window has closed. Select it again from the window list.")
  const walked = WindowStateSchema.parse(tree?.structuredContent ?? {})
  const walkedFrame = treeWindowFrame(walked)
  const sameSize =
    shot.window_bounds && walkedFrame
      ? Math.abs(shot.window_bounds.width - walkedFrame.width) < 1 &&
        Math.abs(shot.window_bounds.height - walkedFrame.height) < 1
      : false
  // The tree's own frames, at the picture's size, under the window's names.
  const state: WindowState = {
    ...walked,
    app_name: named.app,
    window_title: named.title,
    window_bounds: walkedFrame ?? shot.window_bounds,
    screenshot_width: shot.screenshot_width,
    screenshot_height: shot.screenshot_height,
    screenshot_scale: shot.screenshot_scale,
    screenshot_frame_valid: shot.screenshot_frame_valid !== false && sameSize,
  }
  if (tree === null) state.elements_complete = false
  const outline = windowOutline(state, capturedAt)
  const window: AppshotWindow = { pid: target.pid, windowId: target.windowId, app: named.app, title: named.title }
  if (named.icon) window.icon = named.icon
  const bounds = shot.window_bounds ?? named.bounds
  if (bounds) window.bounds = bounds
  return {
    window,
    capturedAt,
    image,
    text: writeWindowOutline(outline),
    truncated: !outline.complete || outline.shown < outline.total || tree === null,
    elements: outline.shown,
  }
}

/**
 * Take the driver's first picture now, so a person's or an agent's first
 * capture doesn't. A new driver daemon's first window picture takes about
 * 3.6 s whichever window it is, and every later one about 0.2 s, across
 * connections (measured on 0.28.x, docs/audits/2026-10-12/appshot-control.md);
 * the walk of the tree pays no such cost. The warm-up reads a 16-pixel
 * picture of one of `prefer`'s windows (Mako's own) or else the smallest
 * window on screen, and throws it away. It is skipped without Screen
 * Recording, so it never raises a permission prompt the person didn't ask
 * for. Resolves to how long the picture took, or null when it was skipped.
 */
export async function warmAppshots(read: AppshotRead, prefer: readonly number[] = []): Promise<number | null> {
  const permissions = PermissionsSchema.safeParse((await read("check_permissions", { prompt: false })).structuredContent)
  if (!permissions.success || permissions.data.screen_recording !== true) return null
  const windows = (await onScreen(read)).filter(meant)
  const area = (window: ListedWindow) => (window.bounds ? window.bounds.width * window.bounds.height : Number.POSITIVE_INFINITY)
  const chosen =
    windows.find((window) => prefer.includes(window.pid)) ??
    windows.filter((window) => window.bounds).sort((a, b) => area(a) - area(b))[0]
  if (!chosen) return null
  const started = performance.now()
  await read("get_window_state", {
    pid: chosen.pid,
    window_id: chosen.window_id,
    include_accessibility_tree: false,
    max_dimension: WARM_SIDE,
  })
  return Math.round(performance.now() - started)
}
