/**
 * An Appshot's elements as the desk reads them back, to draw their boxes
 * over the picture. Mako control writes the outline
 * (`@mako/control/computer/outline`, the one projection an Appshot and the
 * control SDK's `window.appshot()` share); the renderer reaches packages
 * only through the host's contracts, so the reader crosses here.
 */
export {
  outlineLine,
  readWindowOutline,
  type ElementBox,
  type OutlineLine,
  type ReadOutline,
} from "@mako/control/computer/outline"
