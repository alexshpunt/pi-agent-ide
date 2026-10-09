const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { searchCatalog } = require("./search.cjs");

ipcMain.handle("catalog:search", (_event, query) => searchCatalog(query));

app.whenReady().then(() => {
  const window = new BrowserWindow({
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  window.loadFile("index.html");
});
