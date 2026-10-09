// hqterm desktop: Electron main process. Owns the PTYs, the config and the
// saved layout; the renderer (src/app.js) draws tabs and panes with xterm.js.
"use strict";
const { app, BrowserWindow, clipboard, ipcMain, Menu, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Chromium's setuid sandbox is not configured inside an AppImage.
if (process.platform === "linux") app.commandLine.appendSwitch("no-sandbox");
app.setName("hqterm");

// Speed: xterm 6 draws fast only through WebGL, so the GPU has to be on.
// Chromium blocklists many Linux GPU/driver combinations and then every pane
// falls back to the DOM renderer, where redraws and resizes crawl. Opt out of
// the blocklist and run natively on Wayland.
// `"gpu": false` in ~/.config/hqterm/desktop.json turns all of this off.
const GPU_OFF = (() => {
  try {
    const p = require("node:path").join(process.env.XDG_CONFIG_HOME || require("node:path").join(require("node:os").homedir(), ".config"), "hqterm", "desktop.json");
    return JSON.parse(require("node:fs").readFileSync(p, "utf8")).gpu === false;
  } catch {
    return false;
  }
})();
if (GPU_OFF) {
  app.disableHardwareAcceleration();
} else {
  // Only the blocklist: forcing GPU rasterization/zero-copy breaks the
  // compositor where there is no real GPU (UnknownVizError under Xvfb).
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  if (process.platform === "linux" && (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland")) {
    app.commandLine.appendSwitch("ozone-platform-hint", "auto");
    app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");
  }
}

const VERSION = require("./package.json").version;
const HOST_RE = /^[A-Za-z0-9._@:\-\[\]]+$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hqterm");
const configFile = () => path.join(configDir(), "desktop.json");
const layoutFile = () => path.join(configDir(), "desktop-layout.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function loadConfig() {
  const c = readJson(configFile()) || {};
  return {
    fontFamily: typeof c.fontFamily === "string" && c.fontFamily.trim() ? c.fontFamily : "monospace",
    fontSize: Number.isFinite(c.fontSize) && c.fontSize >= 6 && c.fontSize <= 72 ? c.fontSize : 15,
    theme: c.theme && typeof c.theme === "object" ? c.theme : undefined,
    restore: c.restore !== false,
    gpu: c.gpu !== false,
  };
}

/** `--host H --session S` (or --host=H) anywhere in argv. */
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(host|session)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    const v = m[2] !== undefined ? m[2] : argv[++i];
    if (m[1] === "host" && v && HOST_RE.test(v) && !v.startsWith("-")) out.host = v;
    if (m[1] === "session" && v && SESSION_RE.test(v)) out.session = v;
  }
  return out.host ? { kind: "remote", host: out.host, session: out.session || "main" } : undefined;
}

let hostsModule;
function listHosts() {
  try {
    hostsModule = hostsModule || require("./lib/hosts.cjs");
    return hostsModule.listHosts();
  } catch (err) {
    console.error("hqterm: host list unavailable:", err && err.message);
    return [];
  }
}

function loginShell() {
  let sh = process.env.SHELL;
  if (!sh) {
    try {
      sh = os.userInfo().shell;
    } catch {}
  }
  return sh && fs.existsSync(sh) ? sh : "/bin/sh";
}

/** The environment every pane starts with. */
function paneEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("ELECTRON_") || k.startsWith("CHROME_")) delete env[k];
  // AppImage runtime variables would leak into every child.
  for (const k of ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "NO_AT_BRIDGE"]) delete env[k];
  if (env.LD_LIBRARY_PATH && process.env.APPDIR && env.LD_LIBRARY_PATH.includes(process.env.APPDIR)) delete env.LD_LIBRARY_PATH;
  const localBin = path.join(os.homedir(), ".local", "bin");
  const parts = (env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":");
  if (!parts.includes(localBin)) env.PATH = [localBin, ...parts].join(":");
  Object.assign(env, {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "hqterm",
    TERM_PROGRAM_VERSION: VERSION,
    HQTUI_IMAGES: "iterm",
    QC_HD: "iterm",
    // The one hint that crosses ssh (SendEnv/AcceptEnv LC_*): iTerm2 inline images work here.
    LC_TERMINAL: "iTerm2",
  });
  return env;
}

