import { useEffect } from "react"
import { ChevronLeftIcon } from "lucide-react"
import { PhoneSetup } from "@/components/setup/setup-page"
import { setSetupSource } from "@/state/setup"
import { useWebClient } from "./client"
import { webSetup } from "./setup-source"

/** The phone's Setup screen under a project: Back to where it was opened from. */
export function SetupScreen({ project, onBack }: { project: string; onBack: () => void }) {
  const client = useWebClient()
  useEffect(() => {
    setSetupSource(webSetup(client.gateway, client.account.id))
    return () => setSetupSource(undefined)
  }, [client])
  return <SetupScreenView project={project} onBack={onBack} />
}

/** The screen itself, on whatever source the page reads Setup from. */
export function SetupScreenView({ project, onBack }: { project: string; onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-shell">
      <header className="web-bar flex shrink-0 items-center gap-1 px-1.5">
        <button type="button" aria-label="Back" onClick={onBack} className="web-icon-button">
          <ChevronLeftIcon className="size-6" strokeWidth={2} />
        </button>
        <h1 className="flex-1 text-ui font-semibold">Setup</h1>
      </header>
      <div className="web-scroll min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <div className="mx-auto max-w-[560px]">
          <PhoneSetup folder={project} />
        </div>
      </div>
    </div>
  )
}
