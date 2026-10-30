import { rehypeAssetGroups } from "@/lib/markdown-asset-groups"
import { ListItem } from "./list-item"
import { DiagramPreview, HighlightedCode } from "./code-preview"
import { TranscriptAttachment } from "./attachment"
import { markdownMedia, previewableMediaUrl } from "@/lib/transcript-media"
import { Paragraph } from "./paragraph"
import { useParsedProse } from "./use-parsed-prose"
import {
  skipMarkdownParse,
  reuseParsedProse,
  prosePlugins,
} from "@/lib/parsed-markdown"
import {
  ContextItemChip,
  FileChip,
  McpChip,
  SkillChip,
  ThreadChip,
} from "@/components/composer/reference-chip"
import type { PromptReference, SentProse } from "@/lib/prompt-markdown"
import { isSkillName } from "@/lib/skill-references"
import { ProseStreamingContext } from "./prose-layout-context"
import { fenceSegments, streamingMarkdown } from "@/lib/streaming-markdown"
import { StreamFrames } from "@/lib/stream-frames"
import { ChangingLabel } from "@/components/ui/changing-label"
import { useCopy } from "@/components/ui/use-copy"
import {
  Children,
  createContext,
  useMemo,
  isValidElement,
  memo,
  useEffect,
  useContext,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react"
import Markdown, { defaultUrlTransform } from "react-markdown"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog"
import { CheckIcon, CopyIcon, ExpandIcon, XIcon } from "lucide-react"
import { decodeFileCitation, markdownFileTarget } from "@/lib/file-citations"
import { cn } from "@/lib/utils"
import { FileReferenceLink } from "./file-reference-link"
import { REVIEW_FENCE } from "@mako/sessions/review"
import { ReviewFence } from "./review-card"

/**
 * Markdown is the most expensive thing in the transcript, and while a message
 * streams it is also the most frequently repeated: parsing the whole answer on
 * every token is O(n) per token, so a long reply costs O(n²) before it lands.
 *
 * The obvious fix — split at blank lines and memoize the settled blocks — is
 * wrong. Markdown is not context-free at a blank line: a list with spaced
 * items would parse as several separate lists, and a setext heading would lose
 * its underline. Correctness has to come first here.
 *
 * A closed code fence at the left edge is a boundary where it is: the fence
 * ends any list or quote above it and its lines are never Markdown, so what
 * comes after it parses the same alone (`fenceSegments`, which keeps a
 * document with definitions or HTML blocks whole). While an answer streams,
 * each piece before its last such fence is parsed once and kept; only the
 * piece being written is parsed again.
 *
 * That piece is rate-limited rather than parsed per token: the first token of
 * a burst paints at once, then at most every 50 ms, longer for a long piece
 * (`StreamFrames`), which caps the cost at a fixed share of the renderer
 * regardless of answer length, and the whole answer settles in one parse the
 * moment the message finishes. Nobody reads faster than the refresh, so the
 * throttle is invisible. What it draws stops short of half-built structure
 * (`streamingMarkdown`): a table arrives a row at a time and a fence once its
 * opening line is whole, so neither flashes as a paragraph of pipes or
 * backticks first.
 */
const EMPTY_REFERENCES = new Map<string, PromptReference>()
const PromptReferencesContext =
  createContext<ReadonlyMap<string, PromptReference>>(EMPTY_REFERENCES)
interface SentSkill {
  name: string
  /** The provider whose copy was handed over; absent when the provider had its own. */
  from?: string
}
const EMPTY_SKILLS = new Map<string, SentSkill>()
/** What a sent prompt's appendix said about each `$skill`, so its chip can say the same. */
const PromptSkillsContext =
  createContext<ReadonlyMap<string, SentSkill>>(EMPTY_SKILLS)

/**
 * Settled prose, rendered once per text. `Markdown` is a pure function of
 * its input, and the elements it returns read references and the transcript
 * source from context when they render, so a thread switched back to or a
 * turn scrolled back into view reuses them instead of parsing again.
 */
const SETTLED_PROSE_ENTRIES = 600
const SETTLED_PROSE_CHARS = 6_000_000
const settledProse = new Map<string, ReactElement>()
let settledProseChars = 0

function rememberSettledProse(text: string, element: ReactElement) {
  settledProse.set(text, element)
  settledProseChars += text.length
  while (
    settledProse.size > SETTLED_PROSE_ENTRIES ||
    settledProseChars > SETTLED_PROSE_CHARS
  ) {
    const oldest = settledProse.keys().next().value
    if (oldest === undefined) break
    settledProse.delete(oldest)
    settledProseChars -= oldest.length
  }
}

export const Prose = memo(function Prose({
  text,
  streaming,
  className,
  urlTransform,
  sent,
  previewedFiles,
  answerId,
}: {
  text: string
  className?: string
  /** The reply's message id, when this is an answer's prose: its words can be quoted in a reply (`quote-reply.tsx`). */
  answerId?: string
  /** A sent prompt's items (`readSent`): its markers and typed references read as chips. */
  sent?: SentProse
  /** File-backed native visuals already rendered by this reply. */
  previewedFiles?: readonly string[]
  /** While true the parse is rate-limited rather than run per token. */
  streaming?: boolean
  urlTransform?: (url: string) => string
}) {
  // The skills a sent prompt carried; a `/skill` with none went out as typed.
  const skillMap = useMemo(() => {
    const entries = sent?.items.flatMap((item) => (item.kind === "skill" ? [item.skill] : [])) ?? []
    return entries.length > 0 ? new Map(entries.map((entry) => [entry.name, entry])) : EMPTY_SKILLS
  }, [sent])
  const throttled = useThrottled(text, Boolean(streaming))
  // A streaming answer draws only whole structure, and keeps the pieces
  // before its last closed fence as parsed; the last piece is the one that grows.
  const pieced = Boolean(streaming) && !sent && !urlTransform
  const pieces = useMemo(
    () => (pieced ? fenceSegments(streamingMarkdown(throttled)) : [throttled]),
    [pieced, throttled]
  )
  const growing = pieces.at(-1) ?? ""
  const kept = pieces.slice(0, -1)
  const keptChars = kept.reduce((total, piece) => total + piece.length, 0)
  const parsed = useParsedProse(growing, Boolean(streaming) && !sent)
  const source = parsed?.text ?? growing
  const tree = parsed?.tree
  const hasTree = Boolean(tree)
  const referenceInput = useMemo(
    () => (sent ? { sent, references: new Map<string, PromptReference>(), text: source } : null),
    [source, sent]
  )
  const referenceMap = referenceInput?.references ?? EMPTY_REFERENCES
  const plugins = useMemo<
    NonNullable<Parameters<typeof Markdown>[0]["remarkPlugins"]>
  >(
    () => (hasTree ? [skipMarkdownParse] : prosePlugins(referenceInput)),
    [referenceInput, hasTree]
  )
  // Sections are rebuilt on every streamed batch, so the list arrives as a new
  // array each time; keyed by its contents, unchanged prose is not reparsed.
  const previewKey = previewedFiles?.join("\0") ?? ""
  const assets = useMemo<AssetPlugin>(
    () => [rehypeAssetGroups, { previewedFiles: previewKey ? previewKey.split("\0") : undefined }],
    [previewKey]
  )
  const rehypePlugins = useMemo<RehypePlugins>(
    () => (tree ? [[reuseParsedProse, tree], assets] : [assets]),
    [tree, assets]
  )

  const settled = !streaming && !referenceInput && !urlTransform && !hasTree && !previewedFiles?.length
  const rendered = useMemo(() => {
    const cached = settled ? settledProse.get(source) : undefined
    if (cached) {
      settledProse.delete(source)
      settledProse.set(source, cached)
      return cached
    }
    const element = Markdown({
      remarkPlugins: plugins,
      rehypePlugins,
      components,
      urlTransform: (url) =>
        referenceMap.has(url) || keptUrl(url)
          ? url
          : (urlTransform?.(url) ?? defaultUrlTransform(url)),
      children: source,
    })
    if (settled) rememberSettledProse(source, element)
    return element
  }, [source, plugins, referenceMap, urlTransform, rehypePlugins, settled])

  return (
    <div
      className={cn("mako-prose", className)}
      data-answer={answerId}
      data-rendered-chars={keptChars + source.length}
      data-prose-worker={hasTree || undefined}
    >
      <ProseStreamingContext value={Boolean(streaming)}>
        <PromptReferencesContext value={referenceMap}>
          <PromptSkillsContext value={skillMap}>
            {kept.map((piece, index) => (
              <KeptPiece key={index} text={piece} assets={assets} />
            ))}
            {rendered}
          </PromptSkillsContext>
        </PromptReferencesContext>
      </ProseStreamingContext>
    </div>
  )
})

type RehypePlugins = NonNullable<Parameters<typeof Markdown>[0]["rehypePlugins"]>
type AssetPlugin = [typeof rehypeAssetGroups, { previewedFiles?: readonly string[] }]

/** A link the transcript draws itself (a file citation, a path, a previewable medium) keeps its address. */
function keptUrl(url: string): boolean {
  return Boolean(decodeFileCitation(url) || markdownFileTarget(url) || previewableMediaUrl(url))
}

const ANSWER_PLUGINS = prosePlugins()

/**
 * A piece of a streaming answer before its last closed fence. Its text no
 * longer changes, so it is parsed once and React skips it on every later
 * frame of the stream.
 */
const KeptPiece = memo(function KeptPiece({ text, assets }: { text: string; assets: AssetPlugin }) {
  return useMemo(
    () =>
      Markdown({
        remarkPlugins: ANSWER_PLUGINS,
        rehypePlugins: [assets],
        components,
        urlTransform: (url) => (keptUrl(url) ? url : defaultUrlTransform(url)),
        children: text,
      }),
    [text, assets]
  )
})

/**
 * Latest value while it streams, painted as `StreamFrames` paces it: the first
 * change of a burst at once, then at most once a frame. Only unmount (or
 * StrictMode's simulated one) stops a pending paint, and the effect after it
 * schedules again.
 */
function useThrottled(text: string, active: boolean): string {
  const [shown, setShown] = useState(text)
  const [frames] = useState(() => new StreamFrames(setShown))

  // A settled message renders its exact text with no delay. Adjusting during
  // render rather than in an effect avoids the extra pass a cascading setState
  // would cost on the frame the turn completes.
  if (!active && shown !== text) {
    setShown(text)
  }

  // Settled, a paint still pending would draw a streaming text over it.
  useEffect(() => {
    if (active) frames.next(text)
    else frames.stop()
  }, [active, text, frames])

  useEffect(() => () => frames.stop(), [frames])

  return shown
}

const components = {
  p: Paragraph,
  li: ListItem,
  pre: CodeBlock,
  a: CitationLink,
  img: MarkdownMedia,
  table: MarkdownTable,
} satisfies Parameters<typeof Markdown>[0]["components"]

function MarkdownTable({ children }: ComponentProps<"table">) {
  return (
    <div className="mako-table">
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Table"
      >
        <table>{children}</table>
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="pressable mt-1 flex items-center gap-1 rounded px-1 py-0.5 text-label text-faint hover:text-foreground"
          >
            <ExpandIcon className="size-3" />
            Expand table
          </button>
        </DialogTrigger>
        <DialogContent className="max-w-[calc(100vw-2rem)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <DialogTitle>Table</DialogTitle>
            <DialogClose
              className="pressable rounded p-1"
              aria-label="Close table"
            >
              <XIcon className="size-4" />
            </DialogClose>
          </div>
          <div
            className="mako-prose max-h-[80vh] overflow-auto"
            tabIndex={0}
            role="region"
            aria-label="Expanded table"
          >
            <table>{children}</table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MarkdownMedia({ src, alt }: ComponentProps<"img">) {
  if (!src) return <span>{alt || "Image unavailable"}</span>
  return <TranscriptAttachment attachment={markdownMedia(src, alt)} />
}

function CitationLink({ href, children, ...rest }: ComponentProps<"a"> & { "data-bare-file"?: boolean | string }) {
  const bareFile = rest["data-bare-file"]
  const references = useContext(PromptReferencesContext)
  const sentSkills = useContext(PromptSkillsContext)
  const reference = href ? references.get(href) : undefined
  if (reference?.kind === "item") return <ContextItemChip item={reference.item} record={reference.record} />
  if (reference?.kind === "file")
    return <FileChip path={reference.path} interactive={!reference.path.endsWith("/")} />
  if (reference?.kind === "thread")
    return (
      <ThreadChip harness={reference.harness} id={reference.id} />
    )

  if (reference?.kind === "skill") {
    // `$5` is prose the tokenizer let through, never a skill nothing has,
    // and a `/word` the send resolved to nothing was a word, not a skill.
    if (!isSkillName(reference.name)) return <>{children}</>
    if (reference.raw.startsWith("/") && !sentSkills.has(reference.name)) return <>{children}</>
    return (
      <SkillChip
        name={reference.name}
        sent={sentSkills.get(reference.name) ?? (sentSkills.size > 0 ? null : undefined)}
      />
    )
  }
  if (reference?.kind === "mcp") return <McpChip name={reference.name} />
  const target = markdownFileTarget(href)
  if (!href)
    return (
      <span title="This action is unavailable outside the source app">
        {children}
      </span>
    )
  if (!target)
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  // A link, not a button: a long path has to wrap with the sentence around
  // it, and a button lays its text out as a centred block.
  return <FileReferenceLink href={href} target={target} bare={bareFile !== undefined && bareFile !== false}>{children}</FileReferenceLink>
}

/**
 * A fenced code block.
 *
 * The language label and the copy button live in a real header row rather than
 * floating over the code. The previous version positioned them absolutely and
 * tried to reserve space with a `pt-6` utility — which silently lost, because
 * `.mako-prose pre` is a class-plus-element selector and outranks a single
 * utility class. The label then sat on top of the first line. Laying the
 * header out in normal flow removes the specificity fight entirely.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const source = extractText(children)
  const { copied, copy } = useCopy(source)
  const language = extractLanguage(children)
  const streaming = useContext(ProseStreamingContext)
  const [showSource, setShowSource] = useState(false)
  const diagram = language === "mermaid"

  const block = (
    <div className="mako-code group" data-inline-code={language ?? "text"}>
      <div className="mako-code-head">
        <span className="font-mono text-label tracking-wide text-faint select-none">
          {language ?? "text"}
        </span>
        {diagram ? (
          <button
            type="button"
            className="pressable ml-2 rounded px-1 text-label text-faint"
            onClick={() => setShowSource((value) => !value)}
          >
            {showSource ? "Diagram" : "Source"}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Copy code"
          onClick={() => {
            void copy()
          }}
          className={cn(
            "pressable ml-auto flex h-5 items-center gap-1 rounded px-1.5 text-label",
            "text-faint opacity-0 transition-opacity duration-150",
            "group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
          )}
        >
          {copied ? (
            <CheckIcon className="size-3 text-positive" />
          ) : (
            <CopyIcon className="size-3" />
          )}
          <span role="status" className="min-w-8">
            <ChangingLabel text={copied ? "Copied" : "Copy"} />
          </span>
        </button>
      </div>
      {diagram && !showSource && !streaming ? (
        <DiagramPreview source={source} />
      ) : (
        <HighlightedCode
          source={source}
          language={language ?? "text"}
          streaming={streaming}
        />
      )}
    </div>
  )
  return language === REVIEW_FENCE ? <ReviewFence source={source} streaming={streaming} fallback={block} /> : block
}

function extractText(node: ReactNode): string {
  return Children.toArray(node).map(extractChildText).join("")
}

function extractChildText(node: ReactNode): string {
  if (isElementWithChildren(node)) return extractText(node.props.children)
  return String(node)
}

function isElementWithChildren(
  node: ReactNode
): node is ReactElement<{ children?: ReactNode }> {
  return isValidElement<{ children?: ReactNode }>(node)
}

function extractLanguage(node: ReactNode): string | null {
  if (!isCodeElement(node)) return null
  const match = /language-([\w+-]+)/.exec(node.props.className ?? "")
  return match?.[1] ?? null
}

function isCodeElement(
  node: ReactNode
): node is ReactElement<ComponentProps<"code">, "code"> {
  return isValidElement<ComponentProps<"code">>(node) && node.type === "code"
}
