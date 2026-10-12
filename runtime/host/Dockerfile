# Mako's host as a Linux machine runs it: Node 24 with V8 pointer
# compression, as the Mac runs it inside Electron, the host's production
# install from the checkout's lockfile, no Electron, and the tools the host
# itself starts. Built only from the directory scripts/linux-host/prepare.mjs
# writes, never the checkout.
FROM debian:bookworm-slim AS host
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
    && node -e 'if (!process.config.variables.v8_enable_pointer_compression) throw new Error("this Node lacks pointer compression")' \
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
USER node
# Harnesses install into the user's home, as on a person's machine.
ENV NPM_CONFIG_PREFIX=/home/node/.local PATH=/home/node/.local/bin:$PATH
WORKDIR /home/node
ENTRYPOINT ["mako-host"]

# The proof of item 1.1: the host above with every harness it can install,
# installed by the host (scripts/linux-host/install-harnesses.mjs).
FROM host AS proof
COPY proof/ /opt/mako/proof/
RUN node /opt/mako/proof/install-harnesses.mjs /home/node/harnesses.json
ENTRYPOINT ["node", "/opt/mako/proof/prove.mjs"]
CMD ["/evidence"]
