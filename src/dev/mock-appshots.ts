import type { Appshot, AppshotWindow } from "@/lib/types"
import { chordClash, clashSentence, type AppshotShortcut, type AppshotShortcutState } from "@mako/host/contracts/appshot-shortcut"
/**
 * A real capture of `scripts/fixtures/appshot/window.html` in an Electron window,
 * taken by `scripts/test-appshot-live.mjs --fixture`; no one's screen but the fixture's.
 * Loaded on first use: the asset imports are Vite's, and the state tests that
 * install this bridge under tsx never ask for an appshot.
 */
async function capture(): Promise<{ picture: string; outline: string }> {
  const [picture, outline] = await Promise.all([
    import("../../scripts/fixtures/appshot/capture.png?inline"),
    import("../../scripts/fixtures/appshot/capture.txt?raw"),
  ])
  return { picture: picture.default, outline: outline.default }
}

const WINDOW: AppshotWindow = {
  pid: 4242,
  windowId: 7,
  app: "Electron",
  title: "Invoices · Fixture Books",
  bounds: { x: 226, y: 124, width: 1000, height: 700 },
}

function base64(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(",") + 1)
}

/** Appshots in the fixture desk: one window, captured from a fixture page. */
export const mockAppshots = {
  appshotWindows: async (): Promise<AppshotWindow[]> => [{ ...WINDOW, thumbnail: { mimeType: "image/png", data: base64((await capture()).picture) } }],
  appshotFrontWindow: async (): Promise<AppshotWindow> => WINDOW,
  captureAppshot: async (): Promise<Appshot> => {
    const [{ picture, outline }] = await Promise.all([capture(), new Promise((resolve) => setTimeout(resolve, 600))])
    return {
      window: WINDOW,
      capturedAt: Date.now(),
      image: { mimeType: "image/png", data: base64(picture) },
      text: outline,
      truncated: false,
      elements: outline.split("\n\n")[1]?.split("\n").length ?? 0,
    }
  },
  // A Mac with macOS's shortcuts as they ship: keys on one of them are refused as the desktop client refuses them.
  setAppshotShortcut: async (shortcut: AppshotShortcut | null): Promise<AppshotShortcutState> => {
    const clash = shortcut?.kind === "keys" ? chordClash(shortcut.chord) : null
    if (clash) return { state: "refused", reason: clashSentence(clash), clash }
    return shortcut ? { state: "on", shortcut } : { state: "off" }
  },
  appshotFeedback: async () => {},
}
