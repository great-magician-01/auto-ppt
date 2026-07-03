import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  chat,
  chatAgent,
  type ChatMsg,
  type CancelledError,
  type ToolCall,
  type ToolDef,
  type ToolChoice,
} from "./chat";
import { extractStringArg, toolLabel } from "./toolUtils";
import {
  manuscriptPrompt,
  manuscriptTool,
  splitOutlinePrompt,
  slideHtmlPrompt,
  cleanHtml,
  selfCheckPrompt,
  chatWithElementPrompt,
  tavilyTools,
  outlineTool,
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
import {
  getTavilyKey,
  tavilySearch,
  tavilyExtract,
  recordTavilySearch,
  recordTavilyExtract,
} from "./tavily";
import { renderSlideToDataUrl } from "./ppt";

// 全局生成 store：生成过程（大纲/单页/对话/自检）的唯一真相源。
// 持有流式缓冲与编排状态，组件卸载/重挂载均读取这里，保证切走再回来仍见实时内容。

export type GenPhase =
  | "idle"
  | "manuscript"
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
  artifact: "", // 工具参数提取的产物（html/文案），进预览
  status: "",
  error: null as string | null,
  cancelled: false,
});

function resetBuffers() {
  genState.reasoning = "";
  genState.content = "";
  genState.artifact = "";
  genState.error = null;
  genState.cancelled = false;
}

function isCancelled(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as CancelledError).__cancelled === true;
}

/** 构造取消哨兵错误，供 runToolPhase 在 cancel 时抛出。 */
function makeCancelled(): CancelledError {
  const err = new Error("已取消") as CancelledError;
  err.__cancelled = true;
  return err;
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

/**
 * 执行 Tavily 工具调用并记录用量。返回工具结果文本（供回填给模型）。
 * 异常时返回 [工具错误] 文本，不中断 agent loop。审计行（含积分）追加到 genState.reasoning。
 */
async function execTavilyTool(call: ToolCall, apiKey: string): Promise<string> {
  let args: { query?: string; urls?: string[] } = {};
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return "[工具错误] 参数解析失败";
  }
  try {
    if (call.name === "tavily_search") {
      const q = args.query ?? "";
      if (!q) return "[工具错误] 缺少 query";
      const r = await tavilySearch(apiKey, q);
      await recordTavilySearch(r.credits);
      genState.reasoning += `\n[🔍 搜索] ${q} · +${r.credits} 积分 → ${r.results.length} 条`;
      const lines = r.results.map(
        (x) => `## ${x.title}\nURL: ${x.url}\n${x.content}`
      );
      return `摘要答案：${r.answer}\n\n${lines.join("\n\n")}\n\n[本次消耗 ${r.credits} 积分]`;
    }
    if (call.name === "tavily_extract") {
      const urls = args.urls ?? [];
      if (!urls.length) return "[工具错误] 缺少 urls";
      const r = await tavilyExtract(apiKey, urls);
      await recordTavilyExtract(r.credits, r.results.length);
      genState.reasoning += `\n[📄 提取] ${urls.join(", ")} · +${r.credits} 积分`;
      const lines = r.results.map(
        (x) => `## ${x.url}\n${x.raw_content}`
      );
      return `${lines.join("\n\n")}\n\n[本次消耗 ${r.credits} 积分]`;
    }
    return `[工具错误] 未知工具 ${call.name}`;
  } catch (e) {
    return `[工具错误] ${e instanceof Error ? e.message : String(e)}`;
  }
}

// 阶段1a：生成完整文案（联网时用工具调研）；阶段1b：按文案拆页（JSON 模式）。

/**
 * 单发工具阶段原语：强制 requiredTool 一轮到位。
 * - chat-chunk → genState.content（自然语言，进对话框，实时）
 * - chat-tool-args → 提取 artifactField → genState.artifact（进预览，实时）
 * - 回合末校验（API Schema 已强校验 + validate 业务规则）；合法 → execTool 落库 + 回填 tool_result；
 *   不合法/未调用 → 回填错误 + system 重试一次（再强制）；仍失败 → 抛错。
 * 返回 { nlText, parsedArgs } 供调用方生成消息卡片 label。
 */
