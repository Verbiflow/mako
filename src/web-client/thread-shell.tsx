import { ChevronLeftIcon } from "lucide-react"
import { CodeLine, CodeSlowLine } from "./code-unavailable"
import { TranscriptLoading } from "./transcript-loading"

/**
 * A Thread tapped before its screen's code arrived: its bar, with Back and the title the list already holds, over the
 * transcript's loader, as its screen draws them, so the tap answers at once and nothing moves when the code lands. A
 * line with Retry and Reload in the transcript's place if the code can't arrive, and past its patience, still on its
 * way, "Still loading this Thread…" with Reload over the loader.
 */
export function ThreadShell({ title, onBack, failed, slow, retry }: { title: string | undefined; onBack: (() => void) | undefined; failed: boolean; slow: boolean; retry: () => Promise<void> }) {
  return (
    <div data-thread-loading="" className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className="web-bar web-bar-thread flex shrink-0 items-center gap-1 px-1.5">
        {onBack ? (
          <button type="button" aria-label="Back to threads" onClick={onBack} className="web-icon-button">
            <ChevronLeftIcon className="size-6" strokeWidth={2} />
          </button>
        ) : (
          <span className="w-2" />
        )}
        <h1 className="min-w-0 flex-1 truncate text-ui font-semibold">{title}</h1>
      </header>
      {failed ? (
        <div className="flex flex-1 items-center">
          <CodeLine what="This Thread" retry={retry} className="w-full" />
        </div>
      ) : (
        <>
          {slow ? <CodeSlowLine what="this Thread" slow className="justify-center px-4 pt-4" /> : null}
          <TranscriptLoading />
        </>
      )}
    </div>
  )
}
