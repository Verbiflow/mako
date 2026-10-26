import type { CarriedFilesView } from "@mako/host/contracts/cloud-carried-files"

/**
 * A project's carried files in Mako Cloud, for `?mock`: every project carries `.env.local` and `config/dev.local.json`
 * and links `fixtures/recordings`, as the mock recipe does. They start in the cloud and current; `carried=changed` with
 * `.env.local` changed here since, `carried=unasked` before the person was asked (a move asks), `carried=declined`
 * with their no.
 */
export function mockCarriedFiles() {
  const params = new URLSearchParams(globalThis.location?.search)
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const asked = params.get("carried")
  const projects = new Map<string, CarriedFilesView>()
  const view = (folder: string): CarriedFilesView => {
    let project = projects.get(folder)
    if (!project) {
      const allowed = asked === null || asked === "changed"
      project = {
        project: folder,
        repository: `https://github.com/acme/${folder.split("/").filter(Boolean).at(-1) ?? "shop"}`,
        decision: allowed ? "allowed" : asked === "declined" ? "declined" : "unasked",
        files: [
          { path: ".env.local", bytes: 312, credentials: true, cloud: allowed ? { savedAt: minutesAgo(60 * 26), current: asked !== "changed" } : null, kept: false },
          { path: "config/dev.local.json", bytes: 1_840, credentials: false, cloud: allowed ? { savedAt: minutesAgo(60 * 26), current: true } : null, kept: false },
        ],
        staying: [{ path: "fixtures/recordings", why: "linked to the main folder, not copied" }],
      }
      projects.set(folder, project)
    }
    return project
  }
  const settle = async (folder: string, change: (project: CarriedFilesView) => CarriedFilesView) => {
    await new Promise((resolve) => setTimeout(resolve, 450))
    const next = change(view(folder))
    projects.set(folder, next)
    return next
  }
  const now = () => new Date().toISOString()
  return {
    cloudCarriedFiles: async (folder: string) => view(folder),
    cloudCarriedFilesDecide: (folder: string, allowed: boolean) =>
      settle(folder, (project) => ({
        ...project,
        decision: allowed ? "allowed" : "declined",
        files: project.files.map((file) => ({ ...file, cloud: allowed && !file.kept ? { savedAt: now(), current: true } : null })),
      })),
    cloudCarriedFilesKeep: (folder: string, path: string, keep: boolean) =>
      settle(folder, (project) => ({
        ...project,
        files: project.files.map((file) => (file.path === path ? { ...file, kept: keep, cloud: keep ? null : { savedAt: now(), current: true } } : file)),
      })),
  }
}
