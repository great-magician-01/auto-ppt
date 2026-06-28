import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { chat, chatOnce, type ChatMsg, type CancelledError } from "./chat";
import {
  outlinePrompt,
  slideHtmlPrompt,
  parseOutline,
  cleanHtml,
  selfCheckPrompt,
  chatWithElementPrompt,
  type OutlineSlide,
} from "./prompt";
import {
  getProject,
  updateProject,
  listSlides,
  upsertSlide,
  addMessage,
  deleteSlide,
  type Slide,
} from "./db";
import { getActiveAi, getSetting } from "./aiConfig";
import { renderSlideToDataUrl } from "./ppt";

// 全局生成 store：生成过程（大纲/单页/对话/自检）的唯一真相源。
// 持有流式缓冲与编排状态，组件卸载/重挂载均读取这里，保证切走再回来仍见实时内容。

export type GenPhase =
  | "idle"
  | "outline"
  | "outline-chat"
  | "slide"
  | "chat"
  | "selfcheck";

export const genState = reactive({
  running: false,
  phase: "idle" as GenPhase,
  projectId: null as number | null,
  slideIdx: 0,
  reasoning: "",
  content: "",
  status: "",
  error: null as string | null,
  cancelled: false,
});

function resetBuffers() {
  genState.reasoning = "";
  genState.content = "";
  genState.error = null;
  genState.cancelled = false;
}

function isCancelled(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as CancelledError).__cancelled === true;
}

/** 取消当前生成：置标志 + 调 Rust abort。 */
export async function cancelGeneration(): Promise<void> {
  if (!genState.running) return;
  genState.cancelled = true;
  try {
    await invoke("cancel_chat");
  } catch {
    /* 忽略：可能已自然结束 */
  }
}

// 阶段1：生成大纲 + 设计系统（JSON 模式，解析失败自动重试一次）。写库后回填 style。
export async function startOutline(
  projectId: number,
  topic: string,
  style?: string | null
): Promise<void> {
  genState.projectId = projectId;
  genState.running = true;
  genState.phase = "outline";
  resetBuffers();
  let parsed: ReturnType<typeof parseOutline> | null = null;
  let lastErr: unknown = null;
  try {
    const msgs: ChatMsg[] = [
      { role: "system", content: "你是专业 PPT 设计师，严格按要求返回 JSON。" },
      { role: "user", content: outlinePrompt(topic, 8, style) },
    ];
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (genState.cancelled) break;
      genState.status = `生成大纲与设计系统（第 ${attempt} 次）…`;
      const raw = await chatOnce(
        msgs,
        (d) => {
          genState.reasoning += d;
          genState.status = `思考中… 已收到 ${genState.reasoning.length} 字思考`;
        },
        true // jsonMode
      );
      if (genState.cancelled) break;
      genState.content = raw;
      try {
        parsed = parseOutline(raw);
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < 2) genState.status = `解析失败，重试中…（${msg}）`;
      }
    }
    if (genState.cancelled) {
      genState.status = "已取消";
      return;
    }
    if (!parsed) throw new Error("大纲解析失败：" + (lastErr instanceof Error ? lastErr.message : String(lastErr)));

    const tokensJson = JSON.stringify(parsed.design_tokens, null, 2);
    // 自动模式下，若模型回填了 style，写回 project.style
    const resolvedStyle = (parsed as { style?: string }).style ?? style ?? null;
    await updateProject(projectId, {
      design_tokens: tokensJson,
      theme_css: parsed.theme_css,
      style: resolvedStyle,
    });

    // 覆盖写 slides：先删旧再插新
    for (const s of await listSlides(projectId)) {
      if (s.id) await deleteSlide(s.id);
    }
    for (let i = 0; i < parsed.slides.length; i++) {
      const s: OutlineSlide = parsed.slides[i];
      await upsertSlide({
        project_id: projectId,
        sort: i,
        title: s.title,
        outline: JSON.stringify(s),
        html_content: null,
      });
    }
    await addMessage(
      projectId,
      "assistant",
      `已生成大纲（${parsed.slides.length} 页）与设计系统。`,
      null,
      genState.reasoning
    );
    genState.status = "大纲已生成，可进入编辑器逐页生成 HTML";
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "错误：" + genState.error;
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}

