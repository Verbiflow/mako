// Which harnesses this machine can run, as Mako's own drivers find them. Not
// PATH: Devin's CLI ships inside Devin.app, Cursor runs through its SDK
// package, and each resolver looks where its harness installs.
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

for (const driver of providerHost.liveDrivers.list())
  console.log(`${driver.provider}: ${driver.available(process.cwd()) ? "installed" : "not installed"}`)
