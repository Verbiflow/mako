# macOS distribution

## Current release status

Mako currently ships without Apple code signing or notarization because the
project is not enrolled in the paid Apple Developer Program.

This has an important consequence: macOS does not have an Apple-issued identity
with which to verify Mako. A normal first launch from a downloaded DMG is
therefore blocked by Gatekeeper. This is not evidence that the checksum failed,
but it does mean users must decide whether they trust this repository before
running the app.

## Recommended installation

Read [`scripts/install-macos.sh`](../scripts/install-macos.sh), then run:

```bash
curl -fsSL https://github.com/Verbiflow/mako/releases/latest/download/install-macos.sh | bash
```

The installer:

1. Downloads `Mako-arm64.dmg` and `SHA256SUMS.txt` over HTTPS from the latest
   GitHub Release.
2. Verifies the DMG's SHA-256 checksum before mounting it.
3. Copies only `Mako.app` into `/Applications`.
4. Removes `com.apple.quarantine` only from that copied app.
5. Opens Mako.

It does not disable Gatekeeper globally, change macOS security policy, install a
privileged service, or retain administrator access. macOS may request an
administrator password only to write to `/Applications`.

Unsigned builds cannot authenticate automatic updates as coming from the same
publisher, so Mako disables its in-app updater for these builds. Re-run the same
installer command to update. Local sessions and settings live outside the app
bundle and remain in place.

## Manual DMG installation

The release also includes `Mako-arm64.dmg`. Drag Mako to Applications. On current
macOS versions, the first launch may require **System Settings → Privacy &
Security → Open Anyway**. Do not bypass that warning unless you trust the
repository and verified the checksum in `SHA256SUMS.txt`.

## Release integrity

Every release contains:

- `Mako-arm64.dmg`
- `Mako-arm64.zip`
- updater metadata and blockmaps
- `install-macos.sh`
- `SHA256SUMS.txt`

CI builds the app from the tagged commit, validates the ARM64 executable and
bundle identifier, mounts the DMG to verify the Applications shortcut, inspects
the updater ZIP, writes checksums, and only then creates the GitHub Release.
Release notes and the installer both disclose that the build is unsigned.

The GitHub `release` environment is restricted to `v*` tags and requires approval
from the repository owner. Public pull requests and unapproved jobs cannot
publish releases or access any future signing credentials.

## Future notarized releases

If the project later joins the Apple Developer Program, the same workflow can
sign and notarize releases when all five protected environment secrets are
present:

| Secret | Value |
| --- | --- |
| `MAC_CERT_P12` | Base64 Developer ID Application certificate and private key |
| `MAC_CERT_PASSWORD` | Password protecting the `.p12` export |
| `APPLE_API_KEY_P8` | App Store Connect API key contents |
| `APPLE_API_KEY_ID` | App Store Connect API Key ID |
| `APPLE_API_ISSUER` | App Store Connect Issuer ID |

Partial signing configuration fails the build. A fully configured release must
pass strict code-signature verification, Apple stapler validation, and
Gatekeeper assessment before publication. GitHub encrypts environment secrets
and does not expose their values through its API or interface.
