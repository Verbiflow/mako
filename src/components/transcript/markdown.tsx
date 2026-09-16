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
  FileChip,
  McpChip,
  SkillChip,
  ThreadChip,
} from "@/components/composer/reference-chip"
import type { PromptReference } from "@/lib/prompt-markdown"
import { isSkillName, type SkillAppendixEntry } from "@/lib/skill-references"
import type { ThreadAppendixEntry } from "@/lib/thread-references"
import type { AttachmentFileReference } from "@/lib/attachments"
import { ProseStreamingContext } from "./prose-layout-context"
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
import { useTranscriptSource } from "./source-context"
import { viewer } from "@/state/viewer"

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
 * So the parse stays whole and is instead *rate-limited* while streaming. The
 * text is re-parsed at most every ~90ms rather than on every token, which caps
 * the cost at a fixed rate regardless of answer length, and settles
 * immediately the moment the message finishes. Nobody reads faster than the
 * refresh, so the throttle is invisible.
 */
const STREAM_FRAME_MS = 90
const EMPTY_REFERENCES = new Map<string, PromptReference>()
const PromptReferencesContext =
  createContext<ReadonlyMap<string, PromptReference>>(EMPTY_REFERENCES)
const EMPTY_SKILLS = new Map<string, SkillAppendixEntry>()
/** What a sent prompt's appendix said about each `$skill`, so its chip can say the same. */
const PromptSkillsContext =
  createContext<ReadonlyMap<string, SkillAppendixEntry>>(EMPTY_SKILLS)

export const Prose = memo(function Prose({
  text,
  streaming,
  className,
  urlTransform,
  references,
  skills,
  threads,
}: {
  text: string
  className?: string
  references?: readonly AttachmentFileReference[]
  /** The skill entries a sent prompt carried; a `$skill` with none went out as typed. */
  skills?: readonly SkillAppendixEntry[]
  /** Referenced conversations with no token to restore; their placeholders read as title chips. */
  threads?: readonly ThreadAppendixEntry[]
  /** While true the parse is rate-limited rather than run per token. */
  streaming?: boolean
  urlTransform?: (url: string) => string
}) {
  const skillMap = useMemo(
    () =>
      skills && skills.length > 0
        ? new Map(skills.map((entry) => [entry.name, entry]))
        : EMPTY_SKILLS,
    [skills]
  )
  const throttled = useThrottled(text, Boolean(streaming))
  const parsed = useParsedProse(throttled, Boolean(streaming) && !references)
  const source = parsed?.text ?? throttled
  const tree = parsed?.tree
  const hasTree = Boolean(tree)
  const referenceInput = useMemo(
    () =>
      references
        ? {
            text: source,
            files: references,
            references: new Map<string, PromptReference>(),
            threads,
          }
        : null,
    [source, references, threads]
  )
  const referenceMap = referenceInput?.references ?? EMPTY_REFERENCES
  const plugins = useMemo<
    NonNullable<Parameters<typeof Markdown>[0]["remarkPlugins"]>
  >(
    () => (hasTree ? [skipMarkdownParse] : prosePlugins(referenceInput)),
    [referenceInput, hasTree]
  )
  const rehypePlugins = useMemo<
    Parameters<typeof Markdown>[0]["rehypePlugins"]
  >(() => (tree ? [[reuseParsedProse, tree]] : undefined), [tree])

  const rendered = useMemo(
    () => (
      <Markdown
        remarkPlugins={plugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={(url) =>
          referenceMap.has(url) ||
          decodeFileCitation(url) ||
          markdownFileTarget(url) ||
          previewableMediaUrl(url)
            ? url
            : (urlTransform?.(url) ?? defaultUrlTransform(url))
        }
      >
        {source}
      </Markdown>
    ),
    [source, plugins, referenceMap, urlTransform, rehypePlugins]
  )

  return (
    <div
      className={cn("mako-prose", className)}
      data-rendered-chars={source.length}
      data-prose-worker={hasTree || undefined}
    >
      <ProseStreamingContext value={Boolean(streaming)}>
        <PromptReferencesContext value={referenceMap}>
          <PromptSkillsContext value={skillMap}>{rendered}</PromptSkillsContext>
        </PromptReferencesContext>
      </ProseStreamingContext>
    </div>
  )
})

/**
 * Latest value, but no more often than one frame per `STREAM_FRAME_MS`.
 *
 * A pending frame outlives text changes on purpose (cancelling it on each
 * token would turn the throttle into a debounce that never fires under a
 * steady stream), so only unmount clears it — and clearing must empty the
 * ref too. It once did not: StrictMode's simulated remount ran that cleanup
 * and re-ran the scheduling effect, which saw a "pending" timer that had been
 * cleared and never scheduled another, so the first token of every streamed
 * answer stayed on screen until the turn ended ("I", then the tool rows).
 */
function useThrottled(text: string, active: boolean): string {
  const [shown, setShown] = useState(text)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef(text)

  // A settled message renders its exact text with no delay. Adjusting during
  // render rather than in an effect avoids the extra pass a cascading setState
  // would cost on the frame the turn completes.
  if (!active && shown !== text) {
    setShown(text)
  }

  useEffect(() => {
    pending.current = text
    if (!active || timer.current !== null) return
    timer.current = setTimeout(() => {
      timer.current = null
      setShown(pending.current)
    }, STREAM_FRAME_MS)
  }, [active, text])

  useEffect(() => {
    return () => {
      if (timer.current === null) return
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  return shown
}

const components = {
  p: Paragraph,
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

function CitationLink({ href, children }: ComponentProps<"a">) {
  const source = useTranscriptSource()
  const references = useContext(PromptReferencesContext)
  const sentSkills = useContext(PromptSkillsContext)
  const reference = href ? references.get(href) : undefined
  if (reference?.kind === "attachment")
    return (
      <FileChip
        path={reference.file.path}
        name={reference.file.name}
        interactive
      />
    )
  if (reference?.kind === "file")
    return <FileChip path={reference.path} interactive />
  if (reference?.kind === "thread")
    return (
      <ThreadChip harness={reference.harness} id={reference.id} />
    )
  if (reference?.kind === "thread-title")
    return <ThreadChip harness={reference.harness} title={reference.title} />

  if (reference?.kind === "skill") {
    // `$5` is prose the tokenizer let through, never a skill nothing has.
    if (!isSkillName(reference.name)) return <>{children}</>
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
  return (
    <button
      type="button"
      title={target.purpose ? `${target.purpose}: ${target.path}` : target.path}
      onClick={() =>
        void viewer.open(
          target.path,
          target.line,
          source.threadPath,
          source.liveId
        )
      }
      className="pressable font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
    >
      {children}
    </button>
  )
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

  return (
    <div className="mako-code group">
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
