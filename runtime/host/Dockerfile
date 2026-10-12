# Mako's host as a Linux machine runs it: plain Node 24, the host's
# production install from the checkout's lockfile, no Electron, and the tools
# the host itself starts. Built only from the directory
# scripts/linux-host/prepare.mjs writes, never the checkout.
FROM node:24-bookworm-slim AS host
# git for Threads' repositories and worktrees; ps and lsof for the process
# table and ports; curl for the harnesses' own installers.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git lsof procps \
    && rm -rf /var/lib/apt/lists/*
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
