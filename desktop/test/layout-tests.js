"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/layout.js");

const shell = { kind: "shell" };
const remote = (host, session = "main") => ({ kind: "remote", host, session });

test("split and remove keep pane identity and collapse to the sibling", () => {
  const a = L.pane(shell);
  const b = L.pane(remote("dev2"));
  let root = L.split(a, a.id, "row", b);
  assert.equal(root.type, "split");
  assert.equal(root.dir, "row");
  const c = L.pane(shell);
  root = L.split(root, b.id, "column", c);
  assert.deepEqual(L.panes(root).map((p) => p.id), [a.id, b.id, c.id]);
  assert.equal(L.find(root, b.id), b);
  root = L.remove(root, b.id);
  assert.deepEqual(L.panes(root).map((p) => p.id), [a.id, c.id]);
  assert.equal(root.dir, "row");
  root = L.remove(root, a.id);
  assert.equal(root, c);
  assert.equal(L.remove(root, c.id), null);
});

test("a split of a remote pane opens a fresh session on that host", () => {
  const taken = [remote("dev2"), remote("dev2", "main-2"), remote("box")];
  assert.deepEqual(L.splitSpec(remote("dev2"), taken), remote("dev2", "main-3"));
  assert.deepEqual(L.splitSpec(remote("new"), taken), remote("new", "main"));
  assert.deepEqual(L.splitSpec(shell, taken), shell);
  assert.deepEqual(L.splitSpec({ kind: "hqterm" }, taken), shell);
});

test("serialize then restore gives the same tree, specs and focus", () => {
  const a = L.pane(remote("dev2", "work"));
  const b = L.pane(shell);
  const root = { ...L.split(a, a.id, "column", b), ratio: 0.3 };
  const saved = JSON.parse(JSON.stringify(L.serialize([{ root, focus: b.id }, { root: L.pane({ kind: "hqterm" }), focus: "x" }], 1)));
  assert.equal(saved.version, 1);
  assert.equal(saved.active, 1);
  assert.equal(JSON.stringify(saved).includes('"id"'), false);
  const { tabs, active } = L.restore(JSON.stringify(saved));
  assert.equal(active, 1);
  assert.equal(tabs.length, 2);
  const [t0] = tabs;
  assert.equal(t0.root.dir, "column");
  assert.equal(t0.root.ratio, 0.3);
  assert.deepEqual(L.panes(t0.root).map((p) => p.spec), [remote("dev2", "work"), shell]);
  assert.equal(t0.focus, L.panes(t0.root)[1].id);
  assert.deepEqual(L.panes(tabs[1].root)[0].spec, { kind: "hqterm" });
});

test("restore rejects junk and unsafe specs", () => {
  assert.deepEqual(L.restore("not json"), { tabs: [], active: 0 });
  assert.deepEqual(L.restore({ version: 2, tabs: [] }), { tabs: [], active: 0 });
  const { tabs } = L.restore({
    version: 1,
    active: 99,
    tabs: [
      { root: { type: "pane", spec: { kind: "remote", host: "-oProxyCommand=evil" } } },
      { root: { type: "pane", spec: { kind: "remote", host: "dev2", session: "$(rm -rf ~)" } } },
      { root: { type: "split", dir: "diagonal", a: {}, b: {} } },
      { root: { type: "split", dir: "row", ratio: 7, a: { type: "pane", spec: { kind: "exec", cmd: "x" } }, b: null } },
    ],
  });
  assert.equal(tabs.length, 3);
  assert.deepEqual(L.panes(tabs[0].root)[0].spec, shell);
  assert.deepEqual(L.panes(tabs[1].root)[0].spec, remote("dev2", "main"));
  assert.deepEqual(L.panes(tabs[2].root)[0].spec, shell);
});

test("neighbor picks the adjacent pane in each direction", () => {
  // left | right-top / right-bottom
  const rects = {
    l: { left: 0, top: 0, right: 100, bottom: 100 },
    rt: { left: 100, top: 0, right: 200, bottom: 50 },
    rb: { left: 100, top: 50, right: 200, bottom: 100 },
  };
  assert.equal(L.neighbor(rects, "l", "right"), "rt");
  assert.equal(L.neighbor(rects, "rb", "left"), "l");
  assert.equal(L.neighbor(rects, "rt", "down"), "rb");
  assert.equal(L.neighbor(rects, "rb", "up"), "rt");
  assert.equal(L.neighbor(rects, "l", "left"), undefined);
  assert.equal(L.neighbor(rects, "rt", "up"), undefined);
});

test("labels", () => {
  assert.equal(L.label(remote("dev2")), "dev2");
  assert.equal(L.label(remote("dev2", "w")), "dev2:w");
  assert.equal(L.label(shell), "shell");
});
