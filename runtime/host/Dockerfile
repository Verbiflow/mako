# Mako's host as a Linux machine runs it: Node 24 with V8 pointer
# compression, as the Mac runs it inside Electron, the host's production
# install from the checkout's lockfile, no Electron, and the tools the host
# itself starts. Built only from the directory scripts/linux-host/prepare.mjs
# writes, never the checkout.
FROM debian:bookworm-slim AS node
# Node publishes its pointer-compressed build from its unofficial-builds
# farm, for x64 only. Every native module the host loads is Node-API, which
# does not depend on V8's pointer size; each isolate's heap is capped at 4 GB.
ARG NODE_VERSION=24.22.3
ARG NODE_SHA256=384aa2ac9edc33519952f35fd82363382257602907234e2712b43588f4cdc8e8
# git for Threads' repositories and worktrees; ps and lsof for the process
# table and ports; curl for the harnesses' own installers.
RUN test "$(dpkg --print-architecture)" = amd64 || { echo "Mako's Linux host image is x64: Node builds pointer compression for x64 only" >&2; exit 1; } \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git lsof procps \
    && rm -rf /var/lib/apt/lists/* \
    && curl --retry 5 --retry-max-time 180 --connect-timeout 20 --max-time 120 -fsSLo /tmp/node.tar.gz "https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64-pointer-compression.tar.gz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner --exclude=CHANGELOG.md --exclude=README.md --exclude=LICENSE --exclude=include --exclude=share \
    && rm /tmp/node.tar.gz \
    && node -e 'if (!process.config.variables.v8_enable_pointer_compression) throw new Error("this Node lacks pointer compression")'

# Mako's video helper (native/video-linux): an X display or window captured when it
# changes and encoded with OpenH264, for computer use on a machine with a display.
# Debian's OpenH264, libyuv and libjpeg-turbo are BSD-style; nothing here is GPL.
FROM node AS video
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev pkg-config \
      libx11-dev libxext-dev libxdamage-dev libxfixes-dev libxcomposite-dev libopenh264-dev libyuv-dev libturbojpeg0-dev \
    && rm -rf /var/lib/apt/lists/*
COPY video/mako-video.c /build/
RUN gcc -O2 -Wall -Werror -o /build/mako-video /build/mako-video.c \
      $(pkg-config --cflags --libs x11 xext xdamage xfixes xcomposite openh264 libturbojpeg) -lyuv -lm

# The host's production install, built once: the host below runs it as it is,
# and a device's copy carries only what its harnesses need (keep-harnesses.mjs).
FROM node AS install
WORKDIR /opt/mako
COPY app/ ./
# The install keeps only what runs (scripts/linux-host/prune-install.mjs): no type declarations, source maps or
# TypeScript sources. npm's compile cache, which it keeps in /tmp, isn't the image's either.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace @mako/host --no-audit --no-fund \
    && node scripts/linux-host/prune-install.mjs /opt/mako && rm -rf /tmp/node-compile-cache \
    && if node -e 'require.resolve("electron")' 2>/dev/null; then echo "electron resolves in the host's install" >&2; exit 1; fi

FROM node AS system
# Chromium, the machine's own browser, which the host starts headless when an
# agent first connects to it; and fonts for the pages it renders. Its sandbox
# needs user namespaces: a VM gives them, Docker's default seccomp profile
# refuses them, so a container needs a profile that permits them.
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji \
      libopenh264-7 libyuv0 libturbojpeg0 libx11-6 libxext6 libxdamage1 libxfixes3 libxcomposite1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /bin/bash --create-home node \
    && ln -s /opt/mako/node_modules/@mako/host/dist/mako-host.js /usr/local/bin/mako-host
# The video helper, on PATH, where the host finds it: live video of the
# machine's display or windows, and recordings. No FFmpeg is installed.
COPY --from=video /build/mako-video /usr/local/bin/mako-video
# Harnesses install into the user's home, as on a person's machine.
ENV NPM_CONFIG_PREFIX=/home/node/.local PATH=/home/node/.local/bin:$PATH
# A cloud machine runs exactly the version Mako tested and installed: each
# harness's own updater stays off where its vendor has a switch (Claude
# Code's DISABLE_AUTOUPDATER, OpenCode's OPENCODE_DISABLE_AUTOUPDATE,
# Grok's GROK_DISABLE_AUTOUPDATER, which Mako's Grok launches set anyway).
# Codex's app-server and Cursor's SDK don't update themselves; Devin's switch
# is in its config, set below. Antigravity's CLI updates itself in place and
# has no switch Mako knows of, so a machine's copy can move past the tested
# build. A person's own Mac keeps its vendors' updates.
ENV DISABLE_AUTOUPDATER=1 OPENCODE_DISABLE_AUTOUPDATE=1 GROK_DISABLE_AUTOUPDATER=1
WORKDIR /home/node
ENTRYPOINT ["mako-host"]

# Mako's host as a Linux machine runs it, with every harness's payload the
# install carries. Root owns the host's code; the machine's user, who runs the
# host and its agents, can't change it.
FROM system AS host
COPY --from=install /opt/mako /opt/mako
RUN chmod 755 /opt/mako/packages/host/dist/mako-host.js && mako-host --help >/dev/null
USER node

# The host above with every harness it can install, installed by the host as
# Settings installs them (scripts/linux-host/install-harnesses.mjs): what a
# cloud machine runs. npm's download cache, as large as what it installs,
# stays out of the image, as do the builds for other machines a harness's
# npm package downloads and never runs, and what the installs leave in /tmp
# (install-harnesses.mjs). Only the two scripts the install runs are copied
# first, so a change to the proof doesn't install the harnesses again.
FROM host AS harnesses
COPY proof/host-process.mjs proof/install-harnesses.mjs proof/seed-harnesses.mjs /opt/mako/install/
# The builds Mako keeps of a harness whose vendor withdraws each one as it
# ships the next (Devin): laid out from the archives in the context, checked
# by their sha256, so the host finds the tested build instead of fetching it.
# Mounted, so the archives themselves stay out of the image.
RUN --mount=type=bind,source=harnesses,target=/opt/mako/harnesses node /opt/mako/install/seed-harnesses.mjs /opt/mako/harnesses
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 node /opt/mako/install/install-harnesses.mjs /home/node/harnesses.json
# Devin's CLI reads its updater's switch from its config, not its environment:
# without `auto_update: false`, a machine's first `devin acp` replaced the
# tested 3000.10.23 with the newest build within 40 s (2026-10-20). What its
# setup wrote there stays.
RUN node -e 'const fs = require("node:fs"); const file = "/home/node/.config/devin/config.json"; const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}; fs.mkdirSync("/home/node/.config/devin", { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...config, auto_update: false }, null, 2) + "\n")'

# Mako on a machine of the person's own, as a device of their account
# (docs/linux-device.md): the host above with the harnesses it's given,
# OpenCode unless HARNESSES names others (`none` for none), installed the same
# way, and no other harness's payload. It joins
# with a code its log shows (`mako-host join`), then runs as that device. Its
# data, its sign-in and the key that seals it (a 0600 file, as there's no
# keychain here) are on the volume at /data, so a new container of the image
# is the same device; arguments go to `mako-host join` (`--name <name>`).
# The install with only the payloads of the harnesses it's given: Claude
# Code's build, which the Agent SDK carries, only with `claude` among them
# (scripts/linux-host/keep-harnesses.mjs). Settings installs it later.
FROM install AS device-install
ARG HARNESSES=opencode
RUN node scripts/linux-host/keep-harnesses.mjs /opt/mako ${HARNESSES}

FROM system AS device
ARG HARNESSES=opencode
COPY --from=device-install /opt/mako /opt/mako
RUN chmod 755 /opt/mako/packages/host/dist/mako-host.js && mako-host --help >/dev/null
USER node
COPY proof/host-process.mjs proof/install-harnesses.mjs proof/seed-harnesses.mjs /opt/mako/install/
RUN --mount=type=bind,source=harnesses,target=/opt/mako/harnesses node /opt/mako/install/seed-harnesses.mjs /opt/mako/harnesses ${HARNESSES}
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 node /opt/mako/install/install-harnesses.mjs /home/node/harnesses.json ${HARNESSES}
USER root
RUN install -d -o node -g node -m 700 /data
USER node
ENV MAKO_PROD=1 MAKO_DATA_ROOT=/data
VOLUME /data
ENTRYPOINT ["/bin/sh", "-c", "mako-host join \"$@\" && exec mako-host", "mako-device"]

# The proof of item 1.1: those harnesses started by the host, and measured.
FROM harnesses AS proof
COPY proof/ /opt/mako/proof/
ENTRYPOINT ["node", "/opt/mako/proof/prove.mjs"]
CMD ["/evidence"]
