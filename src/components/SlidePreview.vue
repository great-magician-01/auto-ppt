<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { SLIDE_W, SLIDE_H } from "../lib/prompt";

defineProps<{ html: string }>();
const wrap = ref<HTMLElement | null>(null);
const scale = ref(0);
let ro: ResizeObserver | null = null;

function update() {
  if (!wrap.value) return;
  const w = wrap.value.clientWidth;
  const h = wrap.value.clientHeight;
  // 双向 contain：取宽高各自比例的最小值，保证 1920×1080 完整装入不溢出
  scale.value = Math.min(w / SLIDE_W, h / SLIDE_H);
}
onMounted(() => {
  update();
  if (wrap.value) {
    ro = new ResizeObserver(update);
    ro.observe(wrap.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());
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
      <iframe v-if="html" :srcdoc="html" />
      <div v-else class="empty">尚未生成 HTML</div>
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
</style>
