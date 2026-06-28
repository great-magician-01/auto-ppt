-- 多 AI 配置：每条一个独立的 API 配置；enabled 单选（同一时刻至多一条为 1）
CREATE TABLE IF NOT EXISTS ai_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_base TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'openai',
  multimodal INTEGER NOT NULL DEFAULT 0,
  thinking_mode INTEGER NOT NULL DEFAULT 0,
  thinking_effort TEXT NOT NULL DEFAULT 'high',
  enabled INTEGER NOT NULL DEFAULT 0,
  models_cache TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
