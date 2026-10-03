/** Resolve document images beside the authorized source file. */
export function resolveMarkdownMedia(contents: string, path: string): string {
  const folder = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/") + 1)
    : ""
  return contents.replace(
    /(!\[[^\]]*\]\()([^\s)]+)(\))/g,
    (match, before: string, source: string, after: string) => {
      if (/^(?:[a-z]+:|#|\/)/i.test(source)) return match
      const joined = `${folder}${source}`
      const parts: string[] = []
      for (const part of joined.split("/")) {
        if (!part || part === ".") continue
        if (part === "..") parts.pop()
        else parts.push(part)
      }
      const encoded = parts.map((part) => encodeURIComponent(part)).join("/")
      // A file opened by absolute path keeps its images beside it: the extra
      // slash marks the resolved path as absolute rather than workspace-relative.
      const prefix = path.startsWith("/") ? "/" : ""
      return `${before}mako-file://workspace/${prefix}${encoded}${after}`
    }
  )
}

