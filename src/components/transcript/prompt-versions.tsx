import { useEffect } from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { useAcp } from "@/state/acp"
import { loadPromptVersions, promptVersionsKey, showPromptVersion, usePromptVersions } from "@/state/prompt-versions"

/**
 * "‹ 1/2 ›" beside a prompt that was edited: the version this conversation holds among the conversation it was first
 * sent in and each fork made from just before it, the arrows opening the one before or after. A prompt never edited
 * shows nothing.
 */
export function PromptVersionSwitcher({ conversation, requestId }: { conversation: string; requestId: string }) {
  const versions = usePromptVersions((state) => state.answers[promptVersionsKey(conversation, requestId)])
  // A fork made from just before it is one more version: asked again whenever the window holds another conversation.
  const held = useAcp((state) => Object.keys(state.conversations).length)
  useEffect(() => loadPromptVersions(conversation, requestId), [conversation, requestId, held])
  if (!versions || versions.conversations.length < 2) return null
  const { conversations, at } = versions
  const step = (by: number) => {
    const target = conversations[at + by]
    if (target) void showPromptVersion(target)
  }
  return (
    <span data-prompt-versions={`${at + 1}/${conversations.length}`} className="flex items-center text-faint">
      <button
        type="button"
        aria-label="Earlier version of this message"
        title="Earlier version"
        disabled={at === 0}
        onClick={() => step(-1)}
        className="pressable flex size-6 items-center justify-center hover:bg-fill-hover hover:text-foreground disabled:opacity-30"
      >
        <ChevronLeftIcon className="size-3.5" />
      </button>
      <span className="tabular px-0.5">{at + 1}/{conversations.length}</span>
      <button
        type="button"
        aria-label="Later version of this message"
        title="Later version"
        disabled={at === conversations.length - 1}
        onClick={() => step(1)}
        className="pressable flex size-6 items-center justify-center hover:bg-fill-hover hover:text-foreground disabled:opacity-30"
      >
        <ChevronRightIcon className="size-3.5" />
      </button>
    </span>
  )
}
