// hqterm desktop renderer: tabs of split panes, each pane an xterm.js terminal
// on a PTY in the main process. Layout lives in src/layout.js (HqLayout).
"use strict";
(async function () {
  const L = window.HqLayout;
  const hq = window.hq;
  const $ = (sel) => document.querySelector(sel);
  const INSTALL = "curl -fsSL https://hqterm.sh/install | sh";
  const MAX_WEBGL = 12;

  const init = await hq.init();
  const config = init.config;
  let fontSize = config.fontSize;
  const theme = Object.assign(
    {
      background: "#0f1115",
      foreground: "#d8dee9",
      cursor: "#5ea1ff",
      cursorAccent: "#0f1115",
      selectionBackground: "#5ea1ff55",
    },
    config.theme || {},
  );
  const fontFamily = `${config.fontFamily}, "OpenEmoji"`;
  // The colour emoji font must be loaded before xterm measures and draws glyphs.
  await Promise.race([document.fonts.load(`${fontSize}px "OpenEmoji"`, "\u{1F600}").catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);

  /** @type {{id:number, root:any, focus:string, view:HTMLElement}[]} */
  const tabs = [];
  let active = 0;
  let nextTab = 1;
  const runtimes = new Map(); // pane id -> runtime
  const byPty = new Map(); // pty id -> runtime
  const early = new Map(); // pty id -> { data: string[], exit?: [code, signal] }
  let webglCount = 0;

  // CI smoke test (main.js) checks the focused pane's selection through this.
  if (init.smoke) {
    window.hqSmoke = {
      mouseMode: () => focusedRt()?.term.modes.mouseTrackingMode,
      selection: () => focusedRt()?.term.getSelection() || "",
    };
  }

  // ---------- PTY plumbing ----------

  hq.onData((id, data) => {
    const rt = byPty.get(id);
    if (rt) rt.term.write(data);
    else (early.get(id) || early.set(id, { data: [] }).get(id)).data.push(data);
  });
  hq.onExit((id, code, signal) => {
    const rt = byPty.get(id);
    if (rt) exited(rt, code, signal);
    else (early.get(id) || early.set(id, { data: [] }).get(id)).exit = [code, signal];
  });

  async function spawn(rt) {
    rt.exited = undefined;
    const id = await hq.spawn(rt.spec, rt.term.cols, rt.term.rows);
    if (rt.disposed) return hq.kill(id);
    rt.ptyId = id;
    byPty.set(id, rt);
    const pending = early.get(id);
    if (pending) {
      early.delete(id);
      for (const d of pending.data) rt.term.write(d);
      if (pending.exit) exited(rt, ...pending.exit);
    }
  }

  function exited(rt, code, signal) {
    byPty.delete(rt.ptyId);
    rt.ptyId = undefined;
    if (rt.disposed) return;
    if (code === 0 && !signal) return closePane(rt.pane.id);
    rt.exited = { code, signal };
    let msg = `\r\n\x1b[2m[hqterm] ${rt.spec.kind === "remote" ? "hqsh" : "process"} exited (${signal ? `signal ${signal}` : code}).`;
    if (code === 127) msg += ` ${rt.spec.kind === "remote" ? "hqsh" : "hqterm"} not found; install with: ${INSTALL}`;
    msg += ` Enter ${rt.spec.kind === "remote" ? "reconnects" : "restarts"}, Esc closes.\x1b[0m\r\n`;
    rt.term.write(msg);
  }

  // ---------- panes ----------

  function createRuntime(pane) {
    const el = document.createElement("div");
    el.className = "pane";
    el.dataset.pane = pane.id;
    const term = new Terminal({
      fontFamily,
      fontSize,
      theme,
      allowProposedApi: true,
      scrollback: 10000,
      cursorBlink: true,
      macOptionIsMeta: true,
      allowTransparency: false,
    });
    const rt = { pane, spec: pane.spec, el, term, fit: new FitAddon.FitAddon(), title: "", opened: false };
    term.loadAddon(rt.fit);
    const unicode = new Unicode11Addon.Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => hq.openUrl(uri)));
    term.onData((d) => {
      if (rt.exited) {
        if (d === "\r") {
          term.write("\r\n");
          spawn(rt);
        } else if (d === "\x1b") closePane(pane.id);
        return;
      }
      if (rt.ptyId !== undefined) hq.write(rt.ptyId, d);
    });
    term.onBinary((d) => rt.ptyId !== undefined && hq.write(rt.ptyId, d));
    // Tell the shell the new size only once it has settled: every PTY resize
    // makes a full-screen program (and hqsh's remote side) redraw everything,
    // so resizing per frame while dragging floods it with redraws.
    term.onResize(({ cols, rows }) => {
      clearTimeout(rt.ptyResizeTimer);
      rt.ptyResizeTimer = setTimeout(() => rt.ptyId !== undefined && hq.resize(rt.ptyId, cols, rows), 80);
    });
    term.onTitleChange((t) => {
      rt.title = t;
      renderBar();
    });
    // Shift+drag selects even when the app tracks the mouse, but xterm.js counts
    // every mouse report as user input and clears the selection on it. With
    // any-motion tracking (hqtui's hover) the first move after releasing the
    // button wiped the selection, so hold back hover reports while text is selected.
    el.addEventListener(
      "mousemove",
      (e) => {
        if (!e.buttons && term.modes.mouseTrackingMode === "any" && term.hasSelection()) e.stopPropagation();
      },
      true,
    );
    // Like other Linux terminals, a selection is also the PRIMARY selection
    // (middle-click pastes it); Ctrl+Shift+C still copies to the clipboard.
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) hq.writeSelection(sel);
    });
    // One click focuses a pane.
    el.addEventListener("mousedown", () => setFocus(pane.id), true);
    el.addEventListener("focusin", () => setFocus(pane.id, false));
    rt.observer = new ResizeObserver(() => fitSoon(rt));
    rt.observer.observe(el);
    runtimes.set(pane.id, rt);
    return rt;
  }

  function open(rt) {
    if (rt.opened) return;
    rt.opened = true;
    rt.term.open(rt.el);
    loadWebgl(rt);
    // After the renderer, so images draw on top of it.
    const images = new ImageAddon.ImageAddon({ iipSupport: true, sixelSupport: true, enableSizeReports: true });
    rt.term.loadAddon(images);
    iipCursorLikeITerm(rt.term, images);
    fit(rt);
    spawn(rt);
  }

  /**
   * The fast renderer. Without it xterm falls back to the DOM, where redraws
   * are visibly slow, so say so once instead of silently crawling, and after a
   * lost GPU context try WebGL again rather than staying on the slow path.
   */
  function loadWebgl(rt) {
    if (rt.disposed || webglCount >= MAX_WEBGL) return slowRenderer(rt);
    try {
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => {
        gl.dispose();
        webglCount--;
        rt.webgl = undefined;
        setTimeout(() => loadWebgl(rt), 1000);
      });
      rt.term.loadAddon(gl);
      webglCount++;
      rt.webgl = gl;
    } catch {
      slowRenderer(rt);
    }
  }

  function slowRenderer(rt) {
    if (rt.warnedSlow) return;
    rt.warnedSlow = true;
    rt.term.write("\x1b[2mhqterm: GPU rendering is unavailable here, so this pane uses the slower renderer (see ~/.config/hqterm/desktop.log).\x1b[0m\r\n");
  }

  /**
   * iTerm2, WezTerm and kitty leave the cursor just right of an inline image,
   * and hqtui's emoji art relies on it ("hi " + art + " there"). addon-image
   * leaves it at the image's left edge, so the next text erases the art. After
   * an iTerm2 image (not sixel), move the cursor past it.
   */
  function iipCursorLikeITerm(term, addon) {
    const storage = addon._storage;
    if (!storage || typeof storage.addImage !== "function" || !term._core) return;
    let pending = false;
    // Registered after the addon, so this runs first; false lets the addon draw it.
    term.parser.registerOscHandler(1337, (data) => {
      pending = data.startsWith("File=");
      return false;
    });
    const addImage = storage.addImage.bind(storage);
    storage.addImage = (img) => {
      const buffer = term._core.buffer;
      const x0 = buffer.x;
      addImage(img);
      if (!pending) return;
      pending = false;
      const cell = addon._renderer && addon._renderer.cellSize;
      const w = cell && cell.width > 0 ? cell.width : 10;
      buffer.x = Math.min(x0 + Math.ceil(img.width / w), term.cols);
    };
  }

  function fit(rt) {
    if (!rt.opened || rt.disposed || !rt.el.isConnected) return;
    if (rt.el.clientWidth < 10 || rt.el.clientHeight < 10) return;
    try {
      rt.fit.fit();
    } catch {}
  }

  /**
   * Refit after a size change, at most every FIT_EVERY ms while a window or
   * divider is being dragged, plus once when it stops. A fit reflows the whole
   * scrollback; doing it on every frame is what made resizing judder.
   */
  const FIT_EVERY = 50;
  function fitSoon(rt) {
    if (rt.fitQueued) return;
    rt.fitQueued = true;
    const wait = Math.max(0, FIT_EVERY - (performance.now() - (rt.lastFit || 0)));
    setTimeout(() => {
      requestAnimationFrame(() => {
        rt.fitQueued = false;
        rt.lastFit = performance.now();
        fit(rt);
        // The trailing fit, in case the size kept changing after this one.
        clearTimeout(rt.fitTrail);
        rt.fitTrail = setTimeout(() => fit(rt), FIT_EVERY * 2);
      });
    }, wait);
  }

  function disposeRuntime(rt) {
    rt.disposed = true;
    clearTimeout(rt.ptyResizeTimer);
    clearTimeout(rt.fitTrail);
    if (rt.ptyId !== undefined) {
      hq.kill(rt.ptyId);
      byPty.delete(rt.ptyId);
    }
    rt.observer.disconnect();
    if (rt.webgl) webglCount--;
    rt.term.dispose();
    rt.el.remove();
    runtimes.delete(rt.pane.id);
  }

  // ---------- tabs and layout ----------

  const tabOf = (paneId) => tabs.find((t) => L.find(t.root, paneId));
  const current = () => tabs[active];
  const focusedRt = () => current() && runtimes.get(current().focus);
  const allSpecs = () => tabs.flatMap((t) => L.panes(t.root).map((p) => p.spec));

  function addTab(root, focus) {
    const view = document.createElement("div");
    view.className = "view";
    $("#views").appendChild(view);
    const tab = { id: nextTab++, root, focus: focus || L.panes(root)[0].id, view };
    tabs.push(tab);
    renderTab(tab);
    return tab;
  }

  function newTab(spec) {
    const tab = addTab(L.pane(spec));
    activate(tabs.indexOf(tab));
    save();
  }

  /** Open a spec, or focus the pane already showing that host's session. */
  function openSpec(spec) {
    const clean = L.cleanSpec(spec) || { kind: "shell" };
    if (clean.kind === "remote") {
      for (const t of tabs) {
        const p = L.panes(t.root).find((p) => p.spec.kind === "remote" && p.spec.host === clean.host && p.spec.session === clean.session);
        if (p) {
          activate(tabs.indexOf(t));
          return setFocus(p.id);
        }
      }
    }
    newTab(clean);
  }

  function closeTab(i) {
    const tab = tabs[i];
    if (!tab) return;
    for (const p of L.panes(tab.root)) {
      const rt = runtimes.get(p.id);
      if (rt) disposeRuntime(rt);
    }
    tab.view.remove();
    tabs.splice(i, 1);
    if (!tabs.length) {
      save(true);
      return window.close();
    }
    activate(Math.min(i, tabs.length - 1));
    save();
  }

  function closePane(paneId) {
    const tab = tabOf(paneId);
    if (!tab) return;
    const list = L.panes(tab.root);
    const idx = list.findIndex((p) => p.id === paneId);
    const rt = runtimes.get(paneId);
    if (rt) disposeRuntime(rt);
    tab.root = L.remove(tab.root, paneId);
    if (!tab.root) return closeTab(tabs.indexOf(tab));
    if (tab.focus === paneId) {
      const rest = L.panes(tab.root);
      tab.focus = rest[Math.max(0, idx - 1)] ? rest[Math.max(0, idx - 1)].id : rest[0].id;
    }
    renderTab(tab);
    if (tab === current()) focusTerm();
    renderBar();
    save();
  }

  function splitFocused(dir) {
    const tab = current();
    const rt = focusedRt();
    if (!tab || !rt) return;
    const added = L.pane(L.splitSpec(rt.spec, allSpecs()));
    tab.root = L.split(tab.root, rt.pane.id, dir, added);
    tab.focus = added.id;
    renderTab(tab);
    focusTerm();
    renderBar();
    save();
  }

  function moveFocus(dir) {
    const tab = current();
    if (!tab) return;
    const rects = {};
    for (const p of L.panes(tab.root)) {
      const rt = runtimes.get(p.id);
      if (rt) rects[p.id] = rt.el.getBoundingClientRect();
    }
    const next = L.neighbor(rects, tab.focus, dir);
    if (next) setFocus(next);
  }

  function setFocus(paneId, focusTerminal = true) {
    const tab = tabOf(paneId);
    if (!tab) return;
    if (tab.focus !== paneId) {
      tab.focus = paneId;
      save();
    }
    for (const p of L.panes(tab.root)) {
      const rt = runtimes.get(p.id);
      if (rt) rt.el.classList.toggle("focused", p.id === paneId);
    }
    if (tab === current()) {
      if (focusTerminal) focusTerm();
      renderBar();
    }
  }

  function focusTerm() {
    const rt = focusedRt();
    if (rt) requestAnimationFrame(() => rt.term.focus());
  }

  function activate(i) {
    if (!tabs.length) return;
    active = (i + tabs.length) % tabs.length;
    tabs.forEach((t, j) => t.view.classList.toggle("inactive", j !== active));
    const tab = current();
    for (const p of L.panes(tab.root)) {
      const rt = runtimes.get(p.id);
      if (rt) fitSoon(rt);
    }
    setFocus(tab.focus);
    renderBar();
    save();
  }

  /** (Re)build a tab's pane tree in its view; panes keep their terminals. */
  function renderTab(tab) {
    const build = (node) => {
      if (node.type === "pane") {
        const rt = runtimes.get(node.id) || createRuntime(node);
        rt.el.classList.toggle("focused", node.id === tab.focus);
        return rt.el;
      }
      const box = document.createElement("div");
      box.className = `split ${node.dir}`;
      const a = document.createElement("div");
      const b = document.createElement("div");
      a.className = b.className = "slot";
      const size = () => {
        a.style.flex = `${node.ratio} 1 0`;
        b.style.flex = `${1 - node.ratio} 1 0`;
      };
      size();
      a.appendChild(build(node.a));
      b.appendChild(build(node.b));
      const div = document.createElement("div");
      div.className = "divider";
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const r = box.getBoundingClientRect();
        div.classList.add("dragging");
        document.body.classList.add(`dragging-${node.dir}`);
        const move = (ev) => {
          const f = node.dir === "row" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
          node.ratio = Math.min(0.95, Math.max(0.05, f));
          size();
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          div.classList.remove("dragging");
          document.body.classList.remove(`dragging-${node.dir}`);
          save();
          focusTerm();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
      box.append(a, div, b);
      return box;
    };
    tab.view.replaceChildren(build(tab.root));
    tab.view.classList.toggle("multi", L.panes(tab.root).length > 1);
    for (const p of L.panes(tab.root)) {
      const rt = runtimes.get(p.id);
      if (rt) (rt.opened ? fitSoon(rt) : open(rt));
    }
  }

  function tabLabel(tab) {
    const rt = runtimes.get(tab.focus);
    const spec = rt ? rt.spec : L.panes(tab.root)[0].spec;
    const n = L.panes(tab.root).length;
    const base = (rt && rt.title) || L.label(spec);
    return n > 1 ? `${base} (${n})` : base;
  }

  function renderBar() {
    const bar = $("#tabs");
    bar.replaceChildren(
      ...tabs.map((tab, i) => {
        const el = document.createElement("div");
        el.className = `tab${i === active ? " active" : ""}`;
        el.setAttribute("role", "tab");
        const rt = runtimes.get(tab.focus);
        const icon = document.createElement("img");
        icon.className = "kind";
        icon.src = rt && rt.spec.kind === "remote" ? "icons/server.svg" : "icons/terminal.svg";
        icon.alt = "";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = tabLabel(tab);
        el.title = label.textContent;
        const close = document.createElement("button");
        close.className = "icon";
        close.title = "Close tab (Ctrl+Shift+W)";
        close.innerHTML = '<img src="icons/close.svg" alt="Close" />';
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          closeTab(tabs.indexOf(tab));
        });
        el.addEventListener("mousedown", (e) => {
          if (e.button === 1) {
            e.preventDefault();
            closeTab(tabs.indexOf(tab));
          } else if (e.button === 0 && e.target !== close && !close.contains(e.target)) activate(tabs.indexOf(tab));
        });
        el.append(icon, label, close);
        return el;
      }),
    );
    const rt = focusedRt();
    const t = current();
    document.title = t ? `${(rt && rt.title) || L.label(rt ? rt.spec : undefined)} — hqterm` : "hqterm";
  }

  let saveTimer;
  function save(now) {
    clearTimeout(saveTimer);
    const run = () => hq.saveLayout(L.serialize(tabs.map((t) => ({ root: t.root, focus: t.focus })), active));
    if (now) run();
    else saveTimer = setTimeout(run, 300);
  }

  // ---------- menu ----------

  const menu = $("#menu");
  function closeMenu() {
    menu.hidden = true;
  }
  async function showMenu() {
    if (!menu.hidden) return closeMenu();
    const item = (icon, text, key, fn) => {
      const el = document.createElement("div");
      el.className = "item";
      el.setAttribute("role", "menuitem");
      el.innerHTML = `<img src="icons/${icon}.svg" alt="" /><span></span>${key ? `<span class="key">${key}</span>` : ""}`;
      el.querySelector("span").textContent = text;
      el.addEventListener("click", () => {
        closeMenu();
        fn();
      });
      return el;
    };
    const sep = () => Object.assign(document.createElement("div"), { className: "sep" });
    const items = [
      item("terminal", "New shell", "Ctrl+Shift+T", () => newTab({ kind: "shell" })),
      item("terminal", "hqterm sessions", "", () => newTab({ kind: "hqterm" })),
    ];
    if (focusedRt()) {
      items.push(sep(), item("add", "Split right", "Ctrl+Shift+D", () => splitFocused("row")), item("add", "Split down", "Ctrl+Shift+E", () => splitFocused("column")));
    }
    let hosts = [];
    try {
      hosts = await hq.hosts();
    } catch {}
    if (hosts.length) {
      const head = Object.assign(document.createElement("div"), { className: "head", textContent: "Connect host (hqsh, session main)" });
      items.push(sep(), head, ...hosts.map((h) => item("server", h, "", () => openSpec({ kind: "remote", host: h, session: "main" }))));
    }
    menu.replaceChildren(...items);
    const r = $("#new").getBoundingClientRect();
    menu.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
    menu.style.top = `${r.bottom + 2}px`;
    menu.hidden = false;
  }
  $("#new").addEventListener("click", (e) => {
    e.stopPropagation();
    showMenu();
  });
  window.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target.closest("#new") === null) closeMenu();
  });

  // ---------- keys ----------

  function zoom(delta) {
    fontSize = delta === 0 ? config.fontSize : Math.min(72, Math.max(6, fontSize + delta));
    for (const rt of runtimes.values()) {
      rt.term.options.fontSize = fontSize;
      fitSoon(rt);
    }
  }

  async function paste() {
    const rt = focusedRt();
    const text = await hq.readClipboard();
    if (rt && text && rt.ptyId !== undefined) rt.term.paste(text);
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !menu.hidden) return closeMenu();
      let handled = true;
      if (e.ctrlKey && e.key === "Tab") activate(active + (e.shiftKey ? -1 : 1));
      else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "PageDown") activate(active + 1);
      else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "PageUp") activate(active - 1);
      else if (e.ctrlKey && e.shiftKey && !e.altKey) {
        switch (e.code) {
          case "KeyT":
            newTab({ kind: "shell" });
            break;
          case "KeyW":
            closeTab(active);
            break;
          case "KeyC": {
            const rt = focusedRt();
            const sel = rt && rt.term.getSelection();
            if (sel) hq.writeClipboard(sel);
            break;
          }
          case "KeyV":
            paste();
            break;
          case "KeyD":
            splitFocused("row");
            break;
          case "KeyE":
            splitFocused("column");
            break;
          case "KeyX": {
            const rt = focusedRt();
            if (rt) closePane(rt.pane.id);
            break;
          }
          case "ArrowLeft":
            moveFocus("left");
            break;
          case "ArrowRight":
            moveFocus("right");
            break;
          case "ArrowUp":
            moveFocus("up");
            break;
          case "ArrowDown":
            moveFocus("down");
            break;
          case "Equal":
            zoom(1); // Ctrl+Shift+= is Ctrl++ on US layouts
            break;
          default:
            handled = false;
        }
      } else if (e.ctrlKey && !e.altKey && (e.key === "=" || e.key === "+")) zoom(1);
      else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "-") zoom(-1);
      else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "0") zoom(0);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );

  const fitAll = () => {
    for (const rt of runtimes.values()) fitSoon(rt);
  };
  window.addEventListener("resize", fitAll);
  // The cell size changes without the pane changing size when a font finishes
  // loading or the window moves to a screen with another scale factor; refit
  // then too, or the last row is cut off until the next window resize.
  document.fonts.addEventListener("loadingdone", fitAll);
  (function watchScale() {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        fitAll();
        watchScale();
      },
      { once: true },
    );
  })();

  // ---------- start ----------

  const restored = L.restore(init.layout);
  for (const t of restored.tabs) addTab(t.root, t.focus);
  if (tabs.length) activate(restored.active);
  if (init.open) openSpec(init.open);
  if (!tabs.length) newTab({ kind: "shell" });
  hq.onOpen((spec) => openSpec(spec));
})().catch((err) => {
  document.body.textContent = `hqterm failed to start: ${err && err.stack ? err.stack : err}`;
});
