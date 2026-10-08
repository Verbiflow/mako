import { OceanScene } from "@/components/ui/ocean-scene"
import { useMemo } from "react"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { Launcher } from "@/components/transcript/launcher"
import { MakoMark } from "@/components/ui/mako-mark"
import { Slot } from "@/extend/slot"
import { toExchanges } from "@/lib/exchanges"
import { foldTools } from "@/lib/tools"
import { useChatFolders } from "@/state/chat-folders"
import { useSession } from "@/state/session"
import { chatFolderOf } from "../../../electron/contracts/chat-folders.ts"
import { FolderIcon, MessageCircleIcon } from "lucide-react"

export function Transcript() {
  const sessionId = useSession((state) => state.meta?.sessionId)
  return <SessionTranscript key={sessionId ?? "none"} sessionId={sessionId} />
}

function SessionTranscript({ sessionId }: { sessionId: string | undefined }) {
  const messages = useSession((state) => state.messages)
  const stream = useSession((state) => state.stream)
  const exchanges = useMemo(() => {
    const list = toExchanges(foldTools(messages))
    if (!stream) return list
    const last = list.at(-1)
    if (!last) return [{ id: "draft", response: [stream], system: [] }]
    return [
      ...list.slice(0, -1),
      { ...last, response: [...last.response, stream] },
    ]
  }, [messages, stream])

  return (
    <>
      <Slot name="transcript.header" meta={undefined} />
      {exchanges.length === 0 ? (
        <>
          <OceanScene />
          <div className="min-h-0 flex-1 overflow-y-auto" data-empty-transcript>
            <EmptyTranscript />
          </div>
        </>
      ) : (
        <ConversationTimeline
          identity={sessionId ?? "none"}
          exchanges={exchanges}
          streamingId={stream ? exchanges.at(-1)?.id : undefined}
          empty={null}
        />
      )}
    </>
  )
}

/**
 * The opening screen.
 *
 * The most-seen screen in the app — every new session lands here — so it earns
 * the mark rather than a generic terminal glyph. It carries the two facts
 * worth knowing before typing (which folder the agent can edit, and which
 * model will answer) and three concrete openers. The openers fill the composer
 * rather than sending, so the first message is still the user's.
 */
function EmptyTranscript() {
  const cwd = useSession((state) => state.meta?.cwd)
  const model = useSession((state) => state.meta?.model?.name)
  const chat = useChatFolders((state) => chatFolderOf(cwd, state.root) !== undefined)

  return (
    <div className="relative flex min-h-full justify-center px-6">
      <div className="relative mt-8 mb-auto w-full max-w-[460px] py-12">
        <div className="flex items-center gap-3.5">
          <MakoMark className="size-8" />
          <div className="min-w-0">
            <p className="text-welcome font-medium">What are we working on?</p>
            <p className="mt-1 flex min-w-0 items-center gap-1.5 text-ui text-faint">
              {chat ? (
                <>
                  <MessageCircleIcon className="size-3 shrink-0" />
                  <span data-empty-chat className="truncate" title="The first message makes this chat a folder of its own in ~/Mako/Chats. Run git init there to make it a project.">
                    New chat, with its own folder in ~/Mako/Chats
                  </span>
                </>
              ) : (
                <>
                  <FolderIcon className="size-3 shrink-0" />
                  <span className="truncate" title={cwd}>
                    {cwd ?? "no workspace"}
                  </span>
                </>
              )}
              {model ? (
                <>
                  <span className="text-faint/50">·</span>
                  <span className="shrink-0 truncate">{model}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <Slot name="transcript.empty" meta={undefined} />
        <Launcher chat={chat} />
      </div>
    </div>
  )
}
