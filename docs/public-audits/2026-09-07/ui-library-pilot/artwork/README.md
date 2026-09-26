# Ocean opening revision

## Packaged desktop asset correction

The installed desktop initially showed only the dither and SVG fin because the JSX ocean images used `/artwork/mako-ocean-engraving.webp`. HTTP served that URL, but Electron's `loadFile` resolved it to `file:///artwork/...`, outside `app.asar`. The asset was present inside the package. The CSS dither URL had been transformed by Vite, which explained why that layer still appeared.

The ocean and About icon now use Vite `?url` imports, producing module-relative URLs in the packaged renderer. `npm run test:renderer-assets` builds the actual components once and loads them over HTTP and Electron `file://`, decoding both ocean images, the About icon and the CSS grain mask. Before the fix, HTTP passed and file mode failed at the missing ocean URL. After the fix both pass. `package:mac` runs this check before packaging.

The corrected application was built, signed, installed at `/Applications/Mako.app` and reopened. `../screenshots/desktop-assets-fixed.png` shows the actual installed desktop rendering the ocean and fin. Full build and lint pass. A backup of the prior installed application remains at `/tmp/mako-desktop-asset-fix/previous-Mako.app`.

The earlier faint procedural wave did not meet the requested visual ambition. After inspecting capy.ai's illustrated scenery and panel composition, the opening now uses an original generated marine engraving, with the existing warm palette applied through CSS. No Capy artwork was copied.

The source PNG is retained here. The application serves `public/artwork/mako-ocean-engraving.webp`, encoded at quality 85, approximately 266KB. The illustration is decorative and hidden from accessibility. Detailed water is below the opening controls.

Earlier screenshots are in `../screenshots/ocean-opening.png` and `../screenshots/ocean-sidebar.png`. The latest motion is recorded in `../screenshots/reflected-light.mp4`.

## Composer layout correction

The original plate was attached to the shrinking transcript viewport. Growing a draft changed the image crop, scale and horizon position; the empty transcript also inherited bottom-follow scrolling. The scene now belongs to the full agent pane with a fixed bottom inset, and the empty screen uses ordinary scrolling. Composer focus no longer changes its padding or minimum height. The text overlay and textarea retain identical padding.

The browser fixture exercises the actual Transcript and Composer together at 1, 12 and 30 lines, checking unchanged scene and heading coordinates relative to the pane and no focus-height change. Real-host checks measured identical scene bounds and heading position before and after a 12-line draft. Screenshots `composer-stable-empty.png` and `composer-stable-draft.png` show the result.

## Reflected light revision

### Final selection

Warm ink is the chosen treatment. The preview now presents one full-width composition, with no alternative gallery. A generated stochastic dither mask adds fine atmospheric grain above the water; its slow CSS drift accompanies the six-second foreground reflection. Rebuild the mask with `node scripts/generate-ocean-grain.mjs`. The coastline, fin, heading and composer stay fixed. Controls respond immediately, with 120ms border and hover transitions.

The water now alternates smoothly for a twelve-second round trip rather than resetting at the end of each sweep. The fin has a separate nine-second dither shimmer. Its SVG shares the original image's 1536 × 1024 coordinates and bottom-aligned cover crop, with a clip inset inside the engraved fin. Only the reveal mask moves; the stipple and silhouette stay fixed. Unique SVG IDs keep multiple mounted scenes independent. Browser checks verify both fin turnarounds, independent timing, shared image geometry and hidden-view pause. Full lint passes with zero Oxlint diagnostics.

Both layers pause on composer focus, hidden documents and offscreen views. Browser checks passed for independent grain movement, unchanged engraving geometry, pause/resume, reduced motion and zero JavaScript animation frames. The final `npm run lint` passes, including zero Oxlint diagnostics; ESLint retains the two existing TanStack Virtual warnings. The earlier blocking provider lint errors below have since been resolved by concurrent work.

The user rejected the green wash and the animated checkerboard strips. Both are removed. `OceanScene` renders the original engraving with warm ink by default and an optional neutral silver treatment. The first replacement was too faint, and the comparison opened on the still version. The animated version now appears first. A moving mask reveals brighter copies of the actual wave lines over a six-second cycle. The base engraving has lower opacity to give the reflection a visible luminance range. The mask confines the effect to the foreground water, and both copies retain identical geometry. There is no canvas or JavaScript animation loop. `../screenshots/visible-water.mp4` records the corrected animation; the older `reflected-light.mp4` records the rejected faint version.

Motion pauses while the composer is focused, when the scene leaves view, and when the document is hidden. The preference can disable it; reduced motion always disables it. The shoreline, fin and image geometry remain stationary.

Browser checks passed for all motion lifecycle cases, zero requested JavaScript animation frames, and zero relative image geometry delta. Earlier combined checks also passed composer focus and 1/12/30-line geometry, paragraph layout, clipboard behavior and divider controls. The final motion-only run used the same test function isolated from the unrelated composer module migration, which currently prevents rebuilding the combined fixture (`setComposerTuning` missing exports). Scoped ESLint and Oxlint pass. The latest full lint run is blocked by six diagnostics in concurrently edited Codex host/profile/settings files; no rules were bypassed.
