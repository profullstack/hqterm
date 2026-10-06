/*
 * Pane trees for hqterm desktop, without DOM or PTYs so it can be tested.
 *
 * A tab's layout is a binary tree:
 *   { type: "pane", id, spec }                        spec: { kind: "shell" | "remote" | "hqterm", host?, session? }
 *   { type: "split", dir: "row" | "column", ratio, a, b }   row = side by side, column = stacked
 *
 * Saved layouts (~/.config/hqterm/desktop-layout.json) keep the tree without
 * ids: { version: 1, active, tabs: [{ root, focus }] }.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HqLayout = api;
})(typeof self !== "undefined" ? self : this, function () {
  const HOST_RE = /^[A-Za-z0-9._@:\-\[\]]+$/;
  const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  let nextId = 1;
  const newId = () => `p${nextId++}`;

  function pane(spec) {
    return { type: "pane", id: newId(), spec: cleanSpec(spec) || { kind: "shell" } };
  }

  /** A spec we are willing to run, or undefined. */
  function cleanSpec(spec) {
    if (!spec || typeof spec !== "object") return undefined;
    if (spec.kind === "shell" || spec.kind === "hqterm") return { kind: spec.kind };
    if (spec.kind === "remote" && typeof spec.host === "string" && HOST_RE.test(spec.host) && !spec.host.startsWith("-")) {
      const session = typeof spec.session === "string" && SESSION_RE.test(spec.session) ? spec.session : "main";
      return { kind: "remote", host: spec.host, session };
    }
    return undefined;
  }

  function panes(node, out = []) {
    if (!node) return out;
    if (node.type === "pane") out.push(node);
    else {
      panes(node.a, out);
      panes(node.b, out);
    }
    return out;
  }

  function find(node, id) {
    return panes(node).find((p) => p.id === id);
  }

  /** Replace pane `id` with a split of it and `added`. Returns the new root. */
  function split(root, id, dir, added) {
    const walk = (node) => {
      if (node.type === "pane") return node.id === id ? { type: "split", dir, ratio: 0.5, a: node, b: added } : node;
      return { ...node, a: walk(node.a), b: walk(node.b) };
    };
    return walk(root);
  }

  /** Remove pane `id`; its sibling takes the parent's place. Returns the new root (null when empty). */
  function remove(root, id) {
    const walk = (node) => {
      if (node.type === "pane") return node.id === id ? null : node;
      const a = walk(node.a);
      const b = walk(node.b);
      if (!a) return b;
      if (!b) return a;
      return a === node.a && b === node.b ? node : { ...node, a, b };
    };
    return root ? walk(root) : null;
  }

  /** Session name for a new pane on `host`: main, main-2, main-3 … not used in `taken`. */
  function freeSession(host, taken) {
    const used = new Set(taken.filter((s) => s.kind === "remote" && s.host === host).map((s) => s.session));
    if (!used.has("main")) return "main";
    for (let n = 2; ; n++) if (!used.has(`main-${n}`)) return `main-${n}`;
  }

  /** What a split of `spec` opens: remote panes get a fresh session on the same host, the rest a shell. */
  function splitSpec(spec, taken) {
    if (spec && spec.kind === "remote") return { kind: "remote", host: spec.host, session: freeSession(spec.host, taken) };
    return { kind: "shell" };
  }

  function clampRatio(r) {
    return typeof r === "number" && isFinite(r) ? Math.min(0.95, Math.max(0.05, r)) : 0.5;
  }

  function serializeNode(node) {
    if (node.type === "pane") return { type: "pane", spec: node.spec };
    return { type: "split", dir: node.dir, ratio: clampRatio(node.ratio), a: serializeNode(node.a), b: serializeNode(node.b) };
  }

  /** tabs: [{ root, focus (pane id) }] */
  function serialize(tabs, active) {
    return {
      version: 1,
      active: Math.max(0, Math.min(active | 0, tabs.length - 1)),
      tabs: tabs.map((t) => ({
        root: serializeNode(t.root),
        focus: Math.max(0, panes(t.root).findIndex((p) => p.id === t.focus)),
      })),
    };
  }

  function restoreNode(data, depth) {
    if (!data || typeof data !== "object" || depth > 32) return null;
    if (data.type === "pane") return pane(cleanSpec(data.spec) || { kind: "shell" });
    if (data.type === "split" && (data.dir === "row" || data.dir === "column")) {
      const a = restoreNode(data.a, depth + 1);
      const b = restoreNode(data.b, depth + 1);
      if (!a) return b;
      if (!b) return a;
      return { type: "split", dir: data.dir, ratio: clampRatio(data.ratio), a, b };
    }
    return null;
  }

  /** From saved JSON (text or object) to { tabs: [{ root, focus }], active }; empty tabs when unusable. */
  function restore(saved) {
    let data = saved;
    if (typeof saved === "string") {
      try {
        data = JSON.parse(saved);
      } catch {
        data = null;
      }
    }
    const tabs = [];
    if (data && data.version === 1 && Array.isArray(data.tabs)) {
      for (const t of data.tabs.slice(0, 64)) {
        const root = restoreNode(t && t.root, 0);
        if (!root) continue;
        const list = panes(root);
        const focus = (list[(t.focus | 0)] || list[0]).id;
        tabs.push({ root, focus });
      }
    }
    const active = data && tabs.length ? Math.max(0, Math.min(data.active | 0, tabs.length - 1)) : 0;
    return { tabs, active };
  }

  /**
   * The pane next to `from` in direction dir ("left" | "right" | "up" | "down"),
   * given rects { id: {left, top, right, bottom} }. Picks the closest pane that
   * overlaps on the other axis, else the closest by centre.
   */
  function neighbor(rects, from, dir) {
    const r = rects[from];
    if (!r) return undefined;
    const horiz = dir === "left" || dir === "right";
    let best;
    let bestScore = Infinity;
    for (const [id, o] of Object.entries(rects)) {
      if (id === from) continue;
      const ahead =
        dir === "left" ? o.right <= r.left + 1 : dir === "right" ? o.left >= r.right - 1 : dir === "up" ? o.bottom <= r.top + 1 : o.top >= r.bottom - 1;
      if (!ahead) continue;
      const gap = dir === "left" ? r.left - o.right : dir === "right" ? o.left - r.right : dir === "up" ? r.top - o.bottom : o.top - r.bottom;
      const overlap = horiz ? Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top) : Math.min(r.right, o.right) - Math.max(r.left, o.left);
      const cross = horiz ? Math.abs((o.top + o.bottom) / 2 - (r.top + r.bottom) / 2) : Math.abs((o.left + o.right) / 2 - (r.left + r.right) / 2);
      const score = (overlap > 0 ? 0 : 1e6) + gap * 1000 + cross;
      if (score < bestScore) (bestScore = score), (best = id);
    }
    return best;
  }

  function label(spec) {
    if (!spec) return "shell";
    if (spec.kind === "remote") return spec.session && spec.session !== "main" ? `${spec.host}:${spec.session}` : spec.host;
    if (spec.kind === "hqterm") return "hqterm";
    return "shell";
  }

  return { pane, cleanSpec, panes, find, split, remove, freeSession, splitSpec, serialize, restore, neighbor, label };
});
