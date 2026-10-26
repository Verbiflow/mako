import { z } from "zod"
import type { Element } from "hast"
import { markdownFileTarget } from "./file-citations"
import { filePreviewFormat } from "@mako/host/contracts/file-preview"

/** Compare known paths, never infer identity from a basename or filesystem search. */
export function filePreviewIdentity(path: string): string {
  const rooted = path.startsWith("/")
  // Keep `..`: traversing a symlink can make it refer to a different file.
  const parts = path.split("/").filter(part => part && part !== ".")
  return `${rooted ? "/" : ""}${parts.join("/")}`
}

/** One file an element links, as written, and whether it's a bare name (`shot.png`) the host found by the Thread's touches. */
export interface InlineFileSpelling {
  spelling: string
  bare: boolean
}

/**
 * The files an element's inline content links, for previews under it. A
 * bare name counts only when it names a picture, a video or audio: one
 * of those the Thread made is worth showing; a bare `utils.ts` stays a link.
 * Only inline descendants; block paragraphs own their own preview cards.
 */
export function inlineFileSpellings(node: Element | undefined): InlineFileSpelling[] {
  const found = new Map<string, boolean>()
  const visit = (entry: Element) => {
    if (["p", "ul", "ol", "li"].includes(entry.tagName)) return
    if (entry.tagName === "a") {
      if (entry.properties.dataFilePreview === false) return
      const bare = Boolean(entry.properties.dataBareFile)
      const href = z.string().safeParse(entry.properties.href)
      const target = href.success ? markdownFileTarget(href.data) : null
      const format = target ? filePreviewFormat(target.path) : undefined
      if (
        target &&
        format &&
        (!bare || format === "image" || format === "video" || format === "audio") &&
        !target.line &&
        !target.anchor &&
        !found.has(target.path)
      )
        found.set(target.path, bare)
      return
    }
    for (const child of entry.children)
      if (child.type === "element") visit(child)
  }
  for (const child of node?.children ?? [])
    if (child.type === "element") visit(child)
  return [...found].map(([spelling, bare]) => ({ spelling, bare }))
}

/** The paths an element links outright; bare names wait on the host and aren't among them. */
export function inlineFileLinks(node: Element | undefined): string[] {
  return inlineFileSpellings(node).flatMap((entry) => (entry.bare ? [] : [entry.spelling]))
}
