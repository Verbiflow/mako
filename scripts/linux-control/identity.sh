# Sourced by the acceptance start scripts. Runners pass the calling user's UID
# so evidence stays collectible, but that UID rarely exists in the image
# (GitHub-hosted runners use 1001, macOS 501) and D-Bus refuses to start for a
# user without a passwd entry. Give it one through nss_wrapper, for this
# container's processes only, instead of making /etc/passwd writable.
if ! id -un >/dev/null 2>&1; then
  { cat /etc/passwd; printf 'mako:x:%s:%s:Mako acceptance:%s:/bin/sh\n' "$(id -u)" "$(id -g)" "$HOME"; } >/tmp/mako-passwd
  { cat /etc/group; getent group "$(id -g)" >/dev/null || printf 'mako:x:%s:\n' "$(id -g)"; } >/tmp/mako-group
  export NSS_WRAPPER_PASSWD=/tmp/mako-passwd NSS_WRAPPER_GROUP=/tmp/mako-group
  export LD_PRELOAD="libnss_wrapper.so${LD_PRELOAD:+:$LD_PRELOAD}"
  id -un >/dev/null
fi
