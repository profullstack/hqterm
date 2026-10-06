import { describe, expect, test } from "bun:test";
import { compareVersions, installerArgs, latestVersion } from "../src/update.ts";

describe("hqterm update", () => {
  test("compares versions numerically", () => {
    expect(compareVersions("0.2.10", "0.2.9")).toBe(1);
    expect(compareVersions("v0.2.2", "0.2.2")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.2")).toBe(-1);
  });

  test("updates a compiled binary in place and keeps the desktop app", () => {
    expect(installerArgs("/home/a/.local/bin/hqterm", true)).toEqual(["--bin=/home/a/.local/bin", "--desktop"]);
    expect(installerArgs("/usr/local/bin/hqterm", false)).toEqual(["--bin=/usr/local/bin"]);
    // Running from source under bun: the installer's default directory.
    expect(installerArgs("/home/a/.bun/bin/bun", false)).toEqual([]);
  });

  test("reads the latest release tag, and says nothing when GitHub fails", async () => {
    const ok = (async () => new Response(JSON.stringify({ tag_name: "v0.2.3" }))) as unknown as typeof fetch;
    expect(await latestVersion(ok)).toBe("0.2.3");
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await latestVersion(down)).toBeNull();
  });
});
