/** Running hqsh and ssh in the foreground, with the user's terminal. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const INSTALL_URL = "https://hqterm.sh/install";

/** hqsh on PATH, else beside this binary, else ~/.local/bin. */
export function findHqsh(env = process.env): string | undefined {
  const onPath = Bun.which("hqsh", { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  for (const dir of [env.HQTERM_BIN, dirname(process.execPath), join(homedir(), ".local", "bin")]) {
    if (dir && existsSync(join(dir, "hqsh"))) return join(dir, "hqsh");
  }
  return undefined;
}

/** Run a command attached to this terminal; resolves with its exit code. */
export async function runInteractive(cmd: string[]): Promise<number> {
  process.stdin.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

export function connectArgs(hqsh: string, host: string, session?: string): string[] {
  return session ? [hqsh, host, "--session", session] : [hqsh, host];
}

/** The command that installs hqsh on a remote host. */
export function installArgs(host: string): string[] {
  return ["ssh", "-t", host, `curl -fsSL ${INSTALL_URL} | sh -s -- --server`];
}

/** Connect straight to a session. Prints a hint when hqsh is missing locally. */
export async function connect(host: string, session?: string): Promise<number> {
  const hqsh = findHqsh();
  if (!hqsh) {
    console.error(`hqterm: hqsh is not installed here. Install it with:\n  curl -fsSL ${INSTALL_URL} | sh`);
    return 127;
  }
  return runInteractive(connectArgs(hqsh, host, session));
}

/** Wait for Enter (cooked mode), so output stays readable before the TUI returns. */
export async function pressEnter(message = "Press Enter to return to hqterm."): Promise<void> {
  process.stdout.write(`\n${message}`);
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode?.(false);
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  process.stdin.pause();
}
