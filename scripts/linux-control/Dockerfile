FROM rust:1.93.1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    clang pkg-config libdbus-1-dev libxkbcommon-dev libx11-dev libxi-dev libxtst-dev libxext-dev \
    libgtk-3-dev libssl-dev dbus-x11 xvfb openbox xauth python3-gi python3-gi-cairo gir1.2-gtk-3.0 fonts-noto-cjk fonts-noto-color-emoji \
    chromium at-spi2-core xdotool ffmpeg ca-certificates curl && rm -rf /var/lib/apt/lists/*
# Node is supplied by its official distribution, not the host's macOS dependencies.
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
ENV CUA_DRIVER_RS_TELEMETRY_ENABLED=0 NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge
WORKDIR /driver
