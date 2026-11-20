import { SideTab, TabReading } from "@/components/stage/side-tab"
import { openSetup } from "./setup-open"
import { useThreadSetupAsks } from "./setup-thread"

/** Setup's tab in the browser's right panel: its asks waiting on the person, in the attention hue, and a tap to open it. */
export function SetupRailRow({ open, conversation }: { open: boolean; conversation: string }) {
  const waiting = useThreadSetupAsks(conversation)
  return (
    <SideTab
      label="Setup"
      active={open}
      data-surface-id="setup"
      reading={waiting ? <TabReading words={`${waiting} need${waiting === 1 ? "s" : ""} you`} count={String(waiting)} attention /> : null}
      onClick={() => !open && openSetup()}
    />
  )
}
