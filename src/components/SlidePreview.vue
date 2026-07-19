<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { SLIDE_W, SLIDE_H } from "../lib/prompt";

const props = defineProps<{
  html: string;
  inspectMode?: boolean;
}>();
const emit = defineEmits<{ pick: [payload: { html: string; selector: string }] }>();

const wrap = ref<HTMLElement | null>(null);
const iframeEl = ref<HTMLIFrameElement | null>(null);
const scale = ref(0);
let ro: ResizeObserver | null = null;

function update() {
  if (!wrap.value) return;
  const w = wrap.value.clientWidth;
  const h = wrap.value.clientHeight;
  // 双向 contain：取宽高各自比例的最小值，保证 1920×1080 完整装入不溢出
  scale.value = Math.min(w / SLIDE_W, h / SLIDE_H);
}

function cssSelectorPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  const body = el.ownerDocument?.body ?? null;
  while (node && node !== body) {
    const cur: Element = node;
    let sel = cur.tagName.toLowerCase();
    if (cur.id) {
      sel += `#${cur.id}`;
      parts.unshift(sel);
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const sibs: Element[] = Array.from(parent.children).filter(
        (c: Element) => c.tagName === cur.tagName
      );
      if (sibs.length > 1) {
        const idx = sibs.indexOf(cur) + 1;
        sel += `:nth-child(${idx})`;
      }
    }
    parts.unshift(sel);
    node = parent;
  }
  return parts.join(" > ");
}

function clearHighlight() {
  const doc = iframeEl.value?.contentDocument;
  if (!doc) return;
  doc.querySelectorAll("[data-inspect-hl]").forEach((n) => {
    n.removeAttribute("data-inspect-hl");
    (n as HTMLElement).style.outline = "";
  });
}

function attachInspector() {
  const doc = iframeEl.value?.contentDocument;
  if (!doc) return;
  // 防重复挂载：先移除再添加（用命名包装函数引用）
  doc.removeEventListener("click", onClick as EventListener, true);
  doc.addEventListener("click", onClick as EventListener, true);
}

function onClick(e: MouseEvent) {
  if (!props.inspectMode) return;
  e.preventDefault();
  const target = e.target as Element | null;
  if (!target) return;
  clearHighlight();
  (target as HTMLElement).style.outline = "2px solid #e03131";
  target.setAttribute("data-inspect-hl", "1");
  emit("pick", {
    html: (target as HTMLElement).outerHTML,
    selector: cssSelectorPath(target),
  });
}

// ---- 防闪烁：节流 srcdoc 重载 + 匹配底色 ----
// 流式生成时 html 每 token 变化，直接绑 srcdoc 会让 iframe 每 token 全量重载 → 白底反复闪。
// 节流到约 150ms 一次（leading+trailing：离散变化立即生效，流式则平滑）；并把探测到的
// 幻灯片实色背景设到 iframe 元素自身，重载间隙显示该色而非白色，黑底不再刺眼。
const displayHtml = ref(props.html);
const iframeBg = ref(detectBg(props.html));
let lastFlush = 0;
let throttleTimer: number | null = null;
let pendingHtml = props.html;

function flushNow() {
  displayHtml.value = pendingHtml;
  iframeBg.value = detectBg(pendingHtml);
  lastFlush = Date.now();
}

watch(
  () => props.html,
  (h) => {
    pendingHtml = h;
    if (throttleTimer != null) return; // 已有 trailing 计划，到时刷最新值即可
    const elapsed = Date.now() - lastFlush;
    if (elapsed >= 150) {
      flushNow(); // 离散变化（如手动切页）立即生效，不卡顿
    } else {
      throttleTimer = window.setTimeout(() => {
        throttleTimer = null;
        flushNow();
      }, 150 - elapsed);
    }
  }
);

/** 从 <style> 里取 .slide / body 的实色背景（支持 var() 解析 :root），作为重载间隙底色。 */
function detectBg(html: string): string {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const css = styleMatch?.[1] ?? "";
  const vars = new Map<string, string>();
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
  if (rootMatch) {
    for (const d of rootMatch[1].matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
      vars.set(d[1].trim(), d[2].trim());
    }
  }
  const raw =
    (
      css.match(/\.slide\s*\{[^}]*background(?:-color)?\s*:\s*([^;}]+)/i) ||
      css.match(/\bbody\s*\{[^}]*background(?:-color)?\s*:\s*([^;}]+)/i)
    )?.[1]?.trim() ?? "";
  if (!raw) return "#fff";
  let resolved = raw;
  const varRef = raw.match(/var\(\s*(--[\w-]+)\s*\)/);
  if (varRef) resolved = vars.get(varRef[1]) ?? "";
  if (!resolved) return "#fff";
  // 仅接受实色（hex / rgb / 命名色），gradient 等回落白
  if (/^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+)$/i.test(resolved)) return resolved;
  return "#fff";
}

onMounted(() => {
  update();
  if (wrap.value) {
    ro = new ResizeObserver(update);
    ro.observe(wrap.value);
  }
  // 兜底：srcdoc 首次载入若 @load 已挂则幂等无副作用
  nextTick(attachInspector);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  if (throttleTimer != null) window.clearTimeout(throttleTimer);
  const doc = iframeEl.value?.contentDocument;
  doc?.removeEventListener("click", onClick as EventListener, true);
});
watch(() => props.inspectMode, () => {
  if (!props.inspectMode) clearHighlight();
});
</script>

<template>
  <div class="preview-wrap" ref="wrap">
    <div
      class="preview-stage"
      :style="{
        width: SLIDE_W + 'px',
        height: SLIDE_H + 'px',
        transform: `scale(${scale})`,
      }"
    >
      <iframe
        v-if="displayHtml"
        ref="iframeEl"
        :srcdoc="displayHtml"
        :style="{ background: iframeBg }"
        @load="attachInspector"
      />
      <div v-else class="empty">尚未生成 HTML</div>
      <div v-if="inspectMode" class="inspect-hint">调试模式：点击元素送入对话栏</div>
    </div>
  </div>
</template>

<style scoped>
.preview-wrap {
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  position: relative;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview-stage {
  transform-origin: center center;
  flex: 0 0 auto;
  position: relative;
}
.preview-stage iframe {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
.empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}
.inspect-hint {
  position: absolute;
  top: 8px;
  left: 8px;
  background: #e03131;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  box-shadow: 0 2px 6px rgba(224, 49, 49, 0.4);
  z-index: 10;
}
</style>
