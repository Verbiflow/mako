import { z } from "zod"
import { ExtensionHostMessageSchema } from "../electron/browser-extension-protocol.js"
import { ExtensionRouter } from "./router.js"

const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  profileId: z.string().uuid().optional(),
  profileName: z.string().trim().min(1).max(100).optional(),
})
const toggleSchema = z.object({
  kind: z.literal("set-enabled"),
  enabled: z.boolean(),
})
let port: chrome.runtime.Port | null = null
let router: ExtensionRouter | null = null
let connecting = false
let ready = false

const userAgentDataSchema = z.object({
  brands: z.array(z.object({ brand: z.string(), version: z.string() })),
})
const browserNavigatorSchema = z
  .object({
    brave: z.object({}).loose().optional(),
    userAgentData: userAgentDataSchema.optional(),
  })
  .loose()

function browserProduct(): string {
  const userAgent = navigator.userAgent
  const browserNavigator = browserNavigatorSchema.parse(navigator)
  const known = [
    [/Edg\//, "Edge"],
    [/OPR\//, "Opera"],
    [/Vivaldi\//, "Vivaldi"],
    [/YaBrowser\//, "Yandex"],
    [/(?:^| )Arc\//, "Arc"],
    [/(?:^| )Aside\//, "Aside"],
  ] as const
  const matched = known.find(([pattern]) => pattern.test(userAgent))
  if (matched) return matched[1]
  if (browserNavigator.brave) return "Brave"
  const brands =
    browserNavigator.userAgentData?.brands.map(({ brand }) => brand) ?? []
  const product = brands.find(
    (brand) =>
      !/^(?:Chromium|Not.?A.?Brand)$/i.test(brand) && brand !== "Google Chrome"
  )
  if (product) return product
  if (brands.includes("Google Chrome") || /Chrome\//.test(userAgent))
    return "Chrome"
  return "Chromium"
}

async function status(value: string) {
  await chrome.storage.local.set({ status: value })
}

async function connect(): Promise<void> {
  if (port || connecting) return
  connecting = true
  try {
    const settings = settingsSchema.parse(
      await chrome.storage.local.get(["enabled", "profileId", "profileName"])
    )
    if (!settings.enabled) return
    const profileId = settings.profileId ?? crypto.randomUUID()
    await chrome.storage.local.set({ profileId })
    await status("Connecting to Mako…")
    const next = chrome.runtime.connectNative("dev.mako.browser")
    port = next
    const activeRouter = new ExtensionRouter(chrome, (message) => {
      if (port === next) next.postMessage(message)
    })
    router = activeRouter
    next.onMessage.addListener((value) => {
      const parsed = ExtensionHostMessageSchema.safeParse(value)
      if (!parsed.success) {
        next.disconnect()
        return
      }
      const message = parsed.data
      if (message.kind === "ready") {
        ready = true
        void chrome.storage.local.set({
          resolvedProfileName: message.profileName ?? "",
        })
        void status("Connected to Mako")
      } else if (message.kind === "request")
        void activeRouter.request(message.client, message.command)
      else void activeRouter.disconnect(message.client)
    })
    next.onDisconnect.addListener(() => {
      const failed = Boolean(chrome.runtime.lastError)
      if (port !== next) return
      port = null
      ready = false
      router = null
      void activeRouter.close()
      void status(
        failed
          ? "Open Mako and finish browser setup, then reconnect."
          : "Disconnected from Mako"
      )
      chrome.alarms.create("reconnect", { delayInMinutes: 1 })
    })
    const product = browserProduct()
    next.postMessage({
      kind: "hello",
      profileId,
      profileName: settings.profileName,
      family: "chromium",
      product,
      label: product,
    })
  } catch {
    await status("Browser connection could not start. Reconnect to try again.")
  } finally {
    connecting = false
  }
}

chrome.debugger.onEvent.addListener((source, method, params) =>
  router?.event(source, method, params)
)
chrome.debugger.onDetach.addListener((source, reason) =>
  router?.detached(source, reason)
)
chrome.tabs.onRemoved.addListener((tabId) => router?.removed(tabId))
chrome.runtime.onInstalled.addListener(() => void connect())
chrome.runtime.onStartup.addListener(() => void connect())
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect") void connect()
})
chrome.runtime.onMessage.addListener((value, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return
  const naming = z
    .object({
      kind: z.literal("set-profile-name"),
      profileName: z.string().trim().min(1).max(100),
    })
    .safeParse(value)
  if (naming.success) {
    void chrome.storage.local
      .set({ profileName: naming.data.profileName })
      .then(() => {
        if (ready && port)
          port.postMessage({
            kind: "profile-name",
            profileName: naming.data.profileName,
          })
        respond({ ok: true })
      })
    return true
  }
  const parsed = toggleSchema.safeParse(value)
  if (!parsed.success) return
  void (async () => {
    await chrome.storage.local.set({ enabled: parsed.data.enabled })
    if (parsed.data.enabled) await connect()
    else {
      const current = port
      port = null
      await router?.close()
      router = null
      current?.disconnect()
      await chrome.alarms.clear("reconnect")
      await status("Paused")
    }
    respond({ ok: true })
  })()
  return true
})
void connect()
