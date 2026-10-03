import type { Element, Root, RootContent } from "hast"
import type { Plugin } from "unified"
import { visit } from "unist-util-visit"
import { z } from "zod"
import { markdownFileTarget } from "./file-citations"
import { filePreviewIdentity, inlineFileLinks } from "./inline-file-links"

type AssetGroupOptions = { previewedFiles?: readonly string[] }

/** Explicit visuals own the preview; their other citations remain readable links. */
function omitRedundantPreviews(tree: Root, options?: AssetGroupOptions) {
  const native = new Set(options?.previewedFiles?.map(filePreviewIdentity))
  const represented = new Set(native)
  const targets = new WeakMap<Element, string>()
  visit(tree, "element", node => {
    if (node.tagName !== "img" && node.tagName !== "a") return
    const url = z.string().safeParse(node.properties[node.tagName === "img" ? "src" : "href"])
    const target = url.success ? markdownFileTarget(url.data) : null
    if (!target) return
    const key = filePreviewIdentity(target.path)
    targets.set(node, key)
    if (node.tagName === "img") represented.add(key)
  })
  if (!represented.size) return
  visit(tree, "element", node => {
    const key = targets.get(node)
    if (!key || !represented.has(key)) return
    if (node.tagName === "img") {
      if (!native.has(key)) return
      // Native attachment blocks already render this file. Preserve the authored
      // caption/location as a link instead of mounting a second visual body.
      const label = z.string().safeParse(node.properties.alt)
      node.tagName = "a"
      node.properties = { href: node.properties.src, dataFilePreview: false }
      node.children = [{ type: "text", value: label.success && label.data ? label.data : key.split("/").at(-1) ?? key }]
    } else node.properties.dataFilePreview = false
  })
}

function assetParagraph(node: RootContent): boolean {
  if (node.type !== "element" || node.tagName !== "p") return false
  return node.children.some(child => child.type === "element") && node.children.every(child =>
    child.type === "text" ? !child.value.trim() : child.type === "element" && (child.tagName === "img" || child.tagName === "a" && inlineFileLinks({ ...node, children: [child] }).length === 1)
  )
}

/** Adjacent asset-only paragraphs form a local gallery. Prose breaks the group. */
export const rehypeAssetGroups: Plugin<[AssetGroupOptions?], Root> = options => tree => {
  omitRedundantPreviews(tree, options)
  const visit = (parent: Root | Element) => {
    const children = parent.children
    for (let at = 0; at < children.length; at++) {
      const first = children[at]
      if (first.type !== "element" || !assetParagraph(first)) { if (first.type === "element") visit(first); continue }
      let end = at + 1
      const paragraphs = [first]
      while (end < children.length) {
        const next = children[end]
        if (next.type === "text" && !next.value.trim()) { end++; continue }
        if (next.type !== "element" || !assetParagraph(next)) break
        paragraphs.push(next)
        end++
      }
      if (paragraphs.length < 2) continue
      children.splice(at, end - at, { ...first, properties: { ...first.properties, dataAssetGroup: true }, children: paragraphs.flatMap(paragraph => paragraph.children) })
    }
  }
  visit(tree)
}
