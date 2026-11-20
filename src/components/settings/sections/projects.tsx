import { FolderGit2Icon } from "lucide-react"
import { ProjectsSection } from "@/components/settings/projects-section"
import { PROJECTS_SECTION } from "@/state/project-settings"
import type { SettingsSection } from "./manifest"

export const section = {
  id: PROJECTS_SECTION,
  title: "Projects",
  group: "Project",
  icon: FolderGit2Icon,
  keywords: [
    "project",
    "folder",
    "path",
    "hidden",
    "hide",
    "base branch",
    "start from",
    "worktree",
    "setup script",
    "run script",
    "environment variables",
    "files to copy",
    "repository",
    "github",
    "cloud",
  ],
  Component: ProjectsSection,
} as const satisfies SettingsSection
