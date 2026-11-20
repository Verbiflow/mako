# Use only a prepared release directory as context, never the checkout.
FROM node:24-bookworm-slim AS dependencies
WORKDIR /opt/mako-control
# Install from the complete prepared packages: npm must see bin files when it
# creates executable links. A manifest-only install silently omits those links.
COPY . .
# The install keeps only what runs (prune-install.mjs, scripts/linux-host's): no type declarations, source maps or
# TypeScript sources, in this stage, so the runtime's own stages copy none of them.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
    && node prune-install.mjs . && rm prune-install.mjs \
    && test -x node_modules/.bin/mako-control

# Mako's video helper (native/video-linux/mako-video.c, which the release
# context carries as video/mako-video.c): recordings and live video, encoded
# with Debian's OpenH264 rather than FFmpeg.
FROM node:24-bookworm-slim AS video
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev pkg-config \
      libx11-dev libxext-dev libxdamage-dev libxfixes-dev libxcomposite-dev libopenh264-dev libyuv-dev libturbojpeg0-dev \
    && rm -rf /var/lib/apt/lists/*
COPY video/mako-video.c /build/
RUN gcc -O2 -Wall -Werror -o /build/mako-video /build/mako-video.c \
      $(pkg-config --cflags --libs x11 xext xdamage xfixes xcomposite openh264 libturbojpeg) -lyuv -lm

FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-noto-cjk fonts-noto-color-emoji \
      libopenh264-7 libyuv0 libturbojpeg0 libx11-6 libxext6 libxdamage1 libxfixes3 libxcomposite1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=video /build/mako-video /usr/local/bin/mako-video
WORKDIR /opt/mako-control
ENTRYPOINT ["node", "/opt/mako-control/node_modules/@mako/control-runtime/dist/cloud-control-main.js"]

FROM base AS browser-os
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

# The shared driver records a native window through an FFmpeg on PATH on Linux; Mako draws its pointer with it too.
FROM base AS native-os
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    libxkbcommon0 libx11-6 libxi6 libxtst6 libxext6 libssl3 libgtk-3-0 \
    dbus-x11 xvfb openbox xauth at-spi2-core \
    && rm -rf /var/lib/apt/lists/*

FROM native-os AS mixed-os
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

FROM browser-os AS browser
COPY --from=dependencies /opt/mako-control .
USER node

FROM native-os AS native
COPY --from=dependencies /opt/mako-control .
USER node

FROM mixed-os AS mixed
COPY --from=dependencies /opt/mako-control .
USER node

# Test-only GTK fixture dependencies do not enter any release target above.
FROM mixed AS acceptance
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3-gi gir1.2-gtk-3.0 x11-utils \
    && rm -rf /var/lib/apt/lists/*
USER node
