import { domToPng } from "modern-screenshot";
import pptxgen from "pptxgenjs";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { SLIDE_W, SLIDE_H } from "./prompt";
import { addExport, type Slide } from "./db";

function nextFrame(): Promise<void> {
  return new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))
  );
}

/**
 * 在隔离的隐藏 iframe（1920×1080）中渲染一页并截图为 dataURL。
 * 用 iframe 是为了 CSS 隔离：幻灯片 HTML 里的 <style>（可能含 :root/body/*
 * 等全局规则）只作用于 iframe 文档，不会污染应用主文档的样式。
 * 早期版本把 <style> 注入主文档容器，截图瞬间全局样式会覆盖应用 UI（如 --primary）。
 */
export async function renderSlideToDataUrl(html: string): Promise<string> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;";
  document.body.appendChild(host);
  const iframe = document.createElement("iframe");
  iframe.style.cssText = `width:${SLIDE_W}px;height:${SLIDE_H}px;border:0;background:#ffffff;`;
  host.appendChild(iframe);
  try {
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(html);
    doc.close();
    // 等待 iframe 布局与字体就绪
    await nextFrame();
    await (iframe.contentWindow as any)?.fonts?.ready;
    await nextFrame();
    const slideEl = doc.querySelector(".slide") as HTMLElement | null;
    const target: HTMLElement = slideEl ?? doc.body;
    // 截 .slide 元素本身（已固定 1920×1080），避免 iframe 边距干扰。
    // 注意：不要传 backgroundColor —— modern-screenshot 会把它以 !important 覆盖到
    // 克隆根节点上，从而抹掉 .slide 自身的 background:var(--background)（深色背景被强改为白）。
    // 画布底色由 iframe 的 background:#ffffff 提供，仅当 .slide 背景透明时才透出白色。
    return await domToPng(target, { scale: 1 });
  } finally {
    host.remove();
  }
}

/** 把幻灯片数组导出为 pptx（每页一张全幅图）并保存到用户选择的路径。 */
export async function exportPptx(
  slides: Slide[],
  projectId: number,
  title?: string
): Promise<string> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 inches, 16:9
  pptx.author = "纸光幻演";

  for (const slide of slides) {
    if (!slide.html_content) continue;
    const dataUrl = await renderSlideToDataUrl(slide.html_content);
    const s = pptx.addSlide();
    s.addImage({ data: dataUrl, x: 0, y: 0, w: 13.333, h: 7.5 });
    // 讲者备注：解析 outline JSON 取 notes（文案先行流程才有）
    if (slide.outline) {
      try {
        const ol = JSON.parse(slide.outline) as { notes?: string };
        if (ol.notes && ol.notes.trim()) {
          s.addNotes(ol.notes);
        }
      } catch {
        /* outline 非合法 JSON 时忽略备注 */
      }
    }
  }

  const result = (await pptx.write({ outputType: "blob" })) as Blob;
  const buf = new Uint8Array(await result.arrayBuffer());

  // 文件名默认用项目标题（去非法字符）；空则 fallback
  const safeName = (title ?? "").replace(/[\\/:*?"<>|]/g, "").trim();
  const defaultPath = (safeName ? safeName : "presentation") + ".pptx";

  const path = await save({
    title: "保存 PPT",
    defaultPath,
    filters: [{ name: "PowerPoint", extensions: ["pptx"] }],
  });
  if (!path) throw new Error("已取消导出");

  await invoke("save_file", { path, data: Array.from(buf) });
  await addExport(projectId, path);
  return path;
}
