# Mako's host as a Linux machine runs it: Node 24 with V8 pointer
# compression, as the Mac runs it inside Electron, the host's production
# install from the checkout's lockfile, no Electron, and the tools the host
# itself starts. Built only from the directory scripts/linux-host/prepare.mjs
# writes, never the checkout.
FROM debian:bookworm-slim AS node
# Node publishes its pointer-compressed build from its unofficial-builds
# farm, for x64 only. Every native module the host loads is Node-API, which
# does not depend on V8's pointer size; each isolate's heap is capped at 4 GB.
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=cbb7d2d47c94e1e0ee82e0ebc3130664423258c3d36abf46ffaeea097ed85d30
# git for Threads' repositories and worktrees; ps and lsof for the process
# table and ports; curl for the harnesses' own installers.
RUN test "$(dpkg --print-architecture)" = amd64 || { echo "Mako's Linux host image is x64: Node builds pointer compression for x64 only" >&2; exit 1; } \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git lsof procps \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSLo /tmp/node.tar.gz "https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64-pointer-compression.tar.gz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner --exclude=CHANGELOG.md --exclude=README.md --exclude=LICENSE --exclude=include --exclude=share \
    && rm /tmp/node.tar.gz \
    && node -e 'if (!process.config.variables.v8_enable_pointer_compression) throw new Error("this Node lacks pointer compression")'

# FFmpeg as the Mac app bundles it (vendor/control-media): static, with x264
# and only what recordings and live video use, a few megabytes where Debian's
# package and its libraries are hundreds. Its sources and licenses go with it.
FROM node AS media
RUN apt-get update && apt-get install -y --no-install-recommends build-essential nasm pkg-config xz-utils zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
COPY media/ /build/
RUN node /build/scripts/build-control-media.mjs

FROM node AS host
# Chromium, the machine's own browser, which the host starts headless when an
# agent first connects to it; and fonts for the pages it renders. Its sandbox
# needs user namespaces: a VM gives them, Docker's default seccomp profile
# refuses them, so a container needs a profile that permits them.
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /bin/bash --create-home node
WORKDIR /opt/mako
# Root owns the host's code; the machine's user, who runs the host and its
# agents, can't change it.
COPY app/ ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace @mako/host --no-audit --no-fund \
    && ln -s /opt/mako/node_modules/@mako/host/dist/mako-host.js /usr/local/bin/mako-host \
    && chmod 755 /opt/mako/packages/host/dist/mako-host.js \
    && if node -e 'require.resolve("electron")' 2>/dev/null; then echo "electron resolves in the host's install" >&2; exit 1; fi \
    && mako-host --help >/dev/null
# Where the host looks for its media beside its install, as a checkout keeps it.
COPY --from=media /build/vendor/control-media/linux-x64/ /opt/mako/vendor/control-media/linux-x64/
USER node
# Harnesses install into the user's home, as on a person's machine.
ENV NPM_CONFIG_PREFIX=/home/node/.local PATH=/home/node/.local/bin:$PATH
# A cloud machine runs exactly the version Mako tested and installed: each
# harness's own updater stays off where its vendor has a switch (Claude
# Code's DISABLE_AUTOUPDATER, OpenCode's OPENCODE_DISABLE_AUTOUPDATE,
# Grok's GROK_DISABLE_AUTOUPDATER, which Mako's Grok launches set anyway).
# Codex's app-server and Cursor's SDK don't update themselves; Devin's CLI
# names no switch. A person's own Mac keeps its vendors' updates.
ENV DISABLE_AUTOUPDATER=1 OPENCODE_DISABLE_AUTOUPDATE=1 GROK_DISABLE_AUTOUPDATER=1
WORKDIR /home/node
ENTRYPOINT ["mako-host"]

# The host above with every harness it can install, installed by the host as
# Settings installs them (scripts/linux-host/install-harnesses.mjs): what a
# cloud machine runs. npm's download cache, as large as what it installs,
# stays out of the image. Only the two scripts the install runs are copied
# first, so a change to the proof doesn't install the harnesses again.
FROM host AS harnesses
COPY proof/host-process.mjs proof/install-harnesses.mjs /opt/mako/install/
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 node /opt/mako/install/install-harnesses.mjs /home/node/harnesses.json

# The proof of item 1.1: those harnesses started by the host, and measured.
FROM harnesses AS proof
COPY proof/ /opt/mako/proof/
ENTRYPOINT ["node", "/opt/mako/proof/prove.mjs"]
CMD ["/evidence"]
