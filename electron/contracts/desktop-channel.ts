import { z } from "zod"
import { ControlImageSchema } from "@mako/control-runtime/contracts"
import { UpdateStateSchema } from "./automations-usage-updates.js"

/**
 * What a host asks the desktop app on `POST /desktop`, its private socket's
 * one duplex route: the work only Electron's main process can do, which a
 * host under Node can't. The desktop streams its frames in the request body;
 * the host streams its asks in the response. Browser gateways never forward
 * the route (`web-dev-proxy.mjs`), and the cloud gateway calls the host in
 * process, so only an Electron process on this machine reaches it.
 */
export const DESKTOP_PATH = "/desktop"

/**
 * Who answers on the channel, sent as a request header because the host
 * admits or refuses a desktop before reading anything it sends.
 *
 *   - `desktop`: the app a person opened.
 *   - `agent-views`: an Electron process the host started, with no Dock icon
 *     and no window of its own, only to make the desk windows agents drive
 *     while no desktop is open (`agent-views.ts`). It gives the channel up to
 *     a desktop that opens.
 */
export const DESKTOP_ROLE_HEADER = "x-mako-desktop-role"
export const DesktopRoleSchema = z.enum(["desktop", "agent-views"])
export type DesktopRole = z.infer<typeof DesktopRoleSchema>

/** Set by the host that starts Mako's desktop executable as the agent views app. */
export const AGENT_VIEWS_ENV = "MAKO_AGENT_VIEWS"

/** The largest line either side sends: a page's screenshot or eighty window thumbnails. */
export const DESKTOP_LINE_LIMIT = 64 * 1024 * 1024

const JsonObjectSchema = z.record(z.string(), z.json())
const PageIdSchema = z.string().min(1).max(100)

const PermissionsSchema = z.object({
  supported: z.boolean(),
  persistentAcrossUpdates: z.boolean(),
  accessibility: z.boolean(),
  screenRecording: z.enum(["not-determined", "denied", "restricted", "granted", "unknown"]),
})

const NoParams = z.object({}).strict()

export const DESKTOP_METHODS = [
  "computer-permissions",
  "computer-permissions-request",
  "window-thumbnails",
  "window-source",
  "desk-page-create",
  "desk-page-send",
  "desk-page-destroy",
  "update-check",
  "update-install",
] as const
export type DesktopMethod = (typeof DESKTOP_METHODS)[number]

/** What the agent views app answers: the desk windows, nothing about the person's Mac. */
export const DESK_PAGE_METHODS = ["desk-page-create", "desk-page-send", "desk-page-destroy"] as const satisfies readonly DesktopMethod[]

/** Each method's parameters and answer. */
export const DESKTOP_CALLS = {
  /** macOS's privacy settings for Mako, as the desktop's Electron reads them. */
  "computer-permissions": { params: NoParams, result: PermissionsSchema },
  /** Ask macOS for the next missing grant, in front of the desktop's window. */
  "computer-permissions-request": { params: NoParams, result: PermissionsSchema },
  /** Every window's thumbnail and app icon, for the app shot picker. */
  "window-thumbnails": {
    params: NoParams,
    result: z.array(z.object({
      windowId: z.number().int(),
      name: z.string().max(1000),
      thumbnail: ControlImageSchema.optional(),
      icon: ControlImageSchema.optional(),
    })).max(2000),
  },
  /** The capture source for one window's live preview. */
  "window-source": { params: z.object({ windowId: z.number().int().positive() }).strict(), result: z.string().max(200).nullable() },
  /** A hidden desk window for agents to drive, made by the desktop. */
  "desk-page-create": {
    params: z.object({ previewId: z.string().min(1).max(200) }).strict(),
    result: z.object({ page: PageIdSchema, url: z.string(), title: z.string() }),
  },
  /** One Chrome DevTools Protocol command to that window. */
  "desk-page-send": {
    params: z.object({ page: PageIdSchema, method: z.string().min(1).max(200), params: JsonObjectSchema }).strict(),
    result: JsonObjectSchema,
  },
  "desk-page-destroy": { params: z.object({ page: PageIdSchema }).strict(), result: z.null() },
  /** Look for an update now; the answer is where the updater is once the check started. */
  "update-check": { params: NoParams, result: UpdateStateSchema },
  /**
   * Install the downloaded update. The desktop answers first, then quits into
   * the installer and comes back on the new version; the host has already
   * stopped its work and is leaving.
   */
  "update-install": { params: NoParams, result: z.null() },
} as const satisfies Record<DesktopMethod, { params: z.ZodType; result: z.ZodType }>

export type DesktopParams<Method extends DesktopMethod> = z.infer<(typeof DESKTOP_CALLS)[Method]["params"]>
export type DesktopResult<Method extends DesktopMethod> = z.infer<(typeof DESKTOP_CALLS)[Method]["result"]>

/** Host to desktop. */
export const DesktopAskSchema = z.object({
  kind: z.literal("ask"),
  id: z.number().int().positive(),
  method: z.enum(DESKTOP_METHODS),
  params: z.json(),
})
export type DesktopAsk = z.infer<typeof DesktopAskSchema>

/**
 * Desktop to host: who answers, each answer, what the desk windows it made
 * say on their own, and where its updater is, sent after the hello and on
 * every change.
 */
export const DesktopFrameSchema = z.union([
  z.object({ kind: z.literal("hello"), pid: z.number().int(), methods: z.array(z.string().max(100)).max(64) }),
  z.object({ kind: z.literal("reply"), id: z.number().int().positive(), ok: z.literal(true), value: z.json() }),
  z.object({ kind: z.literal("reply"), id: z.number().int().positive(), ok: z.literal(false), error: z.string().max(4000) }),
  z.object({ kind: z.literal("page"), page: PageIdSchema, message: z.object({ method: z.string().max(200), params: JsonObjectSchema }) }),
  z.object({ kind: z.literal("page"), page: PageIdSchema, state: z.object({ url: z.string(), title: z.string() }) }),
  z.object({ kind: z.literal("page"), page: PageIdSchema, destroyed: z.literal(true) }),
  z.object({ kind: z.literal("update"), state: UpdateStateSchema }),
])
export type DesktopFrame = z.infer<typeof DesktopFrameSchema>

/** A line as one side reads it from the other, or nothing when it isn't one. */
export function readDesktopLine<Schema extends z.ZodType>(schema: Schema, line: string): z.infer<Schema> | undefined {
  try {
    return schema.parse(JSON.parse(line))
  } catch {
    return undefined
  }
}
