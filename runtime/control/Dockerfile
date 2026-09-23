# Use only a prepared release directory as context, never the checkout.
FROM node:24-bookworm-slim AS dependencies
WORKDIR /opt/mako-control
COPY package.json package-lock.json ./
COPY packages/control/package.json packages/control/package.json
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mako-control
ENTRYPOINT ["node", "/opt/mako-control/dist-electron/cloud-control-main.js"]

FROM base AS browser-os
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

FROM base AS native-os
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxkbcommon0 libx11-6 libxi6 libxtst6 libxext6 libssl3 libgtk-3-0 \
    dbus-x11 xvfb openbox xauth at-spi2-core \
    && rm -rf /var/lib/apt/lists/*

FROM native-os AS mixed-os
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

FROM browser-os AS browser
COPY --from=dependencies /opt/mako-control/node_modules ./node_modules
COPY . .
USER node

FROM native-os AS native
COPY --from=dependencies /opt/mako-control/node_modules ./node_modules
COPY . .
USER node

FROM mixed-os AS mixed
COPY --from=dependencies /opt/mako-control/node_modules ./node_modules
COPY . .
USER node

# Test-only GTK fixture dependencies do not enter any release target above.
FROM mixed AS acceptance
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3-gi gir1.2-gtk-3.0 x11-utils \
    && rm -rf /var/lib/apt/lists/*
USER node
