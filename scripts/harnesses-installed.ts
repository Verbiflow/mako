// Which harnesses this machine can run, as Mako's own drivers find them. Not
// PATH: Devin's CLI ships inside Devin.app, Cursor runs through its SDK
// package, and each resolver looks where its harness installs.
import { providerHost } from "../electron/providers/index.ts"

for (const driver of providerHost.liveDrivers.list())
  console.log(`${driver.provider}: ${driver.available(process.cwd()) ? "installed" : "not installed"}`)
