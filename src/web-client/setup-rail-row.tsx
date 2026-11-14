import { PackageIcon } from "lucide-react"
import { RailRow } from "@/components/rail/rail-row"
import { openSetup } from "./setup-open"
import { useThreadSetupAsks } from "./setup-thread"

/** Setup's row in the browser's right rail: its asks waiting on the person, in the attention hue, and a tap to open it. */
export function SetupRailRow({ open, conversation }: { open: boolean; conversation: string }) {
  const waiting = useThreadSetupAsks(conversation)
  return (
    <RailRow
      role="tab"
      aria-selected={open}
      aria-current={undefined}
      tabIndex={open ? 0 : -1}
      data-surface-id="setup"
      icon={<PackageIcon />}
      label="Setup"
      open={open}
      end={waiting ? <span className="tabular shrink-0 text-label font-medium text-attention">{`${waiting} need${waiting === 1 ? "s" : ""} you`}</span> : null}
      onClick={() => !open && openSetup()}
    />
  )
}
