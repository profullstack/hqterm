/**
 * The full-screen session manager. `render()` is a pure function of the state;
 * `runTui()` owns the app and returns what the user chose to do next, so the
 * caller can stop the TUI, hand the terminal to hqsh, and come back.
 */
import {
  createApp, createImageStore, drawIcon, drawRichText, editText, icon, behindMosh,
  stringWidth, truncate, type ImageStore, type RenderArgs, type Surface,
} from "@profullstack/hqtui";
import type { Host } from "./hosts.ts";
import { fetchSessions, validSessionName, type SessionResult } from "./sessions.ts";
import { validHostName } from "./hosts.ts";
import { VERSION } from "./version.ts";

type Field = { value: string; cursor: number };

export interface State {
  hosts: Host[];
  hostIndex: number;
  /** Row under the cursor in the sessions pane (sessions, then the "new" row). */
  sessionIndex: number;
  focus: "hosts" | "sessions";
  sessions: Map<string, SessionResult | "loading">;
  prompt?: { kind: "session" | "host"; field: Field };
  notice?: string;
  hover?: { pane: "hosts" | "sessions"; row: number };
  images?: ImageStore;
}

export type Action =
  | { kind: "quit" }
  | { kind: "connect"; host: string; session: string }
  | { kind: "install"; host: string };

export interface Handlers {
  selectHost(i: number): void;
  activateSession(i: number): void;
  hover(pane: "hosts" | "sessions", row: number | undefined): void;
  scroll(pane: "hosts" | "sessions", delta: number): void;
}

export function initialState(hosts: Host[]): State {
  return { hosts, hostIndex: 0, sessionIndex: 0, focus: "hosts", sessions: new Map() };
}

export const currentHost = (s: State) => s.hosts[s.hostIndex]?.name;

/** Rows of the sessions pane for the selected host. */
export function sessionRows(state: State): Array<{ kind: "session"; name: string; attached: boolean } | { kind: "new" } | { kind: "install" }> {
  const host = currentHost(state);
  const result = host ? state.sessions.get(host) : undefined;
  if (!host || !result || result === "loading") return [];
  if (result.status === "missing") return [{ kind: "install" }];
  if (result.status === "error") return [{ kind: "new" }];
  return [...result.sessions.map((s) => ({ kind: "session" as const, name: s.name, attached: s.attached })), { kind: "new" as const }];
}

export function imageStatus(images: ImageStore | undefined, env = process.env): string {
  if (images?.mode === "kitty") return "HD images (kitty)";
  if (images?.mode === "iterm") return "HD images (iterm)";
  if (behindMosh(env)) return "text (mosh)";
  return "text";
}

function drawRows(
  s: Surface,
  rows: Array<{ glyph: string; iconName: string; label: string; note?: string; color?: number }>,
  selected: number,
  active: boolean,
  hovered: number | undefined,
  images: ImageStore | undefined,
): void {
  const t = s.theme;
  const top = Math.max(0, Math.min(selected - s.height + 1, rows.length - s.height));
  for (let y = 0; y < s.height && top + y < rows.length; y++) {
    const i = top + y;
    const row = rows[i]!;
    const isSel = i === selected;
    const bg = isSel ? (active ? t.selection ?? t.primary : t.surface ?? t.background) : i === hovered ? t.surface ?? t.background : t.background;
    const fg = isSel && active ? t.foreground : row.color ?? t.foreground;
    s.fillRect(0, y, s.width, 1, { bg });
    let x = s.text(0, y, isSel ? "▌" : " ", { fg: t.primary, bg });
    x += drawIcon(s, x, y, row.iconName, images, row.glyph, { fg: t.accent ?? fg, bg });
    x += s.text(x, y, " ", { bg });
    const noteWidth = row.note ? stringWidth(row.note) + 1 : 0;
    x += drawRichText(s, x, y, truncate(row.label, Math.max(0, s.width - x - noteWidth)), { fg, bg, attrs: isSel ? 1 : 0 }, images);
    if (row.note && s.width - noteWidth > x) s.text(s.width - noteWidth, y, row.note, { fg: t.muted, bg });
  }
}

