<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";
import Icon from "./components/Icon.vue";
</script>

<template>
  <div class="app">
    <header class="topbar">
      <RouterLink to="/projects" class="brand">
        <svg
          class="brand-mark"
          width="20"
          height="20"
          viewBox="0 0 1024 1024"
          fill="none"
          aria-hidden="true"
        >
          <rect x="0" y="0" width="1024" height="1024" rx="224" fill="url(#bm-bg)" />
          <rect x="288" y="340" width="540" height="420" rx="44" fill="#c2cbef" />
          <rect x="248" y="300" width="540" height="420" rx="44" fill="#ffffff" />
          <rect x="298" y="358" width="440" height="72" rx="20" fill="#3b5bdb" />
          <rect x="298" y="482" width="392" height="34" rx="17" fill="#d7dce8" />
          <rect x="298" y="548" width="330" height="34" rx="17" fill="#d7dce8" />
          <rect x="298" y="614" width="248" height="34" rx="17" fill="#d7dce8" />
          <path
            d="M778,168 Q778,250 696,250 Q778,250 778,332 Q778,250 860,250 Q778,250 778,168 Z"
            fill="url(#bm-spark)"
          />
          <path
            d="M778,214 Q778,250 742,250 Q778,250 778,286 Q778,250 814,250 Q778,250 778,214 Z"
            fill="#ffffff"
            opacity="0.85"
          />
          <defs>
            <linearGradient id="bm-bg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#4263eb" />
              <stop offset="1" stop-color="#2f49c0" />
            </linearGradient>
            <linearGradient id="bm-spark" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#9d6bff" />
              <stop offset="1" stop-color="#7B2FF7" />
            </linearGradient>
          </defs>
        </svg>
        <span>纸光幻演</span>
      </RouterLink>
      <nav>
        <RouterLink to="/projects">
          <Icon name="folder" :size="15" />
          <span>项目</span>
        </RouterLink>
        <RouterLink to="/settings">
          <Icon name="settings" :size="15" />
          <span>设置</span>
        </RouterLink>
      </nav>
    </header>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.topbar {
  height: 52px;
  flex: 0 0 52px;
  display: flex;
  align-items: center;
  padding: 0 20px;
  gap: 24px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.5px;
  color: var(--primary) !important;
}
.brand-mark {
  flex: 0 0 auto;
  border-radius: 5px;
  box-shadow: 0 1px 4px rgba(59, 91, 219, 0.35);
}
.topbar nav {
  display: flex;
  gap: 4px;
}
.topbar nav a {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  padding: 5px 12px;
  border-radius: 8px;
  transition: all 0.15s ease;
}
.topbar nav a:hover {
  background: #f0f2f5;
  color: var(--text);
}
.topbar nav a.router-link-active {
  color: var(--primary);
  background: var(--primary-soft);
  font-weight: 600;
}
.content {
  flex: 1;
  overflow: auto;
}
</style>
