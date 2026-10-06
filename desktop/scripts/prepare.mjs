// Build-time assets for the desktop app:
//   lib/hosts.cjs        the TUI's host-list code (../src), bundled for Node by bun
//   fonts/OpenEmoji-CBDT.ttf   the OpenEmoji colour font (skip: HQTERM_SKIP_FONT=1)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const FONT_URL = "https://raw.githubusercontent.com/profullstack/openemoji/main/font/OpenEmoji-CBDT.ttf";

mkdirSync(join(here, "lib"), { recursive: true });
const r = spawnSync(
  "bun",
  ["build", join(here, "..", "src", "hostlist.ts"), "--target=node", "--format=cjs", "--outfile", join(here, "lib", "hosts.cjs")],
  { stdio: "inherit" },
);
if (r.status !== 0) {
  console.error("prepare: bun build of the host list failed (is bun installed?)");
  process.exit(1);
}

const font = join(here, "fonts", "OpenEmoji-CBDT.ttf");
if (process.env.HQTERM_SKIP_FONT) {
  console.log("prepare: skipping the OpenEmoji font (HQTERM_SKIP_FONT)");
} else if (existsSync(font) && statSync(font).size > 1_000_000) {
  console.log(`prepare: ${font} already here`);
} else {
  mkdirSync(dirname(font), { recursive: true });
  console.log(`prepare: downloading ${FONT_URL}`);
  const res = await fetch(FONT_URL);
  if (!res.ok) {
    console.error(`prepare: font download failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000 || buf.subarray(0, 4).toString("hex") !== "00010000") {
    console.error(`prepare: that does not look like the font (${buf.length} bytes)`);
    process.exit(1);
  }
  writeFileSync(`${font}.part`, buf);
  renameSync(`${font}.part`, font);
  console.log(`prepare: font ${buf.length} bytes`);
}