function startDir() {
  const owd = process.env.OWD;
  if (owd && owd !== "/" && fs.existsSync(owd)) return owd;
  const cwd = process.cwd();
  return cwd && cwd !== "/" ? cwd : os.homedir();
}

/** [file, args] for a pane spec; host and session are checked before they reach a shell. */
function command(spec) {
  if (spec && spec.kind === "remote" && HOST_RE.test(spec.host || "") && !spec.host.startsWith("-")) {
    const session = SESSION_RE.test(spec.session || "") ? spec.session : "main";
    // hqsh forwards only TERM. sshd accepts LC_* by default (AcceptEnv LANG LC_*),
    // a new session's shell inherits it, and hqtui reads LC_TERMINAL=iTerm2 as
    // "draw iTerm2 inline images": so remote hqtui/qc draw HD images here too.
    return ["/bin/sh", ["-lc", 'exec hqsh "$0" --session "$1" -- -o SetEnv=LC_TERMINAL=iTerm2', spec.host, session]];
  }
  if (spec && spec.kind === "hqterm") return ["/bin/sh", ["-lc", "exec hqterm"]];
  return [loginShell(), ["-l"]];
}

let pty;
const ptys = new Map();
let nextPty = 1;
let win;
let pendingSpec = parseArgv(process.argv.slice(1));

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: "#0f1115",
    title: "hqterm",
    icon: path.join(__dirname, "src", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The smoke test runs without a window manager, where an unfocused window stops painting.
      backgroundThrottling: !process.env.HQTERM_DESKTOP_SMOKE,
    },
  });
  if (process.env.HQTERM_DESKTOP_SMOKE) {
    win.webContents.on("console-message", (e) => console.log(`renderer ${e.level}: ${e.message}`));
  }
  win.loadFile(path.join(__dirname, "src", "index.html"));
  // Nothing navigates away from the terminal; links open in the browser.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    win = undefined;
    for (const p of ptys.values()) {
      try {
        p.kill();
      } catch {}
    }
    ptys.clear();
  });
}

ipcMain.handle("app:init", () => {
  const config = loadConfig();
  const layout = config.restore ? readJson(layoutFile()) : undefined;
  const open = pendingSpec;
  pendingSpec = undefined;
  return { config, layout, open, version: VERSION, platform: process.platform, smoke: !!process.env.HQTERM_DESKTOP_SMOKE };
});

ipcMain.handle("hosts:list", () => listHosts());