/** Draw the whole screen for a state. Pure: callbacks are passed in. */
export function render({ ui, width, theme }: Pick<RenderArgs, "ui" | "width" | "theme">, state: State, on: Partial<Handlers> = {}): void {
  const host = currentHost(state);
  const result = host ? state.sessions.get(host) : undefined;

  ui.row({ size: 1 }, (bar) => {
    bar.draw((s) => {
      const t = s.theme;
      const bg = t.surface ?? t.background;
      s.fillRect(0, 0, s.width, 1, { bg });
      const brand = { fg: t.background, bg: t.primary, attrs: 1 };
      let x = s.text(0, 0, " ", brand);
      x += drawIcon(s, x, 0, "terminal", state.images, icon("terminal"), brand);
      x += s.text(x, 0, " hqterm ", brand);
      x += s.text(x, 0, ` v${VERSION}`, { fg: t.muted, bg });
      if (state.notice) s.text(x + 2, 0, truncate(state.notice, Math.max(0, s.width - x - 26)), { fg: t.warning, bg });
      const label = `${imageStatus(state.images)} `;
      s.text(Math.max(0, s.width - stringWidth(label)), 0, label, { fg: state.images?.enabled ? t.success : t.muted, bg });
    });
  });

  ui.row({ size: "fill" }, (row) => {
    const listWidth = Math.min(36, Math.max(20, Math.floor(width * 0.32)));
    row.panel(
      { title: "Hosts", subtitle: `${state.hosts.length}`, size: listWidth, borderColor: state.focus === "hosts" ? theme.borderFocused : undefined },
      (p) => {
        p.draw((s) => {
          if (!state.hosts.length) {
            s.text(0, 0, "No hosts yet.", { fg: s.theme.muted });
            s.text(0, 1, "Press a to add one,", { fg: s.theme.muted });
            s.text(0, 2, "or add Host lines to", { fg: s.theme.muted });
            s.text(0, 3, "~/.ssh/config.", { fg: s.theme.muted });
            return;
          }
          const rows = state.hosts.map((h) => ({
            glyph: icon("server"),
            iconName: "server",
            label: h.name,
            note: h.source === "user" ? "+" : undefined,
          }));
          drawRows(s, rows, state.hostIndex, state.focus === "hosts", state.hover?.pane === "hosts" ? state.hover.row : undefined, state.images);
          const r = s.hitRect();
          const top = Math.max(0, Math.min(state.hostIndex - s.height + 1, rows.length - s.height));
          p.ctx.hit({
            rect: r,
            // One click selects AND opens the host's sessions: no double-click.
            onClick: (_x, y) => top + y < rows.length && on.selectHost?.(top + y),
            onHover: (_x, y) => on.hover?.("hosts", top + y < rows.length ? top + y : undefined),
            onScroll: (d) => on.scroll?.("hosts", d),
          });
        }, { size: "fill" });
      },
    );

    const subtitle =
      !result ? "" : result === "loading" ? "loading…" : result.status === "ok" ? `${result.sessions.length} session${result.sessions.length === 1 ? "" : "s"}` : result.status === "missing" ? "no hqsh" : "unreachable";
    row.panel(
      { title: host ? `Sessions on ${host}` : "Sessions", subtitle, borderColor: state.focus === "sessions" ? theme.borderFocused : undefined },
      (p) => {
        p.draw((s) => {
          const t = s.theme;
          if (!host) return;
          if (!result || result === "loading") {
            s.text(0, 0, `Asking ${host} for its sessions…`, { fg: t.muted });
            return;
          }
          let y0 = 0;
          if (result.status === "missing") {
            s.text(0, 0, "hqsh not installed on host — press i to install", { fg: t.warning });
            y0 = 2;
          } else if (result.status === "error") {
            s.text(0, 0, truncate(result.message, s.width), { fg: t.danger });
            s.text(0, 1, "r retries. n still opens a new session.", { fg: t.muted });
            y0 = 3;
          }
          const rows = sessionRows(state).map((r) =>
            r.kind === "session"
              ? { glyph: icon("terminal"), iconName: "terminal", label: r.name, note: r.attached ? "● attached" : "○ detached", color: r.attached ? t.success : undefined }
              : r.kind === "new"
                ? { glyph: icon("plus"), iconName: "plus", label: "new session", color: t.accent }
                : { glyph: icon("download"), iconName: "download", label: `install hqsh on ${host}`, color: t.accent },
          );
          const list = s.sub(0, y0, s.width, Math.max(0, s.height - y0));
          drawRows(list, rows, state.sessionIndex, state.focus === "sessions", state.hover?.pane === "sessions" ? state.hover.row : undefined, state.images);
          const top = Math.max(0, Math.min(state.sessionIndex - list.height + 1, rows.length - list.height));
          p.ctx.hit({
            rect: list.hitRect(),
            // One click connects.
            onClick: (_x, y) => top + y < rows.length && on.activateSession?.(top + y),
            onHover: (_x, y) => on.hover?.("sessions", top + y < rows.length ? top + y : undefined),
            onScroll: (d) => on.scroll?.("sessions", d),
          });
        }, { size: "fill" });
      },
    );
  });

  if (state.prompt) {
    const label = state.prompt.kind === "session" ? `New session on ${host} (Enter = "main"): ` : "Add host ([user@]host): ";
    ui.textInput({ label, value: state.prompt.field.value, cursor: state.prompt.field.cursor, placeholder: state.prompt.kind === "session" ? "main" : "user@example.com", focused: true, size: 1 });
  } else {
    ui.statusBar({
      items: [
        { key: "Enter", label: "connect" },
        { key: "n", label: "new" },
        { key: "a", label: "add host" },
        { key: "i", label: "install hqsh" },
        { key: "r", label: "refresh" },
        { key: "Tab", label: "pane" },
        { key: "q", label: "quit" },
      ],
      size: 1,
    });
  }
}

