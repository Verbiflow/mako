export const DESK_SCHEME = "mako-app"
export const DESK_HOST = "desk"
export const DESK_ORIGIN = `${DESK_SCHEME}://${DESK_HOST}`
const PREVIEW_PREFIX = "/__mako_file/"

/** Keep packaged previews on the desk origin without enabling cross-origin file access. */
export function resolveDeskPreviewUrl(value: string, documentUrl: string, clientId?: string): string {
  if (!value.startsWith("mako-file:")) return value
  const target = new URL(value)
  if (clientId) target.searchParams.set("client", clientId)
  const document = new URL(documentUrl)
  if (document.protocol !== `${DESK_SCHEME}:` || document.host !== DESK_HOST) return target.href
  return `${DESK_ORIGIN}${PREVIEW_PREFIX}${target.host}${target.pathname}${target.search}`
}

/** Recover only a desk preview URL; the existing file handler still authorizes every request. */
export function deskPreviewFile(url: string): string | null {
  const target = new URL(url)
  if (target.protocol !== `${DESK_SCHEME}:` || target.host !== DESK_HOST || !target.pathname.startsWith(PREVIEW_PREFIX)) return null
  const path = target.pathname.slice(PREVIEW_PREFIX.length)
  if (!path || path.startsWith("/")) return null
  return `mako-file://${path}${target.search}`
}
