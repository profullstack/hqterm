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
in hqterm does it for you).

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
toolchain for node-pty); `npm run dist` builds the AppImage.

## Develop

```sh
bun install
bun test
bun src/main.ts
bun run build      # single binary in dist/
```

Releases: push a `v*` tag matching package.json; CI builds
`hqterm-{linux,darwin}-{amd64,arm64}`, `hqterm-desktop-linux-{x86_64,aarch64}.AppImage`
and `SHA256SUMS` (bump `desktop/package.json` too).

`site/index.html` is the hqterm.sh landing page; `install.sh` is served at
https://hqterm.sh/install.

MIT.
