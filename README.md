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

## Develop

```sh
bun install
bun test
bun src/main.ts
bun run build      # single binary in dist/
```

Releases: push a `v*` tag matching package.json; CI builds
`hqterm-{linux,darwin}-{amd64,arm64}` with `SHA256SUMS`.

`site/index.html` is the hqterm.sh landing page; `install.sh` is served at
https://hqterm.sh/install.

MIT.
