import { useState } from "react"
import { CircleAlertIcon, KeyRoundIcon } from "lucide-react"
import { GITHUB_PERSON_SETTINGS, MAKO_GITHUB_APP, openAsAppPrompt, personTokenWords, type PersonTokenProblem } from "@mako/host/contracts/github-person"
import { askAgent } from "@/state/git-actions"

/**
 * Under a pull request tool's refusal of the person's own GitHub token: what happened, and the person's two ways on,
 * the same on the desktop, in a browser and on a phone, since all three draw this transcript. Update token opens
 * Settings where it's kept; the other sends the agent the person's choice to open it as Mako's App this once, in
 * their own words in the transcript. Nothing goes as the App until they press it.
 */
export function PersonTokenNotice({ problem }: { problem: PersonTokenProblem }) {
  const [sent, setSent] = useState(false)
  const { title, detail } = personTokenWords(problem)
  return (
    <div data-person-token-notice={problem.reason} className="my-1.5 rounded-md bg-surface/60 px-3 py-2.5 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
      <p className="flex items-center gap-1.5 text-ui text-foreground/90">
        <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-caution" />
        <span className="min-w-0">{title}</span>
      </p>
      <p className="pt-0.5 pb-2 pl-5 text-label leading-relaxed text-muted-foreground">{detail}</p>
      <div className="flex flex-wrap gap-1.5 pl-5">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: GITHUB_PERSON_SETTINGS }))}
          className="pressable flex items-center gap-1.5 rounded-md border border-hairline bg-foreground px-2 py-1 text-label text-background hover:opacity-90"
        >
          <KeyRoundIcon className="size-3" />
          Update token
        </button>
        <button
          type="button"
          disabled={sent}
          onClick={() => {
            setSent(true)
            void askAgent(openAsAppPrompt(problem.repository)).catch(() => setSent(false))
          }}
          className="pressable rounded-md border border-hairline px-2 py-1 text-label text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Open it as {MAKO_GITHUB_APP} instead
        </button>
      </div>
    </div>
  )
}