ipcMain.handle("layout:save", (_e, data) => {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    const tmp = `${layoutFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, layoutFile());
    return true;
  } catch (err) {
    console.error("hqterm: could not save layout:", err && err.message);
    return false;
  }
});

ipcMain.handle("pty:spawn", (e, { spec, cols, rows }) => {
  pty = pty || require("node-pty");
  const [file, args] = command(spec);
  const id = nextPty++;
  const p = pty.spawn(file, args, {
    name: "xterm-256color",
    cols: Math.max(2, cols | 0) || 80,
    rows: Math.max(2, rows | 0) || 24,
    cwd: spec && spec.kind === "shell" ? startDir() : os.homedir(),
    env: paneEnv(),
  });
  ptys.set(id, p);
  const sender = e.sender;
  // Coalesce output: one IPC message per pane every few ms, not one per read.
  // A full-screen redraw arrives as dozens of small reads; sent one by one
  // they each cost a renderer task and a partial repaint you can watch.
  let pending = "";
  let timer = null;
  const flush = () => {
    timer = null;
    if (pending && !sender.isDestroyed()) sender.send("pty:data", id, pending);
    pending = "";
  };
  p.onData((data) => {
    pending += data;
    if (pending.length >= 256 * 1024) {
      if (timer) clearTimeout(timer);
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, 4);
    }
  });
  p.onExit(({ exitCode, signal }) => {
    if (timer) clearTimeout(timer);
    flush();
    ptys.delete(id);
    if (!sender.isDestroyed()) sender.send("pty:exit", id, exitCode, signal);
  });
  return id;
});

ipcMain.on("pty:write", (_e, id, data) => {
  const p = ptys.get(id);
  if (p && typeof data === "string") p.write(data);
});

ipcMain.on("pty:resize", (_e, id, cols, rows) => {
  const p = ptys.get(id);
  if (p && cols > 1 && rows > 1) {
    try {
      p.resize(cols | 0, rows | 0);
    } catch {}
  }
});

ipcMain.on("pty:kill", (_e, id) => {
  const p = ptys.get(id);
  if (p) {
    ptys.delete(id);
    try {
      p.kill();
    } catch {}
  }
});

ipcMain.handle("clipboard:read", () => clipboard.readText());
ipcMain.on("clipboard:write", (_e, text) => {
  if (typeof text === "string") clipboard.writeText(text);
});
// PRIMARY selection exists only on Linux (X11/Wayland); a no-op elsewhere.
ipcMain.on("selection:write", (_e, text) => {
  if (typeof text === "string" && process.platform === "linux") clipboard.writeText(text, "selection");
});
ipcMain.on("open:url", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
});

if (!app.requestSingleInstanceLock()) {
  // An hqterm window is already open: it gets our --host/--session.
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const spec = parseArgv(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      win.webContents.send("app:open", spec || { kind: "shell" });
    }
  });
  app.whenReady().then(() => {
    // No menu: Ctrl+W, Ctrl+R and friends belong to the shell.
    Menu.setApplicationMenu(null);
    createWindow();
    // What the GPU is doing, for "why is it slow": ~/.config/hqterm/desktop.log.
    try {
      fs.mkdirSync(configDir(), { recursive: true });
      const st = app.getGPUFeatureStatus();
      fs.writeFileSync(
        path.join(configDir(), "desktop.log"),
        `${new Date().toISOString()} hqterm desktop ${VERSION}\n` +
          `gpu: ${GPU_OFF ? "off (desktop.json)" : "on"}; webgl=${st.webgl} webgl2=${st.webgl2} rasterization=${st.gpu_compositing}/${st.rasterization}\n` +
          `session: ${process.env.XDG_SESSION_TYPE || "?"} wayland=${process.env.WAYLAND_DISPLAY ? "yes" : "no"}\n`,
      );
    } catch {}
    if (process.env.HQTERM_DESKTOP_SMOKE) {
      // CI: prove the window and a PTY come up, draw emoji and an iTerm2
      // inline image, optionally screenshot it ($HQTERM_DESKTOP_SMOKE_SHOT), exit.
      const wait = Number(process.env.HQTERM_DESKTOP_SMOKE) || 8000;
      setTimeout(() => {
        const [id, p] = [...ptys.entries()][0] || [];
        if (!p || !win) return;
        p.write("printf '\\033[2J\\033[Hhqterm smoke: emoji \\360\\237\\230\\200 \\360\\237\\226\\245\\357\\270\\217 \\342\\234\\205 wide|\\n'\r");
        // The same escape hqtui emits (emoji art: 2 cells; then a bigger one).
        const png = fs.readFileSync(path.join(__dirname, "src", "icon.png"));
        const iip = (w, h) => `\x1b]1337;File=inline=1;size=${png.length};width=${w};height=${h};preserveAspectRatio=1:${png.toString("base64")}\x07`;
        setTimeout(() => {
          if (win) win.webContents.send("pty:data", id, `\r\nemoji art: ${iip(2, 1)} | image:\r\n${iip(12, 6)}\r\nafter image\r\n`);
        }, 1000);
      }, wait / 2);
      // Split right with the real key binding: one more pane, one more PTY.
      setTimeout(() => {
        if (!win) return;
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "D", modifiers: ["control", "shift"] });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "D", modifiers: ["control", "shift"] });
      }, wait * 0.7);
      // Shift+drag must leave a selection that survives the mouse moving on,
      // even when the app tracks every motion (hqtui hover, DECSET 1003).
      // The escape goes straight to the focused pane's terminal (no shell to
      // wait for); poll, since on a slow runner the split pane comes up late.
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      let selection = "not run";
      const selectionTest = new Promise((done) => setTimeout(done, wait * 0.75)).then(async () => {
        try {
          let r;
          for (let i = 0; i < 40 && win; i++) {
            r = await win.webContents.executeJavaScript(`(() => {
              const b = document.querySelector(".pane.focused .xterm-screen").getBoundingClientRect();
              return { x: Math.round(b.left + 4), y: Math.round(b.top + 6), ...window.hqSmoke.state() };
            })()`);
            if (r.mode === "any") break;
            if (r.ptyId !== undefined) win.webContents.send("pty:data", r.ptyId, "\x1b[H\x1b[2Kselect me please\x1b[?1003h");
            await sleep(150);
          }
          if (!win || !r) return;
          const send = (type, x, modifiers) => win.webContents.sendInputEvent({ type, x, y: r.y, button: "left", clickCount: 1, modifiers });
          send("mouseDown", r.x, ["shift"]);
          for (let x = r.x; x <= r.x + 80; x += 10) send("mouseMove", x, ["shift", "leftButtonDown"]);
          send("mouseUp", r.x + 80, ["shift"]);
          await sleep(100);
          for (let x = r.x + 80; x <= r.x + 140; x += 10) win.webContents.sendInputEvent({ type: "mouseMove", x, y: r.y + 20 });
          await sleep(300);
          const sel = await win.webContents.executeJavaScript("window.hqSmoke.state().selection");
          selection = r.mode !== "any" ? `mouse mode ${r.mode}, not any` : sel ? "" : "cleared after release";
        } catch (err) {
          selection = `error: ${err && err.message}`;
        }
      });
      setTimeout(async () => {
        await selectionTest;
        const shot = process.env.HQTERM_DESKTOP_SMOKE_SHOT;
        if (shot && win) {
          try {
            fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
            console.log(`hqterm-desktop smoke: screenshot ${shot}`);
          } catch (err) {
            console.log(`hqterm-desktop smoke: screenshot failed: ${err && err.message}`);
          }
        }
        // Every pane's rows must fit inside the pane: a fit that ignores the
        // pane's padding cuts the last row off at the bottom.
        let clipped = [];
        try {
          clipped = win
            ? await win.webContents.executeJavaScript(`[...document.querySelectorAll(".pane")].flatMap((p) => {
                const s = p.querySelector(".xterm-screen");
                if (!s) return [];
                const a = p.getBoundingClientRect(), b = s.getBoundingClientRect();
                return b.bottom > a.bottom + 0.5 || b.right > a.right + 0.5
                  ? [\`screen \${Math.round(b.width)}x\${Math.round(b.height)} in pane \${Math.round(a.width)}x\${Math.round(a.height)}\`]
                  : [];
              })`)
            : [];
        } catch {}
        if (clipped.length) {
          console.log(`hqterm-desktop smoke: clipped: ${clipped.join("; ")}`);
          return app.exit(4);
        }
        if (selection) {
          console.log(`hqterm-desktop smoke: selection: ${selection}`);
          return app.exit(5);
        }
        console.log(`hqterm-desktop smoke: ok (ptys=${ptys.size})`);
        app.exit(ptys.size > 0 ? 0 : 3);
      }, wait);
    }
  });
  app.on("window-all-closed", () => app.quit());
}
