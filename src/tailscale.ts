/**
 * Tailscale peers as hosts. When Tailscale runs here, every online machine
 * on the tailnet joins the host list under its MagicDNS short name, and hqsh
 * (0.3+) reaches it over the tailnet. HQTERM_TAILSCALE=off hides them.
 */
import { spawnSync } from "node:child_process";

interface Peer {
  HostName?: string;
  DNSName?: string;
  Online?: boolean;
  TailscaleIPs?: string[];
}

/** Host names from `tailscale status --json` output: online peers only. */
export function parseTailscalePeers(json: string): string[] {
  let data: { BackendState?: string; Peer?: Record<string, Peer> };
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (data?.BackendState !== "Running" || !data.Peer) return [];
  const names: string[] = [];
  for (const p of Object.values(data.Peer)) {
    if (!p?.Online || !p.TailscaleIPs?.length) continue;
    const dns = (p.DNSName ?? "").replace(/\.$/, "").toLowerCase();
    const name = dns.split(".")[0] || (p.HostName ?? "").toLowerCase();
    if (name && /^[a-z0-9][a-z0-9-]*$/.test(name) && !names.includes(name)) names.push(name);
  }
  return names.sort();
}

export function tailscaleHosts(env = process.env): string[] {
  if ((env.HQTERM_TAILSCALE ?? "").toLowerCase() === "off") return [];
  try {
    const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 1500 });
    if (r.status !== 0 || !r.stdout) return [];
    return parseTailscalePeers(r.stdout);
  } catch {
    return [];
  }
}
