import { z } from "zod"
import type { JsonValue } from "../json.js"
import { presented } from "./present.js"

/**
 * Discovery results print one line per target, the ID an agent copies first,
 * under a line saying how to use it. Programs still get the full value; a
 * shape these forms do not know (an `{all:true}` listing) prints as JSON.
 */
const browsersSchema = z.looseObject({
  available: z.boolean(),
  browsers: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      kind: z.string().optional(),
      connection: z.looseObject({ status: z.string() }),
      next: z.string().optional(),
    })
  ),
  next: z.string().optional(),
})
const tabsSchema = z.looseObject({
  browser: z.string(),
  pages: z.array(z.object({ tab: z.string(), title: z.string(), url: z.string(), claimed: z.boolean() }).loose()),
  hidden: z.string().optional(),
})
const appsSchema = z.looseObject({
  apps: z.array(
    z.object({ pid: z.number(), name: z.string(), bundle_id: z.string().optional(), active: z.boolean().optional() }).loose()
  ),
  hidden: z.string().optional(),
})
const windowsSchema = z.looseObject({
  pid: z.number(),
  windows: z.array(
    z.looseObject({
      window_id: z.number().optional(),
      kind: z.string().optional(),
      title: z.string().nullish(),
      app_name: z.string().nullish(),
      bounds: z.looseObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullish(),
      is_on_screen: z.boolean().nullish(),
    })
  ),
  next: z.string().optional(),
})

function printed<T extends object>(value: JsonValue, schema: z.ZodType<T>, text: (data: T) => string[]): JsonValue {
  const parsed = schema.safeParse(value)
  if (!parsed.success || typeof value !== "object" || value === null) return value
  return presented(value, () => text(parsed.data).join("\n"))
}

export function browsersValue(value: JsonValue): JsonValue {
  return printed(value, browsersSchema, ({ available, browsers, next }) => {
    if (!available) return [next ?? "Browser control is unavailable here."]
    if (!browsers.length) return ["No browsers found."]
    return browsers.map(
      (browser) =>
        `${browser.id} ${JSON.stringify(browser.name)}${browser.kind ? ` ${browser.kind}` : ""} ${browser.connection.status}${browser.next ? ` → ${browser.next}` : ""}`
    )
  })
}

export function tabsValue(value: JsonValue): JsonValue {
  return printed(value, tabsSchema, ({ browser, pages, hidden }) => [
    pages.length
      ? `tabs in ${browser}: control.claimTab({browser:${JSON.stringify(browser)},tab}) controls one`
      : `No tabs in ${browser}; control.openTab({browser:${JSON.stringify(browser)},url}) opens one.`,
    ...pages.map((page) => `${page.tab} ${JSON.stringify(page.title)} ${page.url}${page.claimed ? " claimed" : ""}`),
    ...(hidden ? [hidden] : []),
  ])
}

export function appsValue(value: JsonValue): JsonValue {
  return printed(value, appsSchema, ({ apps, hidden }) => [
    "running apps, pid first: control.windows(pid) lists an app's windows",
    ...apps.map((app) => `${app.pid} ${JSON.stringify(app.name)}${app.bundle_id ? ` ${app.bundle_id}` : ""}${app.active ? " active" : ""}`),
    ...(hidden ? [hidden] : []),
  ])
}

export function windowsValue(value: JsonValue): JsonValue {
  return printed(value, windowsSchema, ({ pid, windows, next }) => {
    if (!windows.length) return [next ?? `Process ${pid} has no windows.`]
    return [
      `windows of ${pid}, window_id first: control.window({pid:${pid},window_id}) controls one`,
      ...windows.map((window) => {
        const { bounds: box } = window
        return [
          window.window_id ?? "?",
          window.kind,
          JSON.stringify(window.title ?? ""),
          box ? `${Math.round(box.width)}×${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}` : undefined,
          window.is_on_screen === false ? "off-screen" : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(" ")
      }),
    ]
  })
}
