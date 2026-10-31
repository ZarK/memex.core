// The preload of every window the Memex desktop shell opens. It gives the shell's own pages (the starting page,
// the crash screen and About, on memex-shell://app/) three actions. The main process refuses these calls from any
// other page, so an app page gains nothing from them.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "memex-shell:") {
  contextBridge.exposeInMainWorld("memexShell", {
    restart: () => ipcRenderer.invoke("memex-shell:restart"),
    quit: () => ipcRenderer.invoke("memex-shell:quit"),
    openNotices: () => ipcRenderer.invoke("memex-shell:open-notices"),
  });
}
