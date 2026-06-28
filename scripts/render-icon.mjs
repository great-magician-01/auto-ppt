// 把 icon-source.svg 渲染为 1024×1024 PNG（供 `tauri icon` 生成全套图标用）。
// 运行：node scripts/render-icon.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = join(here, "..", "src-tauri", "icons", "icon-source.svg");
const pngPath = join(here, "..", "src-tauri", "icons", "icon-source.png");

const svg = readFileSync(svgPath, "utf-8");
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1024 },
  background: "transparent",
});
const png = resvg.render().asPng();
writeFileSync(pngPath, png);
console.log("wrote", pngPath, `(${png.length} bytes)`);
