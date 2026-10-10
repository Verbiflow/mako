import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { assertDraftsSaved } from "@/lib/draft-persistence"
import type { LifecycleAction, LifecycleCommand, LifecycleState, UpdateInstallation } from "@mako/host/contracts/app-lifecycle"

export const applicationStore = createStore<{
  lifecycle: LifecycleState | null
  installation: UpdateInstallation | null
  dialog: LifecycleAction | null
  busy: boolean
  error: string | null
}>({
  lifecycle: null,
  installation: null,
  dialog: null,
  busy: false,
  error: null,
})
export const useApplication = createHook(applicationStore)

async function perform(run: () => Promise<void>): Promise<void> {
  if (applicationStore.get().busy) return
  applicationStore.set({ busy: true, error: null })
  try {
    await run()
  } catch (error) {
    applicationStore.set({
      error:
        error instanceof Error
          ? error.message
          : "Mako could not complete this action. Try again.",
    })
  } finally {
    applicationStore.set({ busy: false })
  }
}

async function command(input: LifecycleCommand): Promise<void> {
  const lifecycle = await getMako().lifecycleCommand(input)
  applicationStore.set({ lifecycle })
  if (lifecycle.operation.kind === "error")
    applicationStore.set({ error: lifecycle.operation.message })
  else applicationStore.set({ dialog: null })
}

export const application = {
  async load() {
    if (!hasBridge()) return
    try {
      const [lifecycle, installation] = await Promise.all([
        getMako().lifecycleState(),
        getMako().installationState(),
      ])
      applicationStore.set({ lifecycle, installation })
    } catch (error) {
      applicationStore.set({
        error:
          error instanceof Error
            ? error.message
            : "Application status is unavailable.",
      })
    }
  },
  openUpdates() {
    window.dispatchEvent(
      new CustomEvent("mako:settings", { detail: "updates" })
    )
  },
  request(action: LifecycleAction): Promise<void> {
    return perform(async () => {
      const lifecycle = await getMako()
        .lifecycleState()
        .catch((error) => {
          applicationStore.set({ dialog: action })
          throw error
        })
      applicationStore.set({ lifecycle })
      if (
        lifecycle.work.length ||
        lifecycle.operation.kind === "stopping" ||
        lifecycle.operation.kind === "applying"
      ) {
        applicationStore.set({ dialog: action })
        return
      }
      try {
        if (action === "quit") {
          assertDraftsSaved()
          await getMako().quitClient()
          applicationStore.set({ dialog: null })
        } else await command({ kind: "wait", action })
      } catch (error) {
        applicationStore.set({ dialog: action })
        throw error
      }
    })
  },
  dismiss() {
    if (!applicationStore.get().busy)
      applicationStore.set({ dialog: null, error: null })
  },
  keepRunning(): Promise<void> {
    return perform(async () => {
      assertDraftsSaved()
      await getMako().quitClient()
      applicationStore.set({ dialog: null })
    })
  },
  wait(action: LifecycleAction): Promise<void> {
    return perform(() => command({ kind: "wait", action }))
  },
  stop(action: LifecycleAction, revision: string): Promise<void> {
    return perform(() => command({ kind: "stop", action, revision }))
  },
  cancel(): Promise<void> {
    return perform(() => command({ kind: "cancel" }))
  },
  selectSource(): Promise<void> {
    return perform(async () => {
      const path = await getMako().pickFolder()
      if (path)
        applicationStore.set({
          installation: await getMako().selectUpdateSource(path),
        })
    })
  },
  build(): Promise<void> {
    application.openUpdates()
    return perform(async () => {
      await getMako().buildUpdate()
      applicationStore.set({
        installation: await getMako().installationState(),
      })
    })
  },
  async shutdown(requestId: string): Promise<void> {
    try {
      assertDraftsSaved()
      await getMako().acknowledgeShutdown(requestId)
      await getMako().quitClient()
    } catch (error) {
      applicationStore.set({
        dialog: "quit",
        busy: false,
        error:
          error instanceof Error
            ? error.message
            : "This window could not close safely.",
      })
    }
  },
}
