-- 文案先行：完整文案存 projects.manuscript；联网搜索开关存 projects.search_enabled
ALTER TABLE projects ADD COLUMN manuscript TEXT;
ALTER TABLE projects ADD COLUMN search_enabled INTEGER NOT NULL DEFAULT 0;