export async function runToolPhase(args: {
  systemPrompt: string;
  userPrompt: string;
  requiredTool: ToolDef;
  tools?: ToolDef[];
  execTool: (call: ToolCall, parsedArgs: unknown) => Promise<string>;
  validate?: (parsedArgs: unknown) => string | null;
  artifactField?: string; // 单字段工具：从参数提取该字段进 genState.artifact
  maxRetries?: number;
}): Promise<{ nlText: string; parsedArgs: unknown; call: ToolCall }> {
  const tools = args.tools ?? [args.requiredTool];
  const maxRetries = args.maxRetries ?? 1;
  const messages: ChatMsg[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userPrompt },
  ];
  let lastErr = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (genState.cancelled) throw makeCancelled();
    let nlText = "";
    let argBuf = "";
    const { toolCalls } = await chat(
      messages,
      (d) => { nlText += d; genState.content += d; },
      (d) => { genState.reasoning += d; },
      false,
      {
        tools,
        toolChoice: { type: "tool", name: args.requiredTool.name } as ToolChoice,
        onToolArgs: (e) => {
          if (e.name === args.requiredTool.name) {
            argBuf += e.delta;
            if (args.artifactField) {
              genState.artifact = extractStringArg(argBuf);
            }
          }
        },
      }
    );
    if (genState.cancelled) throw makeCancelled();
    const call = toolCalls?.find((c) => c.name === args.requiredTool.name) ?? null;
    if (!call) {
      lastErr = `模型未调用工具 ${args.requiredTool.name}`;
      messages.push({ role: "assistant", content: nlText });
      messages.push({ role: "system", content: `${lastErr}，请调用 ${args.requiredTool.name} 提交结果。` });
      continue;
    }
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(call.arguments);
    } catch {
      lastErr = "工具参数不是合法 JSON";
      messages.push({ role: "assistant", content: nlText, tool_calls: [call] });
      messages.push({ role: "tool", content: `[校验错误] ${lastErr}`, tool_call_id: call.id });
      messages.push({ role: "system", content: `请重新调用 ${args.requiredTool.name}，修正：${lastErr}` });
      continue;
    }
    const verr = args.validate ? args.validate(parsedArgs) : null;
    if (verr) {
      lastErr = verr;
      messages.push({ role: "assistant", content: nlText, tool_calls: [call] });
      messages.push({ role: "tool", content: `[校验错误] ${lastErr}`, tool_call_id: call.id });
      messages.push({ role: "system", content: `请重新调用 ${args.requiredTool.name}，修正：${lastErr}` });
      continue;
    }
    // 合法 → 落库 + 回填（单发不再请求模型，但保持历史完整）
    const result = await args.execTool(call, parsedArgs);
    messages.push({ role: "assistant", content: nlText, tool_calls: [call] });
    messages.push({ role: "tool", content: result, tool_call_id: call.id });
    return { nlText, parsedArgs, call };
  }
  throw new Error(`${args.requiredTool.name} 校验失败：${lastErr}`);
}

