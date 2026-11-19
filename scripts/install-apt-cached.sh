#!/usr/bin/env bash
# Installs Ubuntu packages from a folder of their .debs, exactly as Ubuntu ships them, which CI keeps between runs with
# actions/cache: once the folder holds them, an install needs no network at all. On 2026-11-19 the runners couldn't
# reach Ubuntu's mirrors and every gate shard that records hung on `apt-get update` until its install budget ran out.
#
#   scripts/install-apt-cached.sh <folder> <package>...
#
# Two tries, each under 135 s and 15 s apart, so both fit the gate's 300 s install budget. Each takes the first of
# these that works:
#   cache    the folder's .debs, installed with no network, when an earlier run left a complete set (`complete`);
#   apt      the runner's own mirror, from the lists the image has, then from refreshed lists;
#   archive  (the second try) Ubuntu's own archive in place of the runner's mirror.
# apt and archive download into the folder first, every network step bounded, and install from it with no network,
# so a slow mirror never stops dpkg halfway. After an install the folder keeps only the .debs installed, and
# `complete` marks it whole: CI saves the folder only then. The last line says which path installed them.
set -uo pipefail

if [ "${1-}" != --try ]; then
  [ $# -ge 2 ] || { echo "Use: $0 <folder> <package>..." >&2; exit 2; }
  for try in 1 2; do
    [ "$try" = 1 ] || { echo "install-apt-cached: try $((try - 1)) failed; trying again in 15 s"; sleep 15; }
    timeout -k 5 135 bash "${BASH_SOURCE[0]}" --try "$try" "$@" && exit 0
  done
  echo "install-apt-cached: no path installed $*"
  exit 1
fi

try=$2 dir=$3
shift 3
packages=("$@")
sudo=()
[ "$(id -u)" = 0 ] || sudo=(sudo)
shopt -s nullglob
# Where apt finds no sources but the ones named here: an empty list, and the archive's.
none=$(mktemp -d)
: >"$none/sources.list"
mkdir "$none/parts"
chmod -R a+rX "$none"
trap 'rm -rf "$none"' EXIT
apt=(env DEBIAN_FRONTEND=noninteractive apt-get -y -qq --no-install-recommends)
net=(-o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)
into=(-o "Dir::Cache::archives=$dir")
mkdir -p "$dir" 2>/dev/null || "${sudo[@]}" mkdir -p "$dir"

# A package installed at any version, given as name or name:arch.
installed() { dpkg-query -W -f='${Status}\n' "$1" 2>/dev/null | grep -q ' installed$'; }
deb_name() {
  local arch
  arch=$(dpkg-deb -f "$1" Architecture)
  if [ "$arch" = all ]; then dpkg-deb -f "$1" Package; else echo "$(dpkg-deb -f "$1" Package):$arch"; fi
}
all_installed() {
  local p
  for p in "${packages[@]}"; do installed "$p" || return 1; done
}

# The folder's .debs of packages the image doesn't have, installed without the network. A package the image already
# has at another version is left as it is; if the rest then don't fit, apt says so and changes nothing.
from_cache() {
  [ -f "$dir/complete" ] || return 1
  local files=() f
  for f in "$dir"/*.deb; do installed "$(deb_name "$f")" || files+=("$f"); done
  [ ${#files[@]} -gt 0 ] || return 1
  # No sources: apt reads neither the image's lists nor the network, only these files and what's installed. (Not
  # `--no-download`, which apt 2.8 refuses with local files: "Pathname to install is not absolute".)
  "${sudo[@]}" "${apt[@]}" -o "Dir::Etc::sourcelist=$none/sources.list" -o "Dir::Etc::sourceparts=$none/parts" install "${files[@]}"
}

from_network() {
  # The first try's source may have spent 25 s on the image's lists already.
  local source=$1 lists=() download=60
  [ "$source" = apt ] || download=70
  if [ "$source" = archive ]; then
    local codename mirror=http://archive.ubuntu.com/ubuntu
    codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
    case $(dpkg --print-architecture) in amd64 | i386) ;; *) mirror=http://ports.ubuntu.com/ubuntu-ports ;; esac
    printf "deb $mirror %s main universe\n" "$codename" "$codename-updates" "$codename-security" >"$none/archive.list"
    lists=(-o "Dir::Etc::sourcelist=$none/archive.list" -o "Dir::Etc::sourceparts=$none/parts")
  fi
  {
    [ "$source" = apt ] && "${sudo[@]}" timeout 25 "${apt[@]}" "${net[@]}" "${into[@]}" --download-only install "${packages[@]}"
  } || {
    "${sudo[@]}" timeout 35 apt-get -qq "${net[@]}" "${lists[@]}" update &&
      "${sudo[@]}" timeout "$download" "${apt[@]}" "${net[@]}" "${lists[@]}" "${into[@]}" --download-only install "${packages[@]}"
  } || return 1
  "${sudo[@]}" "${apt[@]}" "${lists[@]}" "${into[@]}" --no-download install "${packages[@]}"
}

# The folder as CI saves it: only the .debs now installed, each at the version installed, readable by the runner's user.
keep() {
  local f name
  "${sudo[@]}" rm -rf "$dir/partial" "$dir/lock" "$dir/complete"
  for f in "$dir"/*.deb; do
    name=$(deb_name "$f")
    [ "$(dpkg-query -W -f='${Version}' "$name" 2>/dev/null)" = "$(dpkg-deb -f "$f" Version)" ] || "${sudo[@]}" rm -f "$f"
  done
  "${sudo[@]}" chown -R "$(id -u):$(id -g)" "$dir"
  set -- "$dir"/*.deb
  [ $# -gt 0 ] && printf '%s\n' "${packages[@]}" >"$dir/complete"
  echo "install-apt-cached: $dir holds $# .debs"
}

if all_installed; then
  echo "install-via: image"
  exit 0
fi
# A try cut off mid-install leaves dpkg to finish its configuration first.
[ "$try" = 1 ] || "${sudo[@]}" timeout 60 dpkg --configure -a
if from_cache; then via=cache
elif [ "$try" = 1 ] && from_network apt; then via=apt
elif [ "$try" != 1 ] && from_network archive; then via=archive
else exit 1
fi
all_installed || exit 1
keep
echo "install-via: $via"
