/**
 * Renders an app icon from one SVG with Electron's own Chromium: <size>x<size>.png, icon.png (512), icon.ico and
 * icon.icns. Run it with Electron: memex-desktop icons <icon.svg> <out-dir>.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BrowserWindow, app } from "electron";
import { ICON_SIZES, ICO_SIZES, buildIcns, buildIco } from "./icons.js";

const [svgPath, outDir] = process.argv.slice(-2);

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(render)
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    app.exit(1);
  });

async function render(): Promise<void> {
  if (!svgPath || !outDir || !svgPath.toLowerCase().endsWith(".svg")) throw new Error("Usage: memex-desktop icons <icon.svg> <out-dir>");
  const svg = readFileSync(svgPath, "utf8");
  mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ width: 512, height: 512, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  let dataUrls: Record<string, string>;
  try {
    await win.loadURL("data:text/html;charset=utf-8,<!doctype html><html><body></body></html>");
    dataUrls = (await win.webContents.executeJavaScript(`(async () => {
      const svg = ${JSON.stringify(svg)};
      const out = {};
      for (const size of ${JSON.stringify(ICON_SIZES)}) {
        const image = new Image();
        const loaded = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('The SVG did not load.')); });
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await loaded;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        canvas.getContext('2d').drawImage(image, 0, 0, size, size);
        out[size] = canvas.toDataURL('image/png');
      }
      return out;
    })()`)) as Record<string, string>;
  } finally {
    win.destroy();
  }
  const pngs = new Map<number, Buffer>();
  for (const size of ICON_SIZES) {
    const png = Buffer.from(String(dataUrls[size]).split(",", 2)[1] ?? "", "base64");
    pngs.set(size, png);
    // electron-builder's Linux icon set reads <size>x<size>.png.
    writeFileSync(path.join(outDir, `${size}x${size}.png`), png);
  }
  writeFileSync(path.join(outDir, "icon.png"), pngs.get(512)!);
  writeFileSync(path.join(outDir, "icon.ico"), buildIco(ICO_SIZES.map((size) => pngs.get(size)!)));
  writeFileSync(path.join(outDir, "icon.icns"), buildIcns({ ic07: pngs.get(128)!, ic08: pngs.get(256)!, ic09: pngs.get(512)! }));
  process.stdout.write(`Wrote ${ICON_SIZES.length} PNG sizes, icon.png, icon.ico and icon.icns to ${outDir}\n`);
  app.exit(0);
}
