import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { desktopCandidates, desktopLaunch, findDesktop, hasDisplay, parseDesktopArgs } from "../src/desktop.ts";
import { globBasename } from "../src/sshconfig.ts";
import { main } from "../src/main.ts";

describe("hqterm desktop", () => {
  test("parses --host and --session", () => {
    expect(parseDesktopArgs([])).toEqual({ ok: true, opts: {} });
    expect(parseDesktopArgs(["--host", "dev2", "--session=work"])).toEqual({ ok: true, opts: { host: "dev2", session: "work" } });
    expect(parseDesktopArgs(["--session", "x"]).ok).toBe(false);
    expect(parseDesktopArgs(["--host"]).ok).toBe(false);
    expect(parseDesktopArgs(["--host", "-oProxyCommand=x"]).ok).toBe(false);
    expect(parseDesktopArgs(["--host", "dev2", "--session", "a;b"]).ok).toBe(false);
    expect(parseDesktopArgs(["dev2"]).ok).toBe(false);
  });

  test("looks in $HQTERM_DESKTOP, then the install dir (Linux) or /Applications (macOS)", () => {
    expect(desktopCandidates({}, "linux", "/h")).toEqual([
      "/h/.local/opt/hqterm-desktop/hqterm-desktop.AppImage",
      "/h/.local/opt/hqterm-desktop/hqterm-desktop",
    ]);
    expect(desktopCandidates({ HQTERM_DESKTOP: "/x/app" }, "linux", "/h")[0]).toBe("/x/app");
    expect(desktopCandidates({}, "darwin", "/h")).toEqual(["/Applications/hqterm.app", "/h/Applications/hqterm.app"]);
    const have = new Set(["/h/.local/opt/hqterm-desktop/hqterm-desktop"]);
    expect(findDesktop({}, "linux", "/h", (p) => have.has(p))).toBe("/h/.local/opt/hqterm-desktop/hqterm-desktop");
    expect(findDesktop({}, "linux", "/h", () => false)).toBeUndefined();
  });

  test("launch argv", () => {
    const app = "/h/.local/opt/hqterm-desktop/hqterm-desktop.AppImage";
    expect(desktopLaunch(app, {}, "linux", true)).toEqual([app, "--no-sandbox"]);
    expect(desktopLaunch(app, { host: "dev2", session: "w" }, "linux", false)).toEqual([
      app,
      "--appimage-extract-and-run",
      "--no-sandbox",
      "--host",
      "dev2",
      "--session",
      "w",
    ]);
    expect(desktopLaunch("/Applications/hqterm.app", { host: "dev2" }, "darwin")).toEqual([
      "open",
      "-n",
      "-a",
      "/Applications/hqterm.app",
      "--args",
      "--host",
      "dev2",
    ]);
  });

  test("display check", () => {
    expect(hasDisplay({}, "linux")).toBe(false);
    expect(hasDisplay({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
    expect(hasDisplay({}, "darwin")).toBe(true);
  });

  test("is a known command", async () => {
    const prev = process.env.HQTERM_DESKTOP;
    process.env.HQTERM_DESKTOP = "/nonexistent/hqterm-desktop";
    const home = process.env.HOME;
    process.env.HOME = "/nonexistent-home";
    try {
      // Not installed here: exits 127 with the install hint, not "unknown command" (2).
      expect(await main(["desktop"])).toBe(127);
      expect(await main(["desktop", "--bogus"])).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.HQTERM_DESKTOP;
      else process.env.HQTERM_DESKTOP = prev;
      process.env.HOME = home;
    }
  });
});

describe("ssh Include globs without Bun.Glob", () => {
  test("matches wildcards in the last segment", () => {
    const list = () => ["work", "work.conf", "home.conf", ".hidden.conf"];
    expect(globBasename("/h/.ssh/conf.d/*.conf", list)).toEqual(["/h/.ssh/conf.d/.hidden.conf", "/h/.ssh/conf.d/home.conf", "/h/.ssh/conf.d/work.conf"]);
    expect(globBasename("/h/.ssh/conf.d/w?rk", list)).toEqual(["/h/.ssh/conf.d/work"]);
    expect(globBasename("/h/*/x", list)).toEqual([]);
  });
});

describe("install.sh flags", () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawnSync(["sh", join(import.meta.dir, "..", "install.sh"), ...args], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/h", HQTERM_INSTALL_PARSE_ONLY: "1", ...env },
    });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
  };
  const linux = process.platform === "linux";

  test("defaults: desktop only on a Linux display", () => {
    expect(run([]).out).toBe("bin=/h/.local/bin server=0 desktop=0 auto=1");
    expect(run([], { DISPLAY: ":0" }).out).toBe(`bin=/h/.local/bin server=0 desktop=${linux ? 1 : 0} auto=1`);
    expect(run([], { WAYLAND_DISPLAY: "wayland-0" }).out).toBe(`bin=/h/.local/bin server=0 desktop=${linux ? 1 : 0} auto=1`);
  });

  test("--desktop, --no-desktop, --server, --bin", () => {
    expect(run(["--desktop"]).out).toBe("bin=/h/.local/bin server=0 desktop=1 auto=0");
    expect(run(["--no-desktop"], { DISPLAY: ":0" }).out).toBe("bin=/h/.local/bin server=0 desktop=0 auto=0");
    expect(run(["--server"], { DISPLAY: ":0" }).out).toBe("bin=/h/.local/bin server=1 desktop=0 auto=0");
    expect(run(["--bin=/opt/b"]).out).toBe("bin=/opt/b server=0 desktop=0 auto=1");
  });

  test("bad combinations fail", () => {
    expect(run(["--server", "--desktop"]).code).toBe(2);
    expect(run(["--nope"]).code).toBe(2);
  });
});
