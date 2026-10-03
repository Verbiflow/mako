import { remarkHeadingAnchors } from "./markdown-headings"
import { unified, type Plugin, type PluggableList } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkRehype from "remark-rehype"
import type { Root as MarkdownRoot } from "mdast"
import type { Root } from "hast"
import { remarkFileCitations } from "./citation-markdown"
import { remarkPromptReferences } from "./prompt-markdown"

export function prosePlugins(
  references?: Parameters<typeof remarkPromptReferences>[0] | null
): PluggableList {
  return references
    ? [remarkGfm, [remarkPromptReferences, references], remarkFileCitations, remarkHeadingAnchors]
    : [remarkGfm, remarkFileCitations, remarkHeadingAnchors]
}

export function parseProse(text: string): Root {
  const parser = unified()
    .use(remarkParse)
    .use(prosePlugins())
    .use(remarkRehype, { allowDangerousHtml: true })
  return parser.runSync(parser.parse(text))
}

export const skipMarkdownParse: Plugin<[], MarkdownRoot> = function () {
  this.parser = () => ({ type: "root", children: [] })
}

export function reuseParsedProse(tree: Root) {
  return () => structuredClone(tree)
}

export type ProseParseReply = { ok: true; tree: Root } | { ok: false }
