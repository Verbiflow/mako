import { useSyncExternalStore } from "react"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { reviewSection } from "./authoring-review-section"

/** Settings, open on the section the review is at. */
export function AuthoringReviewPage() {
  const current = useSyncExternalStore(reviewSection.subscribe, reviewSection.get)
  return <SettingsDialog open section={current} onOpenChange={() => {}} onSectionChange={reviewSection.show} />
}
