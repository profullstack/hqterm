/**
 * `hqterm desktop`: find the hqterm desktop app (an Electron terminal that
 * shows hqtui/qc images and HD emoji) and launch it, detached.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validHostName } from "./hosts.ts";
import { INSTALL_URL } from "./run.ts";

export const DESKTOP_INSTALL = `curl -fsSL ${INSTALL_URL} | sh -s -- --desktop`;

export interface DesktopOpts {
  host?: string;
  session?: string;
}

export type ParsedDesktopArgs = { ok: true; opts: DesktopOpts } | { ok: false; error: string };

export const validSessionName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);

/** `[--host H] [--session S]`, also `--host=H`. A session without a host is an error. */
export function parseDesktopArgs(args: string[]): ParsedDesktopArgs {
  const opts: DesktopOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^--(host|session)(?:=(.*))?$/.exec(a);
    if (!m) return { ok: false, error: `unknown option ${a}` };
    const value = m[2] ?? args[++i];
    if (!value) return { ok: false, error: `--${m[1]} needs a value` };
    if (m[1] === "host") {
      if (!validHostName(value)) return { ok: false, error: `bad host name ${value}` };
      opts.host = value;
    } else {
      if (!validSessionName(value)) return { ok: false, error: `bad session name ${value}` };
      opts.session = value;
    }
  }
  if (opts.session && !opts.host) return { ok: false, error: "--session needs --host" };
  return { ok: true, opts };
}

/** Where the app may live, in the order we look. */
export function desktopCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string[] {
  const out: string[] = [];
  if (env.HQTERM_DESKTOP) out.push(env.HQTERM_DESKTOP);
  if (platform === "darwin") {
    out.push("/Applications/hqterm.app", join(home, "Applications", "hqterm.app"));
  } else {
    const opt = join(home, ".local", "opt", "hqterm-desktop");
    out.push(join(opt, "hqterm-desktop.AppImage"), join(opt, "hqterm-desktop"));
  }
  return out;
}

export function findDesktop(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  return desktopCandidates(env, platform, home).find((p) => exists(p));
}

/** The argv that launches the app at `path`. */
export function desktopLaunch(
  path: string,
  opts: DesktopOpts,
  platform = process.platform,
  hasFuse = true,
): string[] {
  const appArgs: string[] = [];
  if (opts.host) appArgs.push("--host", opts.host);
  if (opts.session) appArgs.push("--session", opts.session);
  if (platform === "darwin" && path.endsWith(".app")) return ["open", "-n", "-a", path, "--args", ...appArgs];
  const pre: string[] = [];
  // AppImages mount with FUSE; without it they can still unpack and run.
  if (path.endsWith(".AppImage") && !hasFuse) pre.push("--appimage-extract-and-run");
  // Chromium's setuid sandbox is not set up inside an AppImage.
  return [path, ...pre, ...(platform === "linux" ? ["--no-sandbox"] : []), ...appArgs];
}

export function hasDisplay(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  return platform !== "linux" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export async function desktop(args: string[]): Promise<number> {
  const parsed = parseDesktopArgs(args);
  if (!parsed.ok) {
    console.error(`hqterm desktop: ${parsed.error}\nusage: hqterm desktop [--host H] [--session S]`);
    return 2;
  }
  const path = findDesktop();
  if (!path) {
    console.error(`hqterm desktop: the desktop app is not installed. Install it with:\n  ${DESKTOP_INSTALL}`);
    return 127;
  }
  if (!hasDisplay()) {
    console.error("hqterm desktop: no display ($DISPLAY / $WAYLAND_DISPLAY unset). Run it from your desktop session.");
    return 2;
  }
  const hasFuse = Boolean(Bun.which("fusermount") || Bun.which("fusermount3"));
  const [cmd, ...rest] = desktopLaunch(path, parsed.opts, process.platform, hasFuse);
  const child = spawn(cmd!, rest, { detached: true, stdio: "ignore", env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" } });
  const failed = await new Promise<Error | undefined>((resolve) => {
    child.once("error", resolve);
    child.once("spawn", () => resolve(undefined));
  });
  if (failed) {
    console.error(`hqterm desktop: could not start ${path}: ${failed.message}`);
    return 1;
  }
  child.unref();
  console.log(`hqterm desktop: started ${path}${parsed.opts.host ? ` (${parsed.opts.host}${parsed.opts.session ? `/${parsed.opts.session}` : ""})` : ""}`);
  return 0;
}
