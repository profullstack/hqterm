/**
 * A host's hqsh sessions, asked over ssh:
 *   ssh -o BatchMode=yes -o ConnectTimeout=5 <host> hqsh server list --json
 * which prints [{"name": "main", "attached": true}, ...].
 */

export interface Session {
  name: string;
  attached: boolean;
}

export type SessionResult =
  | { status: "ok"; sessions: Session[] }
  | { status: "missing" } // hqsh is not installed on the host
  | { status: "error"; message: string };

/** Parse `hqsh server list --json`. Tolerates noise before the JSON (motd, rc output). */
export function parseSessionList(stdout: string): Session[] | undefined {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end < start) return stdout.trim() === "" || stdout.trim() === "null" ? [] : undefined;
  let data: unknown;
  try {
    data = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const out: Session[] = [];
  for (const item of data) {
    if (typeof item === "string") out.push({ name: item, attached: false });
    else if (item && typeof item === "object" && typeof (item as Session).name === "string") {
      out.push({ name: (item as Session).name, attached: Boolean((item as Session).attached) });
    }
  }
  return out;
}

/** Turn an ssh run into a result. Exit 127 / "not found" means no hqsh there. */
export function classify(code: number, stdout: string, stderr: string): SessionResult {
  if (code === 0) {
    const sessions = parseSessionList(stdout);
    return sessions ? { status: "ok", sessions } : { status: "error", message: "hqsh gave output hqterm cannot read (update hqsh?)" };
  }
  if (code === 127 || /hqsh: (command )?not found|command not found: hqsh|hqsh: No such file/i.test(stderr)) return { status: "missing" };
  const line = stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? `ssh exited ${code}`;
  return { status: "error", message: line };
}

/**
 * The remote command. A non-interactive ssh shell often lacks ~/.local/bin
 * (where the installer puts hqsh) on PATH, so it is added explicitly.
 */
export const REMOTE_LIST = 'env PATH="$HOME/.local/bin:$PATH" hqsh server list --json';

export function listArgs(host: string): string[] {
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, REMOTE_LIST];
}

export async function fetchSessions(host: string, timeoutMs = 15000): Promise<SessionResult> {
  try {
    const proc = Bun.spawn(listArgs(host), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return classify(code, stdout, stderr);
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }
}

/** Session names hqsh accepts: letters, digits, dot, dash, underscore. */
export const validSessionName = (name: string) => /^[A-Za-z0-9._-]{1,64}$/.test(name);
