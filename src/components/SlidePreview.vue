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

async function reloadIframe() {
  await nextTick();
  attachInspector();
}

onMounted(() => {
  update();
  if (wrap.value) {
    ro = new ResizeObserver(update);
    ro.observe(wrap.value);
  }
  reloadIframe();
});
onBeforeUnmount(() => {
  ro?.disconnect();
  const doc = iframeEl.value?.contentDocument;
  doc?.removeEventListener("click", onClick as EventListener, true);
});
watch(() => props.html, reloadIframe);
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
      <iframe v-if="html" ref="iframeEl" :srcdoc="html" />
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
  padding: 2px 8px;
  border-radius: 4px;
  z-index: 10;
}
</style>
