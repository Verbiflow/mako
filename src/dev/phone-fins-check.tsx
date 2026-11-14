// Explicit isolated fixture for the phone's Settings › Fins; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import { SessionSettingsSchema } from "@mako/sessions/settings"
import { Toaster } from "@/components/ui/sonner"
import { getMako } from "@/lib/bridge"
import { threadsStore } from "@/state/thread-store"
import { FinPolicySchema } from "@mako/host/contracts/fin-tuning"
import { FinsGroup, type MacCall } from "@/web-client/fins"
import { applyTheme } from "@/web-client/theme"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../web-client/style.css"

/**
 * The phone's Settings › Fins (`FinsGroup`) on the mock bridge's catalogs and choices, as a Mac answers them through
 * the gateway: `?open=<harness>` opens that harness's sheet, `?open=rule:<id>` a rule's, `?theme=light` the light theme.
 */

const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")
installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })

const call: MacCall = async <Result,>(channel: string, args: readonly unknown[]) => {
  const mako = getMako()
  const answer = channel === "mako:fin-defaults"
    ? await mako.finDefaults()
    : channel === "mako:fin-default-choose"
      ? await mako.chooseFinDefault(String(args[0]), SessionSettingsSchema.nullable().parse(args[1] ?? null))
      : channel === "mako:fin-policy-save"
        ? await mako.saveFinPolicy(FinPolicySchema.parse(args[0]))
      : channel === "mako:fin-limit-set"
        ? await mako.setFinLimit(args[0] === null ? null : Number(args[0]))
      : channel === "mako:fin-ceiling-set"
        ? await mako.setFinCeiling(Number(args[0]))
      : channel === "mako:fin-role-rules-save"
        ? await mako.saveRoleRules(args[0] === "forApexes" ? "forApexes" : "forFins", String(args[1]))
      : channel === "mako:harness-tuning"
        ? await mako.harnessTuning(String(args[0]))
        : undefined
  if (answer === undefined) throw new Error(`The fixture answers no ${channel}`)
  // SAFETY: each channel answers what its bridge method declares, as the Mac's host does through the gateway.
  return answer as Result
}

createRoot(document.getElementById("root")!).render(
  <div className="flex min-h-dvh flex-col bg-shell">
    <header className="web-bar flex shrink-0 items-center px-5">
      <h1 className="flex-1 text-ui font-semibold">Settings</h1>
    </header>
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-7 px-4 pt-3">
      <FinsGroup mac="Studio" call={call} {...(search.get("open") && { opened: search.get("open")! })} />
    </div>
    <Toaster position="top-center" />
  </div>
)
