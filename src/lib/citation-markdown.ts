import type { Root, PhrasingContent, InlineCode } from "mdast"
import { visit } from "unist-util-visit"
import { inlineFileTarget, linkFileCitations } from "./file-citations"

/** Transform prose nodes only; code examples and link labels remain literal. */
export function remarkFileCitations() {
  return (tree: Root) => {
    // Only an explicit output-directory declaration binds subsequent bare
    // filenames in this section. No filesystem searches or guessed directories.
    const directories = new WeakMap<InlineCode, string>()
    let directory: string | undefined
    for (const block of tree.children) {
      if (block.type === "heading") directory = undefined
      if (block.type === "paragraph") {
        const code = block.children.filter((node) => node.type === "inlineCode")
        const before = block.children[0]
        const candidate = code.length === 1 ? code[0]?.value : undefined
        if (before?.type === "text" &&
          /\b(?:files|assets|screenshots|recordings|artifacts|outputs?)\s+(?:are|is|live|were saved|are saved|are stored)\s+(?:in|under|at)\s*$/i.test(before.value) &&
          candidate && /^(?:\/|~\/|\.\.?\/)/.test(candidate) && candidate.endsWith("/") &&
          !/[*?[\]{}\n\r]/.test(candidate)) directory = candidate
      }
      if (directory) {
        const folder = directory
        visit(block, (node) => { if (node.type === "inlineCode") directories.set(node, folder) })
      }
    }
    visit(tree, "text", (node, index, parent) => {
      if (
        index === undefined ||
        !parent ||
        parent.type === "link" ||
        parent.type === "linkReference"
      )
        return
      const linked = linkFileCitations(node.value)
      if (linked === node.value) return
      const children: PhrasingContent[] = []
      let offset = 0
      for (const match of linked.matchAll(
        /\[([^\]]+)\]\((mako-citation:[^)]+)\)/g
      )) {
        if (match.index > offset)
          children.push({
            type: "text",
            value: linked.slice(offset, match.index),
          })
        children.push({
          type: "link",
          url: match[2]!,
          children: [
            {
              type: "text",
              value: match[1]!.replaceAll("\\[", "[").replaceAll("\\]", "]"),
            },
          ],
        })
        offset = match.index + match[0].length
      }
      if (offset < linked.length)
        children.push({ type: "text", value: linked.slice(offset) })
      parent.children.splice(index, 1, ...children)
      return index + children.length
    })
    visit(tree, "inlineCode", (node, index, parent) => {
      if (index === undefined || !parent || parent.type === "link" || parent.type === "linkReference") return
      const target = inlineFileTarget(node.value)
      if (!target) return
      const directory = directories.get(node)
      const url = directory && !/[\\/]/.test(target.path)
        ? `${directory}${node.value}`
        : node.value
      parent.children.splice(index, 1, {type: "link", url, children: [node]})
      return index + 1
    })
    visit(tree, "code", (node, index, parent) => {
      const citation = /^(\d+):(\d+):(.+)$/.exec(node.lang ?? "")
      if (!citation || index === undefined || !parent) return
      const path = citation[3]!
      node.lang = path.split(".").at(-1) ?? null
      parent.children.splice(index, 0, {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: `${path}#L${citation[1]}-L${citation[2]}`,
            children: [
              { type: "text", value: `${path}:${citation[1]}–${citation[2]}` },
            ],
          },
        ],
      })
      return index + 2
    })
  }
}
