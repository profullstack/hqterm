#!/usr/bin/env bun
/**
 * hqterm: a terminal session manager. Persistent hqsh sessions on your hosts,
 * picked from a full-screen list, with images and HD emoji where the terminal
 * can show them.
 */
import { emojiFontStatus, installEmojiFont, removeEmojiFont } from "@profullstack/hqtui";
import { desktop } from "./desktop.ts";
import { doctor } from "./doctor.ts";
import { update } from "./update.ts";
import { addUserHost, loadUserHosts, mergeHosts, validHostName } from "./hosts.ts";
import { connect, findHqsh, installArgs, INSTALL_URL, pressEnter, runInteractive, connectArgs } from "./run.ts";
import { sshConfigHosts } from "./sshconfig.ts";
import { tailscaleHosts } from "./tailscale.ts";
import { initialState, runTui } from "./tui.ts";
import { VERSION } from "./version.ts";

const HELP = `hqterm ${VERSION}: persistent terminal sessions that survive disconnects

Usage:
  hqterm                         full-screen session manager
  hqterm connect <host> [name]   attach to (or create) session <name> on <host> via hqsh
  hqterm desktop [--host H] [--session S]
                                 open the hqterm desktop app (tabs, split panes,
                                 images and HD emoji); optionally attached to H/S
  hqterm doctor [--try kitty|iterm]
                                 what this terminal supports, with a test image
  hqterm fonts install|status|remove
                                 the OpenEmoji colour font for this terminal
  hqterm update [--check] [--force]
                                 update hqterm, hqsh and the desktop app
  hqterm --version | --help

Keys in the manager:
  Enter / click   connect      n  new session   a  add host
  i               install hqsh on the host      r  refresh
  Tab / arrows    move         q  quit
  In a session:   Ctrl-^ .     detach (the session keeps running)

Hosts come from ~/.ssh/config, ~/.config/hqterm/hosts.json and, when
Tailscale runs here, your online tailnet machines (marked "ts";
HQTERM_TAILSCALE=off hides them).
Servers need only hqsh: curl -fsSL ${INSTALL_URL} | sh -s -- --server
  (Windows: irm https://hqterm.sh/install.ps1 | iex)
Install: curl -fsSL ${INSTALL_URL} | sh
Desktop app: curl -fsSL ${INSTALL_URL} | sh -s -- --desktop
`;

async function manager(): Promise<number> {
  const hosts = () => mergeHosts(sshConfigHosts(), loadUserHosts(), tailscaleHosts());
  const state = initialState(hosts());
  for (;;) {
    const action = await runTui(state, {
      onAddHost: (name) => {
        addUserHost(name);
        state.hosts = hosts();
      },
    });
    if (action.kind === "quit") return 0;
    if (action.kind === "connect") {
      const hqsh = findHqsh();
      if (!hqsh) {
        console.error(`hqsh is not installed here. Install it with:\n  curl -fsSL ${INSTALL_URL} | sh`);
        await pressEnter();
      } else {
        const code = await runInteractive(connectArgs(hqsh, action.host, action.session));
        if (code !== 0) await pressEnter(`hqsh exited with ${code}. Press Enter to return to hqterm.`);
        state.notice = code === 0 ? `Detached from ${action.session} on ${action.host}` : `hqsh exited with ${code}`;
      }
    } else if (action.kind === "install") {
      console.log(`Installing hqsh on ${action.host}…`);
      const code = await runInteractive(installArgs(action.host));
      await pressEnter(code === 0 ? "Done. Press Enter to return to hqterm." : `Install failed (exit ${code}). Press Enter to return.`);
      state.notice = code === 0 ? `hqsh installed on ${action.host}` : `install on ${action.host} failed (${code})`;
    }
    // Sessions may have changed while we were away.
    state.sessions.delete(action.host);
  }
}

async function fonts(sub: string | undefined): Promise<number> {
  if (sub === "install") {
    const r = await installEmojiFont({ log: (l) => console.log(l) });
    for (const f of r.installed) console.log(`installed ${f}`);
    if (r.fontconfig) console.log(`fontconfig: ${r.fontconfig}`);
    for (const n of r.notes) console.log(n);
    for (const s of r.snippets) console.log(`\n${s.terminal} (${s.file}):\n${s.snippet}`);
    console.log("\nRestart your terminal to pick up the font.");
    return 0;
  }
  if (sub === "status") {
    const s = await emojiFontStatus();
    console.log(`installed: ${s.installed ? "yes" : "no"}${s.files.length ? `  (${s.files.join(", ")})` : ""}`);
    console.log(`fontconfig rule: ${s.fontconfig ? "yes" : "no"}`);
    if (s.emojiFont) console.log(`emoji font in use: ${s.emojiFont}`);
    console.log(`active: ${s.active ? "yes" : "no"}`);
    return 0;
  }
  if (sub === "remove") {
    for (const line of await removeEmojiFont()) console.log(line);
    return 0;
  }
  console.error("usage: hqterm fonts install|status|remove");
  return 2;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        console.error("hqterm needs a terminal. Try `hqterm --help`.");
        return 2;
      }
      return manager();
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      return 0;
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "connect": {
      const [host, session] = rest;
      if (!host || !validHostName(host)) {
        console.error("usage: hqterm connect <host> [session]");
        return 2;
      }
      return connect(host, session);
    }
    case "desktop":
      return desktop(rest);
    case "doctor":
      return doctor(rest);
    case "fonts":
      return fonts(rest[0]);
    case "update":
    case "upgrade":
      return update(rest);
    default:
      console.error(`hqterm: unknown command "${cmd}"\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`hqterm: ${err?.message ?? err}`);
      process.exit(1);
    },
  );
}
