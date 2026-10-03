import { z } from "zod"
import type { Element } from "hast"
import { markdownFileTarget } from "./file-citations"
import { filePreviewFormat } from "../../electron/contracts/file-preview"

/** Only inline descendants; block paragraphs own their own preview cards. */
export function inlineFileLinks(node: Element | undefined): string[] {
  const paths = new Set<string>()
  const visit = (entry: Element) => {
    if (["p", "ul", "ol", "li"].includes(entry.tagName)) return
    if (entry.tagName === "a") {
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
