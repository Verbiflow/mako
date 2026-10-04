import { FolderGit2Icon } from "lucide-react"
import { WorktreesSection } from "@/components/settings/worktrees-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "worktrees",
  title: "Worktrees",
  group: "Project",
  icon: FolderGit2Icon,
  keywords: [
    "git",
    "worktree",
    "own branch",
    "branch",
    "new threads",
    "project folder",
    "checkout",
    "disk",
    "space",
    "merged",
    "clean up",
    "remove",
  ],
  Component: WorktreesSection,
} as const satisfies SettingsSection
