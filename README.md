# hqterm

Persistent terminal sessions that survive disconnects, like mosh, but carrying
images and HD emoji. A session manager TUI built on
[hqtui](https://hqtui.com) and [hqsh](https://github.com/profullstack/hqsh).

```sh
curl -fsSL https://hqterm.sh/install | sh
```

Installs `hqterm` and `hqsh` for Linux or macOS (x86_64, arm64) into
`~/.local/bin` (or `$HQTERM_BIN`). On a server you connect to, only hqsh is
needed: `curl -fsSL https://hqterm.sh/install | sh -s -- --server` (the `i` key
in hqterm does it for you). That also runs `hqsh server setup`: sessions run as
systemd user units on Linux (lingering on, so they survive logout) and as
launchd jobs on macOS. Windows PCs and servers:
`irm https://hqterm.sh/install.ps1 | iex` (hqsh.exe, put on your user PATH;
sessions run on ConPTY).

When Tailscale is running, your online tailnet machines appear as hosts and
hqsh connects over the tailnet (`--tailscale auto|on|off`).

**Full documentation: https://hqterm.sh/docs** (`site/docs.html`).

## Use

```sh
hqterm                        # hosts (~/.ssh/config + ~/.config/hqterm/hosts.json) and their sessions
hqterm connect <host> [name]  # straight to hqsh
hqterm doctor [--try kitty|iterm]   # terminal facts + a test image
hqterm fonts install|status|remove  # OpenEmoji colour font
```

In the manager: Enter or one click attaches, `n` new session, `a` add host,
`i` install hqsh on the host, `r` refresh, `q` quit. Inside a session,
`Ctrl-^ .` detaches and returns to hqterm.

## Desktop app

`hqterm desktop [--host H] [--session S]` opens hqterm's own terminal window
(Electron + xterm.js): tabs, split panes, and hqtui/qc images and HD emoji drawn
via iTerm2 inline images and sixel, plus the OpenEmoji colour font, so it works
where Konsole and friends cannot. Every pane gets `TERM_PROGRAM=hqterm`,
`HQTUI_IMAGES=iterm` and `QC_HD=iterm`.

```sh
curl -fsSL https://hqterm.sh/install | sh -s -- --desktop
hqterm desktop
```

The installer puts the AppImage in `~/.local/opt/hqterm-desktop/` and adds a
launcher entry (`~/.local/share/applications/hqterm.desktop`). Where libfuse2
is missing (current Ubuntu/Kubuntu ship only fuse3) it unpacks the app once into
`~/.local/opt/hqterm-desktop/app/` and launches that instead. A plain install
does this too on Linux when `$DISPLAY` or `$WAYLAND_DISPLAY` is set;
`--no-desktop` skips it.

macOS and Windows builds are on every release too: `hqterm-desktop-macos-{arm64,x64}.{dmg,zip}`
(ad-hoc signed; the installer puts it in `~/Applications/hqterm.app` on a Mac
not reached over ssh) and `hqterm-desktop-windows-{x64,arm64}-setup.exe` / `.zip`
(per-user, no admin; `install.ps1` runs it silently unless
`$env:HQTERM_NO_DESKTOP` is set). Neither is notarized/code-signed yet, so the
first launch of a browser download needs right-click > Open (macOS) or
More info > Run anyway (SmartScreen). On macOS, Cmd+<key> does what
Ctrl+Shift+<key> does.

| Keys | |
| --- | --- |
| Ctrl+Shift+T / W | new tab / close tab; Ctrl+Tab, Ctrl+PgUp/PgDn switch |
| Ctrl+Shift+D / E | split right / split down |
| Ctrl+Shift+Arrows | move between panes (or one click); drag dividers to resize |
| Ctrl+Shift+X | close pane |
| Ctrl+Shift+C / V | copy / paste |
| Ctrl+= / Ctrl+- / Ctrl+0 | zoom |

The `+` button opens a shell, the hqterm session manager, or any host from
`~/.ssh/config` and `hosts.json` (as `hqsh <host> --session main`). Splitting a
remote pane opens a new session on the same host (`main-2`, ...).

The layout (tabs, splits, each remote pane's host and session) is saved to
`~/.config/hqterm/desktop-layout.json`, and the next launch reattaches every
remote pane to its hqsh session; local panes come back as fresh shells.
Settings: `~/.config/hqterm/desktop.json`, e.g.
`{"fontFamily": "JetBrains Mono", "fontSize": 16, "theme": {"background": "#000"}, "restore": true}`
(the default font size is 15).

Develop: `cd desktop && npm install && npm start` (needs bun and a C++
toolchain for node-pty); `npm run dist` builds the AppImage, `npm run dist:mac`
the macOS .dmg/.zip and `npm run dist:win` the Windows installer/.zip (each on
its own OS).

## Develop

```sh
bun install
bun test
bun src/main.ts
bun run build      # single binary in dist/
```

Releases: push a `v*` tag matching package.json; CI builds
`hqterm-{linux,darwin}-{amd64,arm64}`, `hqterm-desktop-linux-{x86_64,aarch64}.AppImage`,
`hqterm-desktop-macos-{arm64,x64}.{dmg,zip}`, `hqterm-desktop-windows-{x64,arm64}-setup.exe`,
`hqterm-desktop-windows-{x64,arm64}.zip` and `SHA256SUMS` (bump `desktop/package.json` too).

`site/index.html` is the hqterm.sh landing page and `site/docs.html` is
https://hqterm.sh/docs; `install.sh` is served at https://hqterm.sh/install and
`install.ps1` at https://hqterm.sh/install.ps1. Publish them with
`scripts/deploy-site.sh`, which bakes the pit.world network footer into every
page and rsyncs the lot to dev2's `/var/www/hqterm.sh`.

MIT.
