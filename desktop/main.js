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
    fontSize: Number.isFinite(c.fontSize) && c.fontSize >= 6 && c.fontSize <= 72 ? c.fontSize : 14,
    theme: c.theme && typeof c.theme === "object" ? c.theme : undefined,
    restore: c.restore !== false,
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
    return ["/bin/sh", ["-lc", 'exec hqsh "$0" --session "$1"', spec.host, session]];
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
    },
  });
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
  return { config, layout, open, version: VERSION, platform: process.platform };
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
  p.onData((data) => {
    if (!sender.isDestroyed()) sender.send("pty:data", id, data);
  });
  p.onExit(({ exitCode, signal }) => {
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
    if (process.env.HQTERM_DESKTOP_SMOKE) {
      // CI: prove the window and a PTY come up, then exit.
      setTimeout(() => {
        console.log(`hqterm-desktop smoke: ok (ptys=${ptys.size})`);
        app.exit(ptys.size > 0 ? 0 : 3);
      }, Number(process.env.HQTERM_DESKTOP_SMOKE) || 8000);
    }
  });
  app.on("window-all-closed", () => app.quit());
}
