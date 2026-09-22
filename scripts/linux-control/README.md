# Isolated Linux acceptance

Each run gets its own X server and D-Bus session. It cannot send desktop input to
the Mac host or to another container. The fixture compares Mako's observations
with GTK's own state file and sends tagged keyboard input to another window.

Build the repository's control package and Electron host first, then:

```sh
docker build -t mako-control-linux:platform-v2 -f scripts/linux-control/Dockerfile .
node scripts/package-control-driver-linux.mjs /absolute/path/to/patched-cua
```

The packager requires the exact commit and patch in `vendor/cua-driver/release.json`.
It writes a release executable, MIT license and provenance under
`release/control-driver/<version>/linux-arm64` on an ARM64 Docker host. It does not
install or change the running Mac driver. Linux x64 requires its own build and
acceptance; ARM64 results do not establish x64 coverage.

Run the suite with an empty evidence directory:

```sh
docker run --rm \
  --mount type=bind,source="$PWD",target=/repo,readonly \
  --mount type=bind,source=/absolute/path/to/evidence,target=/evidence \
  --mount type=volume,source=mako-control-linux-target,target=/target,readonly \
  -e MAKO_TEST_DRIVER=/target/release/cua-driver \
  mako-control-linux:platform-v2 sh /repo/scripts/linux-control/start-desktop.sh
```

The suite covers exact values, full and capped reads, public strict locators,
30 save jobs, concurrent tagged typing, foreground refusal at both boundaries,
reordered and destroyed controls, modal parent refusal, and a value longer than
the read cap. It intentionally starts an unrestricted driver only inside this
private test desktop. Production hosts keep their authorization boundary.

The runtime requires an accessibility bus and an X11 desktop. On Wayland the
host refuses foreground delivery until the backend can attest the exact focused
window. Do not derive shared-desktop promises from isolated X11 results.
