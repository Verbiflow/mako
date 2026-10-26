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

/**
 * A list whose every item is one file and nothing else (`- /tmp/a.png`),
 * as the asset paragraph it stands for: a list of screenshots is a
 * gallery, not nine full-size pictures each under its bullet. An item with
 * words beside its file keeps the list.
 */
function assetList(node: RootContent): Element | null {
  if (node.type !== "element" || (node.tagName !== "ul" && node.tagName !== "ol")) return null
  const items = node.children.filter((child): child is Element => child.type === "element")
  if (items.length < 2 || node.children.some((child) => child.type === "text" && child.value.trim())) return null
  const assets: Element["children"] = []
  for (const item of items) {
    if (item.tagName !== "li") return null
    const inner = item.children.filter((child) => !(child.type === "text" && !child.value.trim()))
    const only = inner.length === 1 ? inner[0] : undefined
    const content = only?.type === "element" && only.tagName === "p" ? only.children : item.children
    const paragraph: Element = { type: "element", tagName: "p", properties: {}, children: content }
    if (!assetParagraph(paragraph)) return null
    assets.push(...paragraph.children.filter((child) => child.type === "element"))
  }
  return { type: "element", tagName: "p", properties: { dataAssetGroup: true }, children: assets }
}

/** Adjacent asset-only paragraphs form a local gallery, as does a list of files alone. Prose breaks the group. */
export const rehypeAssetGroups: Plugin<[AssetGroupOptions?], Root> = options => tree => {
  omitRedundantPreviews(tree, options)
  const visit = (parent: Root | Element) => {
    const children = parent.children
    for (let at = 0; at < children.length; at++) {
      const first = children[at]
      const list = assetList(first)
      if (list) { children.splice(at, 1, list); continue }
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
