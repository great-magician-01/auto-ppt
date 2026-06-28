import { createRouter, createWebHistory } from "vue-router";

const routes = [
  { path: "/", redirect: "/projects" },
  {
    path: "/projects",
    name: "projects",
    component: () => import("./pages/ProjectList.vue"),
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("./pages/Settings.vue"),
  },
  {
    path: "/outline/:id",
    name: "outline",
    component: () => import("./pages/Outline.vue"),
    props: true,
  },
  {
    path: "/editor/:id",
    name: "editor",
    component: () => import("./pages/Editor.vue"),
    props: true,
  },
];

export default createRouter({
  history: createWebHistory(),
  routes,
});
