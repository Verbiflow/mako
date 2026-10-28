import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { CheckIcon, ChevronLeftIcon, CloudIcon, GitBranchIcon } from "lucide-react"
import { WebHarnessIcon } from "./harness-icon"
import { Orb } from "@/components/ui/orb/orb"
import { cn } from "@/lib/utils"
import { titleFromPrompt } from "@/state/acp-start"
import { accountProjects, cloudHarnesses, startCloudThread, typedRepository, type StartStep, type WebProject } from "./account"
import { useWebClient } from "./client"
import { SendGlyph } from "./glyphs"
import { WEB_HARNESSES, webHarnessLabel } from "./labels"

const STEP_WORDS = {
  making: "Making its Thread",
  preparing: "Starting its machine and cloning the project",
  starting: "Starting the harness",
} satisfies Record<StartStep, string>
const CLOUD_ENTITLEMENT = "cloud"

/**
 * A new Thread in the cloud, from the phone: a project, a harness, the first message. It starts as a Mac's cloud start
 * does, and opens as soon as its machine has it; every device lists it from its machine's own report.
 */
export function NewThread({ onBack, onStarted }: { onBack: () => void; onStarted: (conversation: { threadId: string; conversationId: string }) => void }) {
  const client = useWebClient()
  const [projects, setProjects] = useState<WebProject[] | undefined>(undefined)
  const [offered, setOffered] = useState<readonly string[]>(WEB_HARNESSES)
  const [project, setProject] = useState<string | undefined>(undefined)
  const [typed, setTyped] = useState("")
  const [harness, setHarness] = useState(() => localStorage.getItem("mako:web:harness") ?? "claude")
  const [text, setText] = useState("")
  const [step, setStep] = useState<StartStep | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const input = useRef<HTMLTextAreaElement>(null)
  const entitled = client.account.entitlements.includes(CLOUD_ENTITLEMENT)

  useEffect(() => {
    void accountProjects(client.gateway).then(
      (found) => {
        setProjects(found)
        setProject((chosen) => chosen ?? found[0]?.url)
      },
      () => setProjects([])
    )
    void cloudHarnesses(client.gateway).then((found) => {
      if (found.length) setOffered(WEB_HARNESSES.filter((each) => found.includes(each)))
    })
  }, [client])
  useLayoutEffect(() => {
    const node = input.current
    if (!node) return
    node.style.height = "auto"
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 96), 240)}px`
  }, [text])

  const repository = useMemo(() => (typed.trim() ? typedRepository(typed) : project ? typedRepository(project) : undefined), [typed, project])
  const ready = entitled && repository !== undefined && text.trim().length > 0 && step === undefined
  const start = async () => {
    if (!repository || !ready) return
    setFailure(undefined)
    localStorage.setItem("mako:web:harness", harness)
    try {
      // Named from the first message, as the desk names every Thread it starts; the harness's own title replaces it.
      const title = titleFromPrompt(text.trim())
      const started = await startCloudThread(client.gateway, client.deviceId, { repository, harness, text: text.trim(), title }, setStep)
      onStarted(started)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      setStep(undefined)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className="web-bar flex shrink-0 items-center gap-1 border-b border-hairline px-2">
        <button type="button" aria-label="Back to threads" onClick={onBack} className="web-icon-button">
          <ChevronLeftIcon className="size-5" />
        </button>
        <h1 className="flex flex-1 items-center gap-1.5 text-ui font-semibold">
          <CloudIcon className="size-4 text-muted-foreground" />
          New thread in the cloud
        </h1>
      </header>
      <form
        className="web-scroll min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+20px)]"
        onSubmit={(event) => {
          event.preventDefault()
          void start()
        }}
      >
        <div className="mx-auto flex max-w-[560px] flex-col gap-6">
          {!entitled ? (
            <p className="rounded-xl bg-raised px-4 py-3 text-ui text-muted-foreground ring-1 ring-hairline">This account's plan doesn't include the cloud yet. Threads on your Macs still show here, live.</p>
          ) : null}
          <fieldset className="flex flex-col gap-2" disabled={step !== undefined}>
            <legend className="pb-2 text-label font-medium text-faint">Project</legend>
            {projects === undefined ? (
              <span className="skeleton h-11 rounded-xl" aria-hidden />
            ) : projects.length ? (
              <div className="flex flex-col overflow-hidden rounded-xl ring-1 ring-hairline">
                {projects.slice(0, 6).map((each) => (
                  <button
                    key={each.url}
                    type="button"
                    aria-pressed={project === each.url && !typed.trim()}
                    onClick={() => {
                      setProject(each.url)
                      setTyped("")
                    }}
                    className="web-row flex h-12 items-center gap-3 border-b border-hairline px-3.5 text-left last:border-b-0"
                  >
                    <GitBranchIcon className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate text-ui">{each.name}</span>
                    {project === each.url && !typed.trim() ? <CheckIcon className="size-4 text-foreground" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={projects?.length ? "Or another: owner/repository" : "A GitHub repository: owner/repository"}
              aria-label="GitHub repository"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              className={cn("web-field", typed.trim() && !typedRepository(typed) && "ring-negative/60")}
            />
          </fieldset>
          <fieldset className="flex flex-col gap-2" disabled={step !== undefined}>
            <legend className="pb-2 text-label font-medium text-faint">Harness</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {offered.map((each) => (
                <button
                  key={each}
                  type="button"
                  aria-pressed={harness === each}
                  onClick={() => setHarness(each)}
                  className={cn("pressable flex h-11 items-center gap-2 rounded-xl px-3 text-ui ring-1", harness === each ? "bg-fill-selected font-medium ring-border" : "text-muted-foreground ring-hairline")}
                >
                  <WebHarnessIcon harness={each} className="size-4" />
                  <span className="truncate">{webHarnessLabel(each)}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-2">
            <span className="text-label font-medium text-faint">First message</span>
            <textarea ref={input} value={text} onChange={(event) => setText(event.target.value)} placeholder="What should it work on?" className="web-field min-h-24 resize-none py-3 leading-relaxed" disabled={step !== undefined} />
          </label>
          {failure ? (
            <p role="alert" className="rounded-xl bg-negative/10 px-4 py-3 text-ui text-negative">
              {failure}
            </p>
          ) : null}
          {step ? (
            <p role="status" className="flex items-center gap-2.5 text-ui text-muted-foreground">
              <Orb state="working" size={20} />
              {STEP_WORDS[step]}…
            </p>
          ) : null}
          <button type="submit" disabled={!ready} className="web-button h-12 justify-center">
            <SendGlyph />
            Start in the cloud
          </button>
        </div>
      </form>
    </div>
  )
}
