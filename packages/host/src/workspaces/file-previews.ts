import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const secret = randomBytes(32)
/** Capability URL issued only after a source-aware file read authorizes this exact path. */
export function filePreviewUrl(path: string): string {
  const payload = Buffer.from(path).toString("base64url")
  const signature = createHmac("sha256", secret).update(payload).digest("hex")
  return `mako-file://asset/${payload}/${signature}`
}

export function resolveFilePreview(url: string): string | null {
  const parsed = new URL(url)
  if (parsed.hostname !== "asset") return null
  const [payload, signature] = parsed.pathname.slice(1).split("/")
  if (!payload || !signature || !/^[a-f0-9]{64}$/.test(signature)) return null
  const expected = createHmac("sha256", secret).update(payload).digest()
  return timingSafeEqual(expected, Buffer.from(signature, "hex"))
    ? Buffer.from(payload, "base64url").toString()
    : null
}
