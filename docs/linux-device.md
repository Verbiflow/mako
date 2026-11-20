# Running Mako on your own Linux machine

A Linux machine you run, such as a server, a spare desktop or a container,
can join your Mako account as a device. Your other devices then see it in the
account's device list, watch and steer its Sessions, and start Threads there,
the same way they reach a Mac. Mako's host runs there with no window and no
browser: it signs in with a code you confirm on a device that is already
signed in.

## Join with a code

```sh
mako-host join --cloud https://api.runmako.co
```

It prints a page and a code:

```
To add this machine to your Mako account, open this page on a device that's signed in:

  https://api.runmako.co/device?code=BCDF-GHJK

and confirm the code BCDF-GHJK there (or go to https://api.runmako.co/device and type it in). It expires in 10 minutes.

Waiting for the code to be confirmed…
```

Settings › Devices › Add a machine, in the app and on the web, shows these
lines with your account's cloud filled in, and says so when the machine joins.

Open the page anywhere you're signed in to Mako, check the code matches, and
approve. The machine is named by its hostname; `--name <name>` names it
otherwise. Once joined, `mako-host` runs as that device, against the same
cloud, with nothing more to set:

```sh
mako-host          # the host, as this device
mako-host status   # the device, its account, and whether its links are connected; takes no lock, so it's safe while the host starts
mako-host leave    # sign out, and remove the device from the account
```

`status` and `leave` ask the running host when there is one, and otherwise act
on the sign-in themselves. `join` needs the host stopped.

## Where the sign-in is kept

The device's credential is sealed in Mako's secret store under a data key. A
Mac keeps that key in its keychain. Linux has no such keychain, so the key is
a file of its own, `~/.mako/secrets/host-key` (or `MAKO_SECRET_KEY_FILE`),
mode 0600, made the first time it's needed. Whoever can read that file can
open the store, as with an SSH host key: keep it on a disk only you can read.
Signing out with `mako-host leave`, or removing the device from any other
device, ends the credential in the cloud at once.

## In a container

The image is the host's Linux image with OpenCode installed (`HARNESSES`
names others, such as `HARNESSES="opencode codex"`). Build it from a checkout:

```sh
npm ci && npm run build:control-runtime
node scripts/linux-host/prepare.mjs --output /tmp/mako-device-context
docker build --platform linux/amd64 -f runtime/host/Dockerfile --target device -t mako-device /tmp/mako-device-context
```

Run it with a volume for its data, which holds its sign-in and its key, so a
new container of the image is the same device:

```sh
docker run -d --init --name mako-device -v mako-device:/data \
  -e MAKO_CLOUD_URL=https://api.runmako.co mako-device --name build-box
docker logs -f mako-device      # shows the page and code to confirm
docker exec mako-device mako-host status
```

On its first start the container joins and then runs the host; after that it
starts as the device it joined as. A code that runs out before it's confirmed
ends the join, and the container stops and keeps its name, so `docker run`
can't run again; `docker start mako-device` starts it with a new code, which
`docker logs` shows. The image is x64: Node's pointer-compressed
build, which the host runs on, is published for x64 only.

## As a service

`runtime/host/mako-host.service` runs the host as a systemd user service.
Join first, as the same user, then:

```sh
cp runtime/host/mako-host.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mako-host
loginctl enable-linger "$USER"
```

The unit expects `mako-host` on its `PATH`: from a built checkout,
`ln -s "$PWD/packages/host/dist/mako-host.js" ~/.local/bin/mako-host`.

## Harnesses

Each harness signs in on the machine as it does on a Mac: through the
harness's own login, or a key in the environment it reads (such as
`ANTHROPIC_API_KEY` for OpenCode's Anthropic models). In a container, pass
keys with `-e` or an env file.