export async function startOutline(
  projectId: number,
  topic: string,
  style?: string | null,
  searchEnabled = false
): Promise<void> {
  genState.projectId = projectId;
  genState.running = true;
  genState.phase = "manuscript";
  resetBuffers();
  let manuscript = "";
  try {
    // —— 文案阶段 ——
    // 若项目已有完整文案（如上次拆页失败/取消但文案已存），跳过调研直接复用
    const proj = await getProject(projectId);
    if (proj?.manuscript) {
      manuscript = proj.manuscript;
      genState.status = "已有完整文案（" + manuscript.length + " 字），跳过调研直接拆分大纲…";
      genState.content = manuscript; // 让 UI 可见
    } else {
      let useSearch = searchEnabled;
      let apiKey: string | null = null;
      if (useSearch) {
        apiKey = await getTavilyKey();
        if (!apiKey) {
          useSearch = false;
          genState.status = "未配置 Tavily Key，离线生成文案…";
        }
      }
      const sysMsg = "你是专业 PPT 文案策划，严格按要求输出。";
      const userMsg = manuscriptPrompt(topic);
      let manuscriptLabel = "";
      if (useSearch && apiKey) {
        genState.status = "联网调研并撰写文案…";
        let capturedManuscript = "";
        let manArgBuf = "";
        const execManuscriptTool = async (call: ToolCall): Promise<string> => {
          if (call.name === "write_manuscript") {
            try {
              const a = JSON.parse(call.arguments) as { content?: string };
              capturedManuscript = a.content ?? "";
              genState.artifact = capturedManuscript;
              await updateProject(projectId, { manuscript: capturedManuscript });
              manuscriptLabel = toolLabel("write_manuscript", a);
              return `已保存文案（${capturedManuscript.length} 字）`;
            } catch {
              return "[工具错误] 参数解析失败";
            }
          }
          return execTavilyTool(call, apiKey!);
        };
        try {
          await chatAgent(
            [{ role: "system", content: sysMsg }, { role: "user", content: userMsg }],
            [...tavilyTools, manuscriptTool],
            execManuscriptTool,
            (d) => {
              genState.content += d;
              genState.status = `撰写文案中… 已收到 ${genState.content.length} 字`;
            },
            (d) => { genState.reasoning += d; },
            () => { genState.content = ""; }, // 每轮清空 NL（只留最终轮）
            undefined,
            () => genState.cancelled,
            "write_manuscript",
            (e) => {
              if (e.name === "write_manuscript") {
                manArgBuf += e.delta;
                genState.artifact = extractStringArg(manArgBuf);
              }
            }
          );
          manuscript = capturedManuscript;
        } catch (e) {
          if (isCancelled(e)) throw e;
          // 联网不可用 → 降级离线 runToolPhase
          genState.status = "联网搜索不可用，改为离线生成文案…";
          genState.content = "";
          const r = await runToolPhase({
            systemPrompt: sysMsg,
            userPrompt: userMsg,
            requiredTool: manuscriptTool,
            artifactField: "content",
            execTool: async (_c, parsed) => {
              const a = parsed as { content: string };
              manuscript = a.content;
              await updateProject(projectId, { manuscript });
              manuscriptLabel = toolLabel("write_manuscript", a);
              return `已保存文案（${a.content.length} 字）`;
            },
          });
          manuscript = (r.parsedArgs as { content: string }).content;
        }
      } else {
        genState.status = "撰写文案中…";
        const r = await runToolPhase({
          systemPrompt: sysMsg,
          userPrompt: userMsg,
          requiredTool: manuscriptTool,
          artifactField: "content",
          execTool: async (_c, parsed) => {
            const a = parsed as { content: string };
            manuscript = a.content;
            await updateProject(projectId, { manuscript });
            manuscriptLabel = toolLabel("write_manuscript", a);
            return `已保存文案（${a.content.length} 字）`;
          },
        });
        manuscript = (r.parsedArgs as { content: string }).content;
      }
      if (genState.cancelled) {
        genState.status = "已取消";
        return;
      }
      if (!manuscript.trim()) {
        throw new Error("文案生成失败：模型未产出任何文案内容，请重试或调整主题。");
      }
      await addMessage(
        projectId,
        "assistant",
        "已生成完整文案。",
        null,
        genState.reasoning,
        JSON.stringify({ name: "write_manuscript", label: manuscriptLabel || toolLabel("write_manuscript", { content: manuscript }) })
      );
    } // 结束 if (proj?.manuscript) else 分支

    // —— 拆页阶段 ——
    if (genState.cancelled) {
      genState.status = "已取消";
      return;
    }
    genState.phase = "outline";
    resetBuffers();
    const r = await runToolPhase({
      systemPrompt: "你是专业 PPT 设计师，按要求调用 commit_outline 提交设计系统与全部页面大纲。",
      userPrompt: splitOutlinePrompt(topic, manuscript, style),
      requiredTool: outlineTool,
      validate: (parsed) => {
        const a = parsed as { slides?: OutlineSlide[] };
        if (!a.slides || !a.slides.length) return "slides 不能为空";
        if (a.slides.some((s) => !s.title)) return "每页必须有 title";
        return null;
      },
      execTool: async (_c, parsed) => {
        const a = parsed as {
          design_tokens: Record<string, string>;
          theme_css: string;
          slides: OutlineSlide[];
          style?: string;
        };
        const tokensJson = JSON.stringify(a.design_tokens, null, 2);
        const resolvedStyle = a.style ?? style ?? null;
        await updateProject(projectId, {
          design_tokens: tokensJson,
          theme_css: a.theme_css,
          style: resolvedStyle,
        });
        for (const s of await listSlides(projectId)) {
          if (s.id) await deleteSlide(s.id);
        }
        for (let i = 0; i < a.slides.length; i++) {
          const s = a.slides[i];
          await upsertSlide({
            project_id: projectId,
            sort: i,
            title: s.title,
            outline: JSON.stringify(s),
            html_content: null,
          });
        }
        return `已保存 ${a.slides.length} 页大纲`;
      },
    });
    const slideCount = (r.parsedArgs as { slides: OutlineSlide[] }).slides.length;
    const label = toolLabel("commit_outline", r.parsedArgs);
    await addMessage(
      projectId,
      "assistant",
      r.nlText || `已生成大纲（${slideCount} 页）与设计系统。`,
      null,
      genState.reasoning,
      JSON.stringify({ name: "commit_outline", label })
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

// 大纲对话修改：强制 commit_outline，校验通过才覆盖写库。
export async function sendOutlineChat(
  projectId: number,
  topic: string,
  style: string | null,
  currentSlides: OutlineSlide[],
  instruction: string,
  manuscript?: string | null
): Promise<void> {
  genState.projectId = projectId;
  genState.running = true;
  genState.phase = "outline-chat";
  resetBuffers();
  try {
    const userPrompt =
      `主题：${topic}${manuscript ? `\n\n【完整文案（供参考，修改大纲时确保覆盖文案要点）】\n${manuscript}` : ""}\n\n当前大纲 JSON：\n${JSON.stringify(
        { slides: currentSlides },
        null,
        2
      )}\n\n用户修改指令：${instruction}`;
    const r = await runToolPhase({
      systemPrompt:
        "你是专业 PPT 设计师。根据用户指令修改大纲，调用 commit_outline 提交修改后的完整设计系统与全部页面（design_tokens/theme_css/slides/style）。每页必须保留 notes 字段，修改页面的同时维护 notes 与要点对齐。",
      userPrompt,
      requiredTool: outlineTool,
      validate: (parsed) => {
        const a = parsed as { slides?: OutlineSlide[] };
        if (!a.slides || !a.slides.length) return "slides 不能为空";
        if (a.slides.some((s) => !s.title)) return "每页必须有 title";
        return null;
      },
      execTool: async (_c, parsed) => {
        const a = parsed as {
          design_tokens: Record<string, string>;
          theme_css: string;
          slides: OutlineSlide[];
          style?: string;
        };
        const tokensJson = JSON.stringify(a.design_tokens, null, 2);
        const resolvedStyle = a.style ?? style ?? null;
        await updateProject(projectId, {
          design_tokens: tokensJson,
          theme_css: a.theme_css,
          style: resolvedStyle,
        });
        for (const s of await listSlides(projectId)) {
          if (s.id) await deleteSlide(s.id);
        }
        for (let i = 0; i < a.slides.length; i++) {
          const s = a.slides[i];
          await upsertSlide({
            project_id: projectId,
            sort: i,
            title: s.title,
            outline: JSON.stringify(s),
            html_content: null,
          });
        }
        return `已保存 ${a.slides.length} 页大纲`;
      },
    });
    const slideCount = (r.parsedArgs as { slides: OutlineSlide[] }).slides.length;
    const label = toolLabel("commit_outline", r.parsedArgs);
    await addMessage(
      projectId,
      "assistant",
      r.nlText || `已按指令更新大纲（${slideCount} 页）。`,
      null,
      genState.reasoning,
      JSON.stringify({ name: "commit_outline", label })
    );
    genState.status = "大纲已更新";
  } catch (e) {
    if (isCancelled(e)) {
      genState.status = "已取消";
    } else {
      genState.error = e instanceof Error ? e.message : String(e);
      genState.status = "错误：" + genState.error;
      // 校验失败不写库（execTool 仅在校验通过后执行）
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

// auto_selfcheck 开时对第 idx 页做自检：多模态发截图+HTML，非多模态仅发 HTML。
async function maybeSelfCheck(
  projectId: number,
  slides: Slide[],
  idx: number
): Promise<void> {
  if (genState.cancelled) return;
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

/** 自检：多模态发截图+HTML、非多模态仅发 HTML → 流式改写 → 校验后写库（破坏主题则还原）。 */
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
    // 多模态：截图并附图自检；非多模态：跳过截图，仅发 HTML 让 AI 依据样式自检
    const ai = await getActiveAi();
    const multimodal = !!ai?.multimodal;
    const dataUrl = multimodal ? await renderSlideToDataUrl(slide.html_content) : null;
    const userMsg: ChatMsg = {
      role: "user",
      content: selfCheckPrompt(slide.html_content, multimodal),
    };
    if (dataUrl) userMsg.images = [dataUrl];
    const msgs: ChatMsg[] = [
      { role: "system", content: "你是 PPT 自检员，只输出改进后的完整 HTML。" },
      userMsg,
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
