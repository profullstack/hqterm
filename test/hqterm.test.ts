import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToText } from "@profullstack/hqtui";
import { parseSshConfig } from "../src/sshconfig.ts";
import { addUserHost, loadUserHosts, mergeHosts, parseHostsJson, validHostName } from "../src/hosts.ts";
import { classify, listArgs, parseSessionList } from "../src/sessions.ts";
import { initialState, render, sessionRows } from "../src/tui.ts";
import { advice, type Facts } from "../src/doctor.ts";

describe("ssh config", () => {
  test("concrete hosts only, in order, once", () => {
    const text = `
# comment
Host *
  ServerAliveInterval 30
Host dev2 dev2-alt
  HostName 10.0.0.2
Host=box
host *.internal !bad
Host "quoted name" web-?
  Host dev2
Match all
Host last # trailing comment
`;
    expect(parseSshConfig(text)).toEqual(["dev2", "dev2-alt", "box", "quoted name", "last"]);
  });

  test("skips git forges and their aliases", () => {
    const text = "Host github.com\n  User git\nHost gh-work\n  HostName github.com\nHost box\n  HostName 1.2.3.4\n";
    expect(parseSshConfig(text)).toEqual(["box"]);
  });

  test("follows Include", () => {
    const files: Record<string, string> = { "/h/.ssh/conf.d/work": "Host work1 work2\n" };
    const hosts = parseSshConfig("Include /h/.ssh/conf.d/work\nHost home\n", { read: (p) => files[p], home: "/h" });
    expect(hosts).toEqual(["work1", "work2", "home"]);
  });

  test("relative Include is under ~/.ssh", () => {
    const seen: string[] = [];
    parseSshConfig("Include extra\n", { read: (p) => (seen.push(p), undefined), home: "/h" });
    expect(seen).toEqual(["/h/.ssh/extra"]);
  });
});

describe("hosts.json", () => {
  test("parses both shapes", () => {
    expect(parseHostsJson('{"hosts":["a","b",{"name":"c"},"a",""]}')).toEqual(["a", "b", "c"]);
    expect(parseHostsJson('["x", {"name":" y "}]')).toEqual(["x", "y"]);
    expect(parseHostsJson("not json")).toEqual([]);
    expect(parseHostsJson("{}")).toEqual([]);
  });

  test("merge keeps ssh first and drops duplicates", () => {
    expect(mergeHosts(["a", "b"], ["b", "c"])).toEqual([
      { name: "a", source: "ssh" },
      { name: "b", source: "ssh" },
      { name: "c", source: "user" },
    ]);
  });

  test("add writes, dedupes and backs up", () => {
    const dir = mkdtempSync(join(tmpdir(), "hqterm-test-"));
    try {
      expect(addUserHost("me@box", dir)).toEqual(["me@box"]);
      expect(addUserHost("other", dir)).toEqual(["me@box", "other"]);
      expect(addUserHost("other", dir)).toEqual(["me@box", "other"]);
      expect(loadUserHosts(dir)).toEqual(["me@box", "other"]);
      expect(JSON.parse(readFileSync(join(dir, "hosts.json"), "utf8"))).toEqual({ hosts: ["me@box", "other"] });
      expect(readdirSync(dir).sort()).toEqual(["hosts.bak-001.json", "hosts.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("host name validation", () => {
    expect(validHostName("user@host.example:2222")).toBe(true);
    expect(validHostName("-oProxyCommand=x")).toBe(false);
    expect(validHostName("a b")).toBe(false);
    expect(validHostName("a;rm")).toBe(false);
  });
});

describe("session list", () => {
  test("parses hqsh server list --json", () => {
    expect(parseSessionList('[{"name":"main","attached":true},{"name":"logs","attached":false}]')).toEqual([
      { name: "main", attached: true },
      { name: "logs", attached: false },
    ]);
  });
  test("tolerates motd noise, empty and null", () => {
    expect(parseSessionList('Welcome!\n[{"name":"a"}]\n')).toEqual([{ name: "a", attached: false }]);
    expect(parseSessionList("")).toEqual([]);
    expect(parseSessionList("null\n")).toEqual([]);
    expect(parseSessionList("[]")).toEqual([]);
    expect(parseSessionList("garbage")).toBeUndefined();
  });
  test("classifies ssh outcomes", () => {
    expect(classify(0, "[]", "")).toEqual({ status: "ok", sessions: [] });
    expect(classify(127, "", "sh: 1: hqsh: not found")).toEqual({ status: "missing" });
    expect(classify(1, "", "bash: line 1: hqsh: command not found")).toEqual({ status: "missing" });
    expect(classify(255, "", "ssh: connect to host x port 22: Connection refused\n")).toEqual({
      status: "error",
      message: "ssh: connect to host x port 22: Connection refused",
    });
  });
  test("ssh is non-interactive with a timeout", () => {
    expect(listArgs("dev2").slice(0, 6)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "dev2"]);
    expect(listArgs("dev2")[6]).toContain("hqsh server list --json");
  });
});

describe("tui", () => {
  test("renders hosts, sessions and the missing-hqsh hint", () => {
    const state = initialState(mergeHosts(["dev2"], ["box"]));
    state.sessions.set("dev2", { status: "ok", sessions: [{ name: "main", attached: true }] });
    let text = renderToText((args) => render(args, state), { width: 100, height: 12 });
    expect(text).toContain("hqterm");
    expect(text).toContain("dev2");
    expect(text).toContain("box");
    expect(text).toContain("main");
    expect(text).toContain("new session");
    expect(sessionRows(state).map((r) => r.kind)).toEqual(["session", "new"]);

    state.hostIndex = 1;
    state.sessions.set("box", { status: "missing" });
    text = renderToText((args) => render(args, state), { width: 100, height: 12 });
    expect(text).toContain("hqsh not installed on host — press i to install");
    expect(sessionRows(state).map((r) => r.kind)).toEqual(["install"]);
  });

  test("prompt replaces the status bar", () => {
    const state = initialState(mergeHosts(["dev2"], []));
    state.prompt = { kind: "session", field: { value: "", cursor: 0 } };
    expect(renderToText((args) => render(args, state), { width: 100, height: 10 })).toContain("New session on dev2");
  });
});

describe("doctor advice", () => {
  const base: Facts = { term: "xterm-256color", program: "", ssh: false, tmux: false, mosh: false, images: "kitty", icons: "nerd", konsole: false };
  test("mosh says use hqsh", () => {
    expect(advice({ ...base, mosh: true, images: "none" }, true).join(" ")).toContain("instead of mosh");
  });
  test("konsole gets --try", () => {
    expect(advice({ ...base, images: "none", konsole: true }, true).join(" ")).toContain("--try kitty");
  });
  test("font missing suggests fonts install", () => {
    expect(advice(base, false).join(" ")).toContain("hqterm fonts install");
    expect(advice(base, true)).toEqual([]);
  });
});
