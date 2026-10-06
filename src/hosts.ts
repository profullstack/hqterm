/**
 * The host list: ~/.ssh/config plus hosts the user added in hqterm, kept in
 * ~/.config/hqterm/hosts.json as { "hosts": ["name", ...] }.
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Host {
  name: string;
  source: "ssh" | "user" | "tailscale";
}

export function configDir(env = process.env, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "hqterm");
}

export const hostsFile = (dir = configDir()) => join(dir, "hosts.json");

/** Accepts { hosts: [...] } or a bare array; entries are names or { name }. */
export function parseHostsJson(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (data as { hosts?: unknown })?.hosts;
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const item of list) {
    const name = typeof item === "string" ? item : (item as { name?: unknown })?.name;
    if (typeof name === "string" && name.trim() && !names.includes(name.trim())) names.push(name.trim());
  }
  return names;
}

/**
 * ssh config hosts first, then the user's own, then Tailscale peers, each
 * name once (an ssh alias that is also a peer stays an ssh host; hqsh still
 * routes it over the tailnet).
 */
export function mergeHosts(sshHosts: string[], userHosts: string[], tailnet: string[] = []): Host[] {
  const out: Host[] = [];
  const seen = new Set<string>();
  for (const name of sshHosts) if (!seen.has(name)) (seen.add(name), out.push({ name, source: "ssh" }));
  for (const name of userHosts) if (!seen.has(name)) (seen.add(name), out.push({ name, source: "user" }));
  for (const name of tailnet) if (!seen.has(name)) (seen.add(name), out.push({ name, source: "tailscale" }));
  return out;
}

export function loadUserHosts(dir = configDir()): string[] {
  try {
    return parseHostsJson(readFileSync(hostsFile(dir), "utf8"));
  } catch {
    return [];
  }
}

/** A host name ssh would accept: [user@]host[:port] without spaces or shell characters. */
export function validHostName(name: string): boolean {
  return /^[A-Za-z0-9._@:\-\[\]]+$/.test(name) && !name.startsWith("-");
}

/** Add a host to hosts.json (backing up the old file first). Returns the new list. */
export function addUserHost(name: string, dir = configDir()): string[] {
  const hosts = loadUserHosts(dir);
  if (hosts.includes(name)) return hosts;
  hosts.push(name);
  mkdirSync(dir, { recursive: true });
  const file = hostsFile(dir);
  if (existsSync(file)) {
    let n = 1;
    while (existsSync(join(dir, `hosts.bak-${String(n).padStart(3, "0")}.json`))) n++;
    copyFileSync(file, join(dir, `hosts.bak-${String(n).padStart(3, "0")}.json`));
  }
  writeFileSync(file, JSON.stringify({ hosts }, null, 2) + "\n", { mode: 0o600 });
  return hosts;
}
