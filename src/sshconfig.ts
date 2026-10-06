/**
 * Host names from an OpenSSH client config: every name on a `Host` line that
 * is a concrete host (no `*`, `?` or `!` pattern). Order is kept, duplicates
 * are dropped. `Include` is followed when a reader is given.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

export type ReadFile = (path: string) => string | undefined;

/** Split a config line into keyword and argument words ("Host a b", "Host=a"). */
function splitLine(line: string): [string, string[]] | undefined {
  const text = line.replace(/^\s+/, "");
  if (!text || text.startsWith("#")) return undefined;
  const m = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(text);
  if (!m) return undefined;
  const args: string[] = [];
  // Words, with "double quoted" names allowed.
  for (const w of m[2]!.matchAll(/"([^"]*)"|(\S+)/g)) {
    const word = w[1] ?? w[2]!;
    if (word.startsWith("#")) break;
    args.push(word);
  }
  return [m[1]!.toLowerCase(), args];
}

/** Hosts that give git, not a shell: never worth listing. */
const GIT_FORGE = /^(ssh\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|aur\.archlinux\.org)$/i;

export const isConcreteHost = (name: string) => name.length > 0 && !/[*?!]/.test(name);

export function parseSshConfig(text: string, opts: { read?: ReadFile; home?: string; depth?: number } = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (isConcreteHost(name) && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };
  const home = opts.home ?? homedir();
  // Names of the current Host block; dropped again if its HostName is a git forge.
  let block: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = splitLine(line);
    if (!parsed) continue;
    const [key, args] = parsed;
    if (key === "host") {
      block = args.filter((n) => isConcreteHost(n) && !seen.has(n) && !GIT_FORGE.test(n));
      block.forEach(add);
    } else if (key === "match") block = [];
    else if (key === "hostname" && args[0] && GIT_FORGE.test(args[0])) {
      for (const name of block) {
        seen.delete(name);
        out.splice(out.indexOf(name), 1);
      }
      block = [];
    } else if (key === "include" && opts.read && (opts.depth ?? 0) < 8) {
      for (const pattern of args) {
        for (const file of expandInclude(pattern, home)) {
          const sub = opts.read(file);
          if (sub) parseSshConfig(sub, { ...opts, depth: (opts.depth ?? 0) + 1 }).forEach(add);
        }
      }
    }
  }
  return out;
}

/** Include paths are relative to ~/.ssh; globs are expanded. */
function expandInclude(pattern: string, home: string): string[] {
  let p = pattern.replace(/^~(?=\/|$)/, home);
  if (!isAbsolute(p)) p = join(home, ".ssh", p);
  if (!/[*?[]/.test(p)) return [p];
  try {
    return [...new Bun.Glob(p).scanSync({ absolute: true, onlyFiles: true })].sort();
  } catch {
    return [];
  }
}

const readText: ReadFile = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Hosts from ~/.ssh/config (and anything it includes). */
export function sshConfigHosts(home = homedir()): string[] {
  const text = readText(join(home, ".ssh", "config"));
  return text ? parseSshConfig(text, { read: readText, home }) : [];
}
