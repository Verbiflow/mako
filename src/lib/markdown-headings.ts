import { unified } from "unified"
import remarkParse from "remark-parse"
import type { Heading, Root, PhrasingContent } from "mdast"

function headingText(node: PhrasingContent): string {
  if ("value" in node) return node.value
  if ("alt" in node) return node.alt ?? ""
  return "children" in node ? node.children.map(headingText).join("") : ""
}

/** Heading IDs and source positions come from the same parser as the preview. */
function headings(tree: Root): Array<{ node: Heading; id: string }> {
  const used = new Set<string>()
  const result: Array<{ node: Heading; id: string }> = []
  const visit = (node: Root | Root["children"][number]) => {
    if (node.type === "heading") {
      const base = node.children.map(headingText).join("").toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "").replace(/\s/g, "-")
      let id = base
      for (let suffix = 1; used.has(id); suffix++) id = `${base}-${suffix}`
      used.add(id)
      result.push({ node, id })
    } else if ("children" in node) {
      for (const child of node.children) {
        // Container blocks, not inline children, can contain headings.
        if (child.type === "blockquote" || child.type === "list" || child.type === "listItem" || child.type === "heading") visit(child)
      }
    }
  }
  visit(tree)
  return result
}

export function markdownAnchorLine(contents: string, anchor: string): number | undefined {
  const tree = unified().use(remarkParse).parse(contents)
  return headings(tree).find(({ id }) => id === anchor)?.node.position?.start.line
}

export function remarkHeadingAnchors() {
  return (tree: Root) => {
    for (const { node, id } of headings(tree)) {
      node.data ??= {}
      node.data.hProperties = { ...node.data.hProperties, id, "data-source-line": node.position?.start.line }
    }
  }
}
