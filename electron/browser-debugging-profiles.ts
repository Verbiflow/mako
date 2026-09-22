import { createHash } from "node:crypto"
import { lstat, open, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { z } from "zod"
import type { LocalBrowser } from "./browser-discovery.js"

const chromiumState = z.object({
  profile: z.object({ info_cache: z.record(z.string(), z.unknown()) }),
})

async function smallFile(path: string, limit: number): Promise<string> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.size > limit)
    throw new Error("Invalid browser discovery file")
  const file = await open(path, "r")
  try {
    const bytes = Buffer.alloc(metadata.size + 1)
    const { bytesRead: count } = await file.read(bytes)
    if (count > metadata.size)
      throw new Error("Browser discovery file exceeds its limit")
    return bytes.subarray(0, count).toString("utf8")
  } finally {
    await file.close()
  }
}

/** The browser publishes this endpoint only after debugging has been enabled. */
export async function debuggingEndpoint(root: string): Promise<string> {
  const lines = (await smallFile(join(root, "DevToolsActivePort"), 1024))
    .trim()
    .split(/\r?\n/)
  const [port, path] = lines
  if (
    lines.length !== 2 ||
    !port ||
    !/^\d{1,5}$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    !path ||
    !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(path)
  )
    throw new Error("Invalid browser-published debugging endpoint")
  return `ws://127.0.0.1:${Number(port)}${path}`
}

async function directories(root: string, limit: number): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort()
      .slice(0, limit)
  } catch {
    return []
  }
}

/**
 * Discover enabled regular profiles by Chromium files, not a brand allowlist.
 * No port scans, browser restarts, preference writes or new profiles. Connect
 * rereads the endpoint so a browser restart cannot reuse a saved address.
 */
export async function debuggingBrowsers(base: string): Promise<LocalBrowser[]> {
  const first = await directories(base, 512)
  const nested = (await Promise.all(first.map((root) => directories(root, 32))))
    .flat()
    .slice(0, 2048)
  const browsers: LocalBrowser[] = []
  for (const root of [...first, ...nested]) {
    try {
      await debuggingEndpoint(root)
      const state = chromiumState.parse(
        JSON.parse(await smallFile(join(root, "Local State"), 8 * 1024 * 1024))
      )
      if (Object.keys(state.profile.info_cache).length === 0) continue
      browsers.push({
        id: `chromium:direct:${createHash("sha256").update(root).digest("hex").slice(0, 24)}`,
        name: `${basename(root)} — direct connection`,
        product: basename(root),
        kind: "chromium",
        transport: "direct",
        profile: root,
        requiresApproval: true,
        endpoint: async () => debuggingEndpoint(root),
      })
    } catch {
      // A missing, disabled, malformed or oversized profile is not a target.
    }
  }
  return browsers
}

let cached:
  | { base: string; expires: number; browsers: Promise<LocalBrowser[]> }
  | undefined
export async function regularDebuggingBrowsers(): Promise<LocalBrowser[]> {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "linux"
        ? join(homedir(), ".config")
        : null
  if (!base) return []
  if (!cached || cached.base !== base || cached.expires <= Date.now()) {
    const browsers = debuggingBrowsers(base)
    cached = { base, expires: Date.now() + 10_000, browsers }
    void browsers.catch(() => {
      if (cached?.browsers === browsers) cached = undefined
    })
  }
  return cached.browsers
}
