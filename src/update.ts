/**
 * `hqterm update`: fetch the current installer from hqterm.sh and run it, so
 * hqterm, hqsh (and the desktop app, when it is installed) move to the latest
 * releases. `hqterm update --check` only reports whether one is waiting.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findDesktop } from "./desktop.ts";
import { INSTALL_URL, runInteractive } from "./run.ts";
import { VERSION } from "./version.ts";

export const RELEASES_API = "https://api.github.com/repos/profullstack/hqterm/releases/latest";

/** -1, 0 or 1 comparing dotted versions ("0.2.10" > "0.2.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The installer's arguments for this machine: same bin dir, desktop app if installed. */
export function installerArgs(execPath: string, hasDesktop: boolean, extra: string[] = []): string[] {
  const args: string[] = [];
  // A compiled binary updates in place; under `bun src/main.ts` use the default dir.
  if (!/\bbun(\.exe)?$/.test(execPath)) args.push(`--bin=${dirname(execPath)}`);
  if (hasDesktop) args.push("--desktop");
  return [...args, ...extra];
}

export async function latestVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(RELEASES_API, { headers: { Accept: "application/vnd.github+json", "User-Agent": "hqterm" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string };
    return body.tag_name ? body.tag_name.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

export async function update(args: string[]): Promise<number> {
  const check = args.includes("--check");
  const latest = await latestVersion();
  if (check) {
    if (!latest) {
      console.error("hqterm: could not reach GitHub to check for updates.");
      return 1;
    }
    if (compareVersions(latest, VERSION) > 0) {
      console.log(`hqterm ${VERSION} -> ${latest} is available. Run: hqterm update`);
      return 0;
    }
    console.log(`hqterm ${VERSION} is the latest.`);
    return 0;
  }
  if (latest && compareVersions(latest, VERSION) <= 0 && !args.includes("--force")) {
    console.log(`hqterm ${VERSION} is the latest. (hqterm update --force reinstalls, and also updates hqsh and the desktop app.)`);
    return 0;
  }

  const res = await fetch(INSTALL_URL).catch(() => null);
  if (!res?.ok) {
    console.error(`hqterm: could not download ${INSTALL_URL}.`);
    return 1;
  }
  const script = await res.text();
  if (!script.startsWith("#!")) {
    console.error(`hqterm: ${INSTALL_URL} did not return an installer.`);
    return 1;
  }
  const dir = mkdtempSync(join(tmpdir(), "hqterm-update-"));
  const file = join(dir, "install.sh");
  writeFileSync(file, script, { mode: 0o700 });
  try {
    const extra = args.filter((a) => a !== "--force");
    console.log(`Updating hqterm ${VERSION}${latest ? ` -> ${latest}` : ""}...`);
    return await runInteractive(["sh", file, ...installerArgs(process.execPath, !!findDesktop(), extra)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
