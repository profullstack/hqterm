/** `hqterm doctor`: what this terminal can do, and a test image drawn the right way. */
import {
  behindMosh, detectCapabilities, emojiFontStatus, emojiPng, icon, iconMode, imageSupport, inTmux,
  itermImage, kittyImage, passthrough, type ImageSupport,
} from "@profullstack/hqtui";
import { findHqsh } from "./run.ts";
import { VERSION } from "./version.ts";

export interface Facts {
  term: string;
  program: string;
  ssh: boolean;
  tmux: boolean;
  mosh: boolean;
  images: ImageSupport;
  icons: string;
  konsole: boolean;
}

export function gatherFacts(env = process.env): Facts {
  const program = [env.TERM_PROGRAM, env.TERM_PROGRAM_VERSION].filter(Boolean).join(" ") || detectCapabilities({}, env).program || "";
  return {
    term: env.TERM ?? "",
    program,
    ssh: Boolean(env.SSH_CONNECTION || env.SSH_TTY),
    tmux: inTmux(env),
    mosh: behindMosh(env),
    images: imageSupport(env),
    icons: iconMode(env),
    konsole: Boolean(env.KONSOLE_VERSION),
  };
}

/** What to tell the user, from the facts. */
export function advice(f: Facts, fontActive: boolean): string[] {
  const out: string[] = [];
  if (f.mosh) out.push("You are behind mosh, which drops every image. Use `hqterm` / `hqsh <host>` instead of mosh: same persistent session, but images and HD emoji get through.");
  if (f.images === "none" && !f.mosh) {
    if (f.konsole) out.push("Konsole was not detected as an image terminal. Try `hqterm doctor --try kitty` and `--try iterm`; if one shows the rocket, export HQTUI_IMAGES=1 (kitty) or HQTUI_IMAGES=wezterm (iterm).");
    else if (f.ssh || f.tmux) out.push("Over SSH or in tmux the terminal cannot be detected: set HQTUI_IMAGES=1 (Kitty/Ghostty) or HQTUI_IMAGES=wezterm (WezTerm/iTerm2).");
    else out.push("This terminal does not show images to hqtui. Kitty, Ghostty, WezTerm or iTerm2 will.");
  }
  if (f.tmux) out.push("In tmux, images need `set -g allow-passthrough on` in ~/.tmux.conf.");
  if (!fontActive) out.push("For OpenEmoji artwork in plain text too, run `hqterm fonts install`.");
  if (f.icons !== "nerd") out.push("Icons use Unicode. With a Nerd Font, export NERD_FONT=1 for sharper icons.");
  return out;
}

/** The escape that draws image `png` two cells wide with `protocol` (tmux-wrapped when needed). */
export function imageEscape(png: Buffer, protocol: Exclude<ImageSupport, "none">, env = process.env): string {
  return passthrough(protocol === "kitty" ? kittyImage(png, 2) : itermImage(png, 2), env);
}

export async function doctor(args: string[], env = process.env): Promise<number> {
  const tryIdx = args.indexOf("--try");
  const forced = tryIdx >= 0 ? (args[tryIdx + 1] as ImageSupport | undefined) : undefined;
  const f = gatherFacts(env);
  const font = await emojiFontStatus().catch(() => undefined);
  const yes = (b: boolean) => (b ? "yes" : "no");
  const hqsh = findHqsh(env);
  const lines: Array<[string, string]> = [
    ["hqterm", VERSION],
    ["hqsh", hqsh ?? "not installed (curl -fsSL https://hqterm.sh/install | sh)"],
    ["TERM", f.term || "(unset)"],
    ["TERM_PROGRAM", f.program || "(unknown)"],
    ["ssh", yes(f.ssh)],
    ["tmux", yes(f.tmux)],
    ["mosh", yes(f.mosh)],
    ["images", f.images === "none" ? "none (text emoji)" : `${f.images} (HD OpenEmoji / OpenIcon)`],
    ["icons", `${f.icons}  ${icon("server")} ${icon("terminal")} ${icon("lock")}`],
    ["OpenEmoji font", font ? (font.active ? "installed, active" : font.installed ? "installed, not active" : "not installed") : "unknown"],
  ];
  if (font?.emojiFont) lines.push(["emoji font", font.emojiFont]);
  const w = Math.max(...lines.map(([k]) => k.length));
  for (const [k, v] of lines) console.log(`  ${k.padEnd(w)}  ${v}`);
  console.log();

  const protocol: ImageSupport = forced === "kitty" || forced === "iterm" ? forced : f.images;
  if (protocol !== "none" && process.stdout.isTTY) {
    const png = await emojiPng("1f680", 128).catch(() => undefined);
    if (png) {
      process.stdout.write(`  Test image (${protocol}${f.tmux ? ", tmux passthrough" : ""}):  `);
      process.stdout.write(imageEscape(png, protocol, env));
      console.log(`   <- do you see a rocket picture here? (font emoji for comparison: 🚀)`);
    } else console.log("  Could not download the test image (offline?).");
  } else if (protocol === "none") {
    console.log("  No image protocol here, so no test image. Emoji draw as text: 🚀");
  }
  console.log();
  const tips = advice(f, Boolean(font?.active));
  if (tips.length) {
    console.log("  What to do:");
    for (const t of tips) console.log(`  - ${t}`);
  } else console.log("  All good: HD images and icons are on.");
  return 0;
}