/** Run the TUI until the user picks an action. */
export async function runTui(state: State, opts: { onAddHost?: (name: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<Action> {
  const env = opts.env ?? process.env;
  const app = await createApp({ quitKeys: ["ctrl+c"], focusNavigation: false, focusEvents: true, title: "hqterm" });
  const redraw = () => app.invalidate();
  state.images = createImageStore({ write: (seq) => app.terminal.write(seq), onReady: redraw, env });
  state.images.attach(app);
  let action: Action = { kind: "quit" };
  const finish = (a: Action) => {
    action = a;
    app.stop();
  };

  const load = (host: string | undefined, force = false) => {
    if (!host || (!force && state.sessions.has(host))) return;
    state.sessions.set(host, "loading");
    redraw();
    fetchSessions(host).then((r) => {
      state.sessions.set(host, r);
      const rows = currentHost(state) === host ? sessionRows(state).length : 0;
      if (rows && state.sessionIndex >= rows) state.sessionIndex = 0;
      redraw();
    });
  };

  const selectHost = (i: number) => {
    if (i < 0 || i >= state.hosts.length) return;
    if (i !== state.hostIndex) state.sessionIndex = 0;
    state.hostIndex = i;
    state.notice = undefined;
    load(currentHost(state));
    redraw();
  };

  const activateSession = (i: number) => {
    const host = currentHost(state);
    const row = sessionRows(state)[i];
    if (!host) return;
    state.focus = "sessions";
    state.sessionIndex = i;
    if (!row) return redraw();
    if (row.kind === "session") finish({ kind: "connect", host, session: row.name });
    else if (row.kind === "install") finish({ kind: "install", host });
    else {
      state.prompt = { kind: "session", field: { value: "", cursor: 0 } };
      redraw();
    }
  };

  const handlers: Handlers = {
    selectHost: (i) => {
      state.focus = "hosts";
      selectHost(i);
    },
    activateSession,
    hover: (pane, row) => {
      const next = row === undefined ? undefined : { pane, row };
      if (next?.pane !== state.hover?.pane || next?.row !== state.hover?.row) {
        state.hover = next;
        redraw();
      }
    },
    scroll: (pane, d) => {
      if (pane === "hosts") selectHost(Math.max(0, Math.min(state.hosts.length - 1, state.hostIndex + Math.sign(d))));
      else {
        state.sessionIndex = Math.max(0, Math.min(sessionRows(state).length - 1, state.sessionIndex + Math.sign(d)));
        redraw();
      }
    },
  };

  const submitPrompt = () => {
    const p = state.prompt!;
    const value = p.field.value.trim();
    if (p.kind === "session") {
      const name = value || "main";
      if (!validSessionName(name)) return void (state.notice = "Session names: letters, digits, . _ - only");
      const host = currentHost(state);
      state.prompt = undefined;
      if (host) finish({ kind: "connect", host, session: name });
    } else {
      if (!value) return void (state.prompt = undefined);
      if (!validHostName(value)) return void (state.notice = "That does not look like a host name");
      state.prompt = undefined;
      opts.onAddHost?.(value);
      const i = state.hosts.findIndex((h) => h.name === value);
      if (i >= 0) selectHost(i);
    }
  };

  app.on("key", (event) => {
    const k = event.key;
    if (state.prompt) {
      if (k === "escape") state.prompt = undefined;
      else if (k === "enter") submitPrompt();
      else {
        const next = editText(state.prompt.field, event);
        if (next) state.prompt.field = next;
      }
      return redraw();
    }
    const host = currentHost(state);
    const rows = sessionRows(state).length;
    if (k === "q") return finish({ kind: "quit" });
    if (k === "tab" || k === "shift+tab") state.focus = state.focus === "hosts" ? "sessions" : "hosts";
    else if (k === "left" || k === "h") state.focus = "hosts";
    else if (k === "right" || k === "l") state.focus = "sessions";
    else if (k === "up" || k === "k") {
      if (state.focus === "hosts") selectHost(state.hostIndex - 1);
      else state.sessionIndex = Math.max(0, state.sessionIndex - 1);
    } else if (k === "down" || k === "j") {
      if (state.focus === "hosts") selectHost(state.hostIndex + 1);
      else state.sessionIndex = Math.min(Math.max(0, rows - 1), state.sessionIndex + 1);
    } else if (k === "enter") {
      if (state.focus === "hosts") {
        // Enter on a host: its first session, or straight to "new" when it has none.
        state.focus = "sessions";
        state.sessionIndex = 0;
        if (rows) activateSession(0);
      } else activateSession(state.sessionIndex);
    } else if (k === "n" && host) state.prompt = { kind: "session", field: { value: "", cursor: 0 } };
    else if (k === "a") state.prompt = { kind: "host", field: { value: "", cursor: 0 } };
    else if (k === "i" && host) return finish({ kind: "install", host });
    else if (k === "r") load(host, true);
    redraw();
  });

  app.on("exit", () => state.images?.clear());
  app.render((args) => render(args, state, handlers));
  load(currentHost(state));
  await app.start();
  return action;
}

