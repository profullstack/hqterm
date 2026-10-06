/**
 * The host list the TUI shows, as plain names. Bundled for Node into
 * desktop/lib/hosts.cjs so the desktop app's "+" menu lists the same hosts.
 */
import { loadUserHosts, mergeHosts, validHostName } from "./hosts.ts";
import { sshConfigHosts } from "./sshconfig.ts";

export function listHosts(): string[] {
  return mergeHosts(sshConfigHosts(), loadUserHosts()).map((h) => h.name);
}

export { validHostName };