// 大纲对话修改：非 JSON 模式，提示词约束返回同结构 JSON。解析成功才覆盖写库。
export async function sendOutlineChat(
  projectId: number,
  topic: string,
  style: string | null,
  currentSlides: OutlineSlide[],
  instruction: string
): Promise<void> {
  genState.projectId = projectId;
  genState.running = true;
  genState.phase = "outline-chat";
  resetBuffers();
  try {
    const msgs: ChatMsg[] = [
      {
        role: "system",
        content:
          "你是专业 PPT 设计师。根据用户指令修改给定的大纲 JSON，只返回修改后的完整 JSON 对象（结构同生成阶段：design_tokens/theme_css/slides[/style]），不要 markdown 代码块、不要任何解释文字。",
      },
      {
        role: "user",
        content:
          `主题：${topic}\n\n当前大纲 JSON：\n${JSON.stringify(
            { slides: currentSlides },
            null,
            2
          )}\n\n用户修改指令：${instruction}`,
      },
    ];
    await chat(
      msgs,
      (d) => {
        genState.content += d;
        genState.status = `修改大纲中… 已收到 ${genState.content.length} 字`;
      },
      (d) => {
        genState.reasoning += d;
        genState.status = `思考中… 已收到 ${genState.reasoning.length} 字思考`;
      }
      // 非 jsonMode：HTML/对话不开 JSON 模式
    );
    if (genState.cancelled) {
      genState.status = "已取消";
      return;
    }
    const parsed = parseOutline(genState.content);
    const tokensJson = JSON.stringify(parsed.design_tokens, null, 2);
    const resolvedStyle = (parsed as { style?: string }).style ?? style ?? null;
    await updateProject(projectId, {
      design_tokens: tokensJson,
      theme_css: parsed.theme_css,
      style: resolvedStyle,
    });
    for (const s of await listSlides(projectId)) {
      if (s.id) await deleteSlide(s.id);
    }
    for (let i = 0; i < parsed.slides.length; i++) {
      const s: OutlineSlide = parsed.slides[i];
      await upsertSlide({
        project_id: projectId,
        sort: i,
        title: s.title,
        outline: JSON.stringify(s),
        html_content: null,
      });
    }
    await addMessage(
      projectId,
      "assistant",
      `已按指令更新大纲（${parsed.slides.length} 页）。`,
      null,
      genState.reasoning
    );
    genState.status = "大纲已更新";
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "错误：" + genState.error;
      // 解析失败时保留原大纲不覆盖写库（update 仅在 parse 成功后执行，已满足）
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}

// 阶段2：生成单页 HTML。预览实时流由组件读 genState.content 渲染，完成后写库 + 追加完成简述。
export async function startSlide(
  projectId: number,
  slides: Slide[],
  idx: number
): Promise<void> {
  const proj = await getProject(projectId);
  const slide = slides[idx];
  if (!proj || !slide?.outline) return;
  const outlineSlide: OutlineSlide = JSON.parse(slide.outline);
  genState.projectId = projectId;
  genState.slideIdx = idx;
  genState.running = true;
  genState.phase = "slide";
  resetBuffers();
  try {
    const msgs: ChatMsg[] = [
      { role: "system", content: "你是专业前端工程师，只输出 HTML，不要任何解释。" },
      {
        role: "user",
        content: slideHtmlPrompt({
          topic: proj.topic,
          designTokens: proj.design_tokens ?? "",
          themeCss: proj.theme_css ?? "",
          slide: outlineSlide,
          index: idx + 1,
          total: slides.length,
        }),
      },
    ];
    await chat(
      msgs,
      (d) => {
        genState.content += d;
        // 同步写回 slide 对象，让持有同一引用的组件实时预览
        slide.html_content = cleanHtml(genState.content);
        genState.status = `第 ${idx + 1} 页生成中… 已收到 ${genState.content.length} 字`;
      },
      (d) => {
        genState.reasoning += d;
        genState.status = `第 ${idx + 1} 页思考中… 已收到 ${genState.reasoning.length} 字思考`;
      }
    );
    if (genState.cancelled) {
      genState.status = "已取消";
      return;
    }
    slide.html_content = cleanHtml(genState.content);
    await upsertSlide(slide);
    const kind = outlineSlide.kind;
    const bulletsLen = outlineSlide.bullets?.length ?? 0;
    await addMessage(
      projectId,
      "assistant",
      `第 ${idx + 1} 页已生成 · 版式 ${kind} · ${bulletsLen} 个要点 · ${outlineSlide.title}`,
      slide.id,
      genState.reasoning
    );
    genState.status = `第 ${idx + 1} 页已生成`;
    // 多模态自检（单页生成入口）
    await maybeSelfCheck(projectId, slides, idx);
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
      // 不写半截 HTML 进库
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "错误：" + genState.error;
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}

// 若启用 AI 为多模态且 auto_selfcheck 开，对第 idx 页做自检。
async function maybeSelfCheck(
  projectId: number,
  slides: Slide[],
  idx: number
): Promise<void> {
  if (genState.cancelled) return;
  const ai = await getActiveAi();
  if (!ai?.multimodal) return;
  const flag = await getSetting("auto_selfcheck");
  if (flag === "false") return; // 默认开（null/其他均视为开）
  await selfCheckSlide(projectId, slides, idx);
}

/**
 * 提取 HTML 中 <style> 块的“主题指纹”：所有 background/background-color/color 声明，
 * 排序去重。用于自检前后比对——若主题配色被改动，说明自检破坏了样式，应丢弃重写。
 */
function themeFingerprint(html: string): string {
  const styles = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
  const css = styles.join("\n");
  const decls = css.match(/(?:background|background-color|color)\s*:\s*[^;]+;/gi) ?? [];
  return decls.map((d) => d.replace(/\s+/g, "").toLowerCase()).sort().join("|");
}

/** 多模态自检：截图 → 发图+HTML 给 AI → 流式改写 → 校验后写库。 */
export async function selfCheckSlide(
  projectId: number,
  slides: Slide[],
  idx: number
): Promise<void> {
  const slide = slides[idx];
  if (!slide?.html_content) return;
  const originalHtml = slide.html_content;
  const originalFp = themeFingerprint(originalHtml);
  genState.projectId = projectId;
  genState.slideIdx = idx;
  genState.running = true;
  genState.phase = "selfcheck";
  resetBuffers();
  try {
    const dataUrl = await renderSlideToDataUrl(slide.html_content);
    const msgs: ChatMsg[] = [
      { role: "system", content: "你是 PPT 自检员，只输出改进后的完整 HTML。" },
      { role: "user", content: selfCheckPrompt(slide.html_content), images: [dataUrl] },
    ];
    await chat(
      msgs,
      (d) => {
        genState.content += d;
        slide.html_content = cleanHtml(genState.content);
        genState.status = `自检改写中… 已收到 ${genState.content.length} 字`;
      },
      (d) => {
        genState.reasoning += d;
        genState.status = `自检思考中… 已收到 ${genState.reasoning.length} 字思考`;
      }
    );
    if (genState.cancelled) {
      genState.status = "已取消";
      return;
    }
    const html = cleanHtml(genState.content);
    // 校验1：必须是完整 HTML 文档且含 .slide 画布
    const structOk = /<html/i.test(html) && (/\.slide\b/.test(html) || /class="slide"/.test(html));
    // 校验2：主题指纹必须一致（配色/背景未被改动）；否则自检破坏了样式，丢弃
    const themeOk = structOk && themeFingerprint(html) === originalFp;
    if (themeOk) {
      slide.html_content = html;
      await upsertSlide(slide);
      await addMessage(
        projectId,
        "assistant",
        `已自检并改进第 ${idx + 1} 页`,
        slide.id,
        genState.reasoning
      );
      genState.status = `第 ${idx + 1} 页已自检改进`;
    } else {
      // 结构不合法 或 主题被改动 → 还原原页，不写坏数据
      slide.html_content = originalHtml;
      const reason = structOk ? "样式被改动" : "未返回有效 HTML";
      await addMessage(projectId, "assistant", `第 ${idx + 1} 页自检${reason}，已保留原页`, slide.id);
      genState.status = `第 ${idx + 1} 页自检${reason}，已保留原页`;
    }
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
      // 取消时还原原页（流式中途可能已被改写）
      slide.html_content = originalHtml;
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "自检错误：" + genState.error;
      slide.html_content = originalHtml;
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}

// 生成全部：循环逐页，每完成一页推进 slideIdx（预览/对话栏自动跟随），出错即停。
export async function startAll(
  projectId: number,
  slides: Slide[]
): Promise<void> {
  for (let i = 0; i < slides.length; i++) {
    if (genState.cancelled) break;
    if (slides[i].html_content) continue;
    await startSlide(projectId, slides, i);
    if (genState.cancelled || genState.error) break;
    // startSlide 内已触发自检；此处仅推进 slideIdx
    genState.slideIdx = Math.min(i + 1, slides.length - 1);
  }
  if (!genState.error && !genState.cancelled) genState.status = "全部页面已生成";
}

// 对话修改单页：预览实时流，完成写库 + 追加消息。
export async function sendChat(
  projectId: number,
  slides: Slide[],
  idx: number,
  instruction: string,
  element?: { html: string; selector: string }
): Promise<void> {
  const cur = slides[idx];
  if (!cur?.html_content) return;
  await addMessage(projectId, "user", instruction, cur.id);
  genState.projectId = projectId;
  genState.slideIdx = idx;
  genState.running = true;
  genState.phase = "chat";
  resetBuffers();
  try {
    const userContent = element
      ? chatWithElementPrompt({
          html: cur.html_content,
          elementHtml: element.html,
          selector: element.selector,
          instruction,
        })
      : `这是当前页 HTML：\n${cur.html_content}\n\n用户修改指令：${instruction}`;
    const msgs: ChatMsg[] = [
      {
        role: "system",
        content:
          "你是专业前端。根据用户指令修改给定的幻灯片 HTML，只输出修改后的完整 HTML 文档，不要任何解释文字。",
      },
      { role: "user", content: userContent },
    ];
    await chat(
      msgs,
      (d) => {
        genState.content += d;
        cur.html_content = cleanHtml(genState.content);
        genState.status = `修改中… 已收到 ${genState.content.length} 字`;
      },
      (d) => {
        genState.reasoning += d;
        genState.status = `思考中… 已收到 ${genState.reasoning.length} 字思考`;
      }
    );
    if (genState.cancelled) {
      genState.status = "已取消";
      return;
    }
    cur.html_content = cleanHtml(genState.content);
    await upsertSlide(cur);
    await addMessage(projectId, "assistant", "已按指令更新当前页", cur.id, genState.reasoning);
    genState.status = "已更新";
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "错误：" + genState.error;
    }
  } finally {
    genState.running = false;
    genState.phase = "idle";
  }
}

export function reset() {
  genState.running = false;
  genState.phase = "idle";
  genState.projectId = null;
  genState.slideIdx = 0;
  resetBuffers();
  genState.status = "";
}
