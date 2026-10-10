export function workspacePreviewPath(requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== "mako-file:" || url.host !== "workspace") return null
  // `mako-file://workspace//Users/…` is an absolute path; one slash is relative.
  const absolute = url.pathname.startsWith("//")
  const encoded = url.pathname.slice(absolute ? 2 : 1).split("/")
  const parts: string[] = []
  try {
    for (const value of encoded) {
      const part = decodeURIComponent(value)
      if (
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("/") ||
        part.includes("\\") ||
        part.includes("\0")
      ) {
        return null
      }
      parts.push(part)
    }
  } catch {
    return null
  }
  return (absolute ? "/" : "") + parts.join("/")
}
