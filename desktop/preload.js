// The renderer's only door to the main process.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hq", {
  init: () => ipcRenderer.invoke("app:init"),
  hosts: () => ipcRenderer.invoke("hosts:list"),
  saveLayout: (data) => ipcRenderer.invoke("layout:save", data),
  spawn: (spec, cols, rows) => ipcRenderer.invoke("pty:spawn", { spec, cols, rows }),
  write: (id, data) => ipcRenderer.send("pty:write", id, data),
  resize: (id, cols, rows) => ipcRenderer.send("pty:resize", id, cols, rows),
  kill: (id) => ipcRenderer.send("pty:kill", id),
  onData: (fn) => ipcRenderer.on("pty:data", (_e, id, data) => fn(id, data)),
  onExit: (fn) => ipcRenderer.on("pty:exit", (_e, id, code, signal) => fn(id, code, signal)),
  onOpen: (fn) => ipcRenderer.on("app:open", (_e, spec) => fn(spec)),
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  writeClipboard: (text) => ipcRenderer.send("clipboard:write", text),
  openUrl: (url) => ipcRenderer.send("open:url", url),
});
