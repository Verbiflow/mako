import type { Element, Root, RootContent } from "hast"
import type { Plugin } from "unified"
import { inlineFileLinks } from "./inline-file-links"

function assetParagraph(node: RootContent): boolean {
  if (node.type !== "element" || node.tagName !== "p") return false
  return node.children.some(child => child.type === "element") && node.children.every(child =>
    child.type === "text" ? !child.value.trim() : child.type === "element" && (child.tagName === "img" || child.tagName === "a" && inlineFileLinks({ ...node, children: [child] }).length === 1)
  )
}

/** Adjacent asset-only paragraphs form a local gallery. Prose breaks the group. */
export const rehypeAssetGroups: Plugin<[], Root> = () => tree => {
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
