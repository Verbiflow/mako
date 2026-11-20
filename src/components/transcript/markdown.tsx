import { rehypeAssetGroups } from "@/lib/markdown-asset-groups"
import { ListItem } from "./list-item"
import { DiagramPreview, HighlightedCode } from "./code-preview"
import { TranscriptAttachment } from "./attachment"
import { embeddedCheck, keptEmbed, markdownMedia, previewableMediaUrl } from "@/lib/transcript-media"
import { useMediaAnswers } from "@/state/turn-media"
import type { AttachmentContent } from "@mako/sessions"
import { Paragraph } from "./paragraph"
import { useParsedProse, useSettledProse } from "./use-parsed-prose"
import { useStreamReveal } from "./stream-reveal"
import { useStreamedText } from "./use-live-answer"
import { forgetWarmedProse, WARM_PROSE_CHARS, warmedProse } from "@/lib/prose-parser-client"
import { rememberSettledProse, settledProse } from "./settled-prose"
import {
  skipMarkdownParse,
  reuseParsedProse,
  prosePlugins,
  treePieces,
} from "@/lib/parsed-markdown"
import type { Root } from "hast"
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
import { streamPieces, streamingMarkdown } from "@/lib/streaming-markdown"
import { ChangingLabel } from "@/components/ui/changing-label"
import { useCopy } from "@/components/ui/use-copy"
import {
  Children,
  createContext,
  useMemo,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useRef,
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
 * Splitting at every blank line and memoizing the settled blocks would be
 * wrong: Markdown is not context-free at a blank line, and a list with spaced
 * items would parse as several separate lists. Correctness comes first.
 *
 * So an answer is cut only at a blank line before a line that starts a block
 * of its own (not a list item, nor an item's indented text) outside code
 * (`streamPieces`, which keeps a document with definitions or HTML blocks
 * whole): what comes after such a cut parses the same alone. While an answer
 * streams, each piece before the last is parsed once and kept; only the piece
 * being written is parsed again.
 *
 * That piece is rate-limited rather than parsed per token: the first token of
 * a burst paints at once, then at most every 50 ms, longer for a long piece
 * (`StreamFrames`), which caps the cost at a fixed share of the renderer
 * regardless of answer length. When the message finishes, the pieces stay as
 * drawn and the whole answer is parsed once in the prose worker, its tree then
 * drawn into the same pieces (`useSettledProse`, `treePieces`), so what settles
 * is what the answer parsed whole draws. Nobody reads faster than the refresh, so the
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

/** A landed answer whose embedded media the host keeps (`AnswerMedia`): absent for prose that keeps none. */
const AnswerMediaContext = createContext<AnswerMedia | undefined>(undefined)

/**
 * The answer an embed (`![](/tmp/shot.png)`) belongs to: the key the host keeps its copy under, and when the answer
 * landed, so the copy is the file as the answer saw it. A screenshot `/tmp` later loses still draws from it.
 */
export interface AnswerMedia {
  callId: string
  at: number
}

export const Prose = memo(function Prose({
  text,
  streaming,
  className,
  urlTransform,
  sent,
  previewedFiles,
  answerId,
  keeps,
}: {
  text: string
  /** A landed answer's: the media it embeds is kept and drawn from Mako's copy. */
  keeps?: AnswerMedia
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
  // A reply being written takes its words from its conversation as they land, not from the turn's paced draw.
  const { shown: throttled, parsed: parsedChars } = useStreamedText(text, Boolean(streaming), sent ? undefined : answerId)
  // A streaming answer draws only whole structure, and keeps the pieces
  // before the last as parsed (`streamPieces`); the last piece is the one that grows.
  const pieceable = !sent && !urlTransform
  const live = Boolean(streaming) && pieceable
  // An answer that streamed here stays in its pieces once it settles: the pieces already drawn stay drawn, and the
  // whole answer is parsed in the worker (`useSettledProse`), its tree then drawn into the same pieces
  // (`treePieces`). Drawing the settled answer anew, parsed on the page, held it for as long as the answer was long.
  const [streamed, setStreamed] = useState(live)
  if (live && !streamed) setStreamed(true)
  const previewKey = previewedFiles?.join("\0") ?? ""
  const previewList = useMemo(() => (previewKey ? previewKey.split("\0") : undefined), [previewKey])
  const settles = streamed && !streaming && pieceable && throttled.length >= WARM_PROSE_CHARS
  const whole = useSettledProse(throttled, settles, previewList)
  const settling = settles && whole !== "failed"
  const pieces = useMemo(
    () => (live ? streamPieces(streamingMarkdown(throttled)) : settling ? streamPieces(throttled) : [throttled]),
    [live, settling, throttled]
  )
  const wholeTree = whole === "failed" ? undefined : (whole ?? undefined)
  const parts = useMemo(() => (wholeTree ? treePieces(wholeTree, pieces) : undefined), [wholeTree, pieces])
  const growing = pieces.at(-1) ?? ""
  // The next paint waits by what this one parsed: the piece being written, not the whole answer.
  useEffect(() => parsedChars(growing.length), [parsedChars, growing])
  const kept = pieces.slice(0, -1)
  const keptChars = kept.reduce((total, piece) => total + piece.length, 0)
  // A long last piece of a settling answer is parsed in the worker as it was while it streamed, until the whole tree lands.
  const parsed = useParsedProse(growing, (Boolean(streaming) || (settling && !parts)) && !sent)
  const source = parsed?.text ?? growing
  // A settled answer's tree, where it was parsed before this turn mounted (`warmSettledProse`): read once per text,
  // so prose drawn without one isn't drawn again when its tree arrives late.
  const ahead = useMemo(
    () => (streaming || settling || sent || urlTransform || settledProse.has(growing) ? undefined : warmedProse(growing)),
    [growing, streaming, settling, sent, urlTransform]
  )
  const tree = parsed?.tree ?? ahead
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
  const assets = useMemo<AssetPlugin>(
    () => [rehypeAssetGroups, { previewedFiles: previewList }],
    [previewList]
  )
  const rehypePlugins = useMemo<RehypePlugins>(
    () => (tree ? [[reuseParsedProse, tree], assets] : [assets]),
    [tree, assets]
  )

  const settled = !streaming && !settling && !referenceInput && !urlTransform && !parsed && !previewedFiles?.length
  const lastPart = parts?.at(-1)
  const rendered = useMemo(() => {
    // The whole answer's tree has landed: its last part, already grouped (`parseSettledProse`).
    if (lastPart) return treeMarkdown(lastPart)
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
    if (settled) {
      rememberSettledProse(source, element)
      forgetWarmedProse(source)
    }
    return element
  }, [lastPart, source, plugins, referenceMap, urlTransform, rehypePlugins, settled])
  // Once drawn from the whole tree, the answer is kept as any settled answer is, for this prose mounting again.
  useEffect(() => {
    if (!parts || !pieceable || previewKey) return
    rememberSettledProse(throttled, <>{parts.map((part, index) => <KeptPiece key={index} text="" tree={part} assets={assets} />)}</>)
    forgetWarmedProse(throttled)
  }, [parts, pieceable, previewKey, throttled, assets])

  // A streaming answer's newest words are revealed at a steady pace and fade in (`useStreamReveal`).
  const root = useRef<HTMLDivElement>(null)
  useStreamReveal(root, Boolean(streaming) && !sent, keptChars + source.length)

  return (
    <div
      ref={root}
      className={cn("mako-prose", className)}
      data-answer={answerId}
      data-rendered-chars={keptChars + source.length}
      data-prose-worker={Boolean(parsed || parts) || undefined}
    >
      <ProseStreamingContext value={Boolean(streaming)}>
        <AnswerMediaContext value={keeps}>
        <PromptReferencesContext value={referenceMap}>
          <PromptSkillsContext value={skillMap}>
            {kept.map((piece, index) => (
              <KeptPiece key={index} text={piece} tree={parts?.[index]} assets={assets} />
            ))}
            {rendered}
          </PromptSkillsContext>
        </PromptReferencesContext>
        </AnswerMediaContext>
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
 * A piece of a streaming answer before its last cut (`streamPieces`). Its text no
 * longer changes, so it is parsed once and React skips it on every later
 * frame of the stream. Once the answer settles and its whole tree lands, the piece
 * draws its part of that tree (`treePieces`) over what it drew, element for element.
 */
const KeptPiece = memo(function KeptPiece({ text, tree, assets }: { text: string; tree?: Root; assets: AssetPlugin }) {
  return useMemo(
    () =>
      tree
        ? treeMarkdown(tree)
        : Markdown({
            remarkPlugins: ANSWER_PLUGINS,
            rehypePlugins: [assets],
            components,
            urlTransform: keptUrlTransform,
            children: text,
          }),
    [text, tree, assets]
  )
})

const keptUrlTransform = (url: string) => (keptUrl(url) ? url : defaultUrlTransform(url))
const TREE_PLUGINS = [skipMarkdownParse]

/** A part of a settled answer's whole tree (`parseSettledProse`), already grouped: drawn as the tree says. */
function treeMarkdown(tree: Root) {
  return Markdown({
    remarkPlugins: TREE_PLUGINS,
    rehypePlugins: [[reuseParsedProse, tree]],
    components,
    urlTransform: keptUrlTransform,
    children: "",
  })
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
            className="pressable mt-1 flex items-center gap-1 px-1 py-0.5 text-label text-faint hover:text-foreground"
          >
            <ExpandIcon className="size-3" />
            Expand table
          </button>
        </DialogTrigger>
        <DialogContent className="max-w-[calc(100vw-2rem)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <DialogTitle>Table</DialogTitle>
            <DialogClose
              className="pressable p-1"
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
  const keeps = useContext(AnswerMediaContext)
  if (!src) return <span>{alt || "Image unavailable"}</span>
  return <KeptMarkdownMedia attachment={markdownMedia(src, alt)} keeps={keeps} />
}

/**
 * An embed in a landed answer, drawn from the copy the host kept of it when there is one (`embedded`), else from the
 * file where it is: the same as before the copy, and what a file the answer saw changed since comes back as.
 */
function KeptMarkdownMedia({ attachment, keeps }: { attachment: AttachmentContent; keeps: AnswerMedia | undefined }) {
  const [answer] = useMediaAnswers([embeddedCheck(attachment, keeps)])
  return <TranscriptAttachment attachment={keptEmbed(attachment, answer)} />
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
            className="pressable ml-2 px-1 text-label text-faint"
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
            "pressable ml-auto flex h-5 items-center gap-1 px-1.5 text-label",
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
