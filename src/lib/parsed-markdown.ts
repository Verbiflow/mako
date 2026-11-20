import { remarkHeadingAnchors } from "./markdown-headings"
import { unified, type Plugin, type PluggableList } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkRehype from "remark-rehype"
import type { Root as MarkdownRoot } from "mdast"
import type { Root } from "hast"
import { remarkFileCitations } from "./citation-markdown"
import { remarkPromptReferences } from "./prompt-markdown"
import { rehypeAssetGroups } from "./markdown-asset-groups"

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

/**
 * A settled answer's tree as `Prose` draws it: parsed whole, with its galleries formed and the previews its native
 * visuals already show left out (`rehypeAssetGroups`). Both read the whole answer, so they run here, beside the parse.
 */
export function parseSettledProse(text: string, previewedFiles?: readonly string[]): Root {
  const tree = parseProse(text)
  unified().use(rehypeAssetGroups, { previewedFiles }).runSync(tree)
  return tree
}

/**
 * A whole answer's tree cut where its text was cut into `pieces` (`streamPieces`): each top-level block goes with the
 * piece its source starts in, and what has no source (the line breaks between blocks, a gallery made from a list) with
 * the block before it. Joined in order, the parts are the tree's blocks, so drawn one after another they are the
 * whole answer drawn at once; each part is what that piece drew while the answer streamed, wherever the whole answer
 * reads the same as the piece alone.
 */
export function treePieces(tree: Root, pieces: readonly string[]): Root[] {
  const parts: Root[] = pieces.map(() => ({ type: "root", children: [] }))
  let piece = 0
  let end = pieces[0]?.length ?? 0
  for (const node of tree.children) {
    const start = node.position?.start.offset
    if (start !== undefined)
      while (piece < pieces.length - 1 && start >= end) {
        piece += 1
        end += pieces[piece]!.length
      }
    parts[piece]?.children.push(node)
  }
  return parts
}

export const skipMarkdownParse: Plugin<[], MarkdownRoot> = function () {
  this.parser = () => ({ type: "root", children: [] })
}

export function reuseParsedProse(tree: Root) {
  return () => structuredClone(tree)
}

/** What the prose worker is asked: `settled` for a whole answer drawn as `parseSettledProse` draws it. */
export interface ProseParseRequest {
  text: string
  settled?: { previewedFiles?: readonly string[] }
}

export type ProseParseReply = { ok: true; tree: Root } | { ok: false }
