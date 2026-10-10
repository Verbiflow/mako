/** Electron's Node offers it beside `node:fs`; base/physical-files.ts loads it only there. */
declare module "original-fs" {
  import * as fs from "node:fs"
  export = fs
}
