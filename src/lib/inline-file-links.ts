import { z } from "zod"
import type { Element } from "hast"
import { markdownFileTarget } from "./file-citations"
import { filePreviewFormat } from "../../electron/contracts/file-preview"

/** Compare known paths, never infer identity from a basename or filesystem search. */
export function filePreviewIdentity(path: string): string {
  const rooted = path.startsWith("/")
  // Keep `..`: traversing a symlink can make it refer to a different file.
  const parts = path.split("/").filter(part => part && part !== ".")
  return `${rooted ? "/" : ""}${parts.join("/")}`
}

/** Only inline descendants; block paragraphs own their own preview cards. */
export function inlineFileLinks(node: Element | undefined): string[] {
  const paths = new Set<string>()
  const visit = (entry: Element) => {
    if (["p", "ul", "ol", "li"].includes(entry.tagName)) return
    if (entry.tagName === "a") {
      if (entry.properties.dataFilePreview === false) return
      const href = z.string().safeParse(entry.properties.href)
      const target = href.success ? markdownFileTarget(href.data) : null
      if (
        target &&
        filePreviewFormat(target.path) &&
        !target.line &&
        !target.anchor
      )
        paths.add(target.path)
      return
    }
    for (const child of entry.children)
      if (child.type === "element") visit(child)
  }
  for (const child of node?.children ?? [])
    if (child.type === "element") visit(child)
  return [...paths]
}
