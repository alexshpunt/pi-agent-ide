const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("catalog", {
  search: (query) => ipcRenderer.invoke("catalog:search", query),
});
