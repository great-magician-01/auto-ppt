import { db } from "./db";

export type AiFormat = "openai" | "anthropic";

export interface AiConfig {
  id?: number;
  name: string;
  api_base: string;
  api_key: string;
  model: string;
  format: AiFormat;
  multimodal: boolean;
  thinking_mode: boolean;
  thinking_effort: string; // "high" | "max"
  enabled: boolean;
  models_cache?: string[];
}

interface AiConfigRow {
  id: number;
  name: string;
  api_base: string;
  api_key: string;
  model: string;
  format: string;
  multimodal: number;
  thinking_mode: number;
  thinking_effort: string;
  enabled: number;
  models_cache: string | null;
}

function rowToConfig(r: AiConfigRow): AiConfig {
  let models_cache: string[] = [];
  if (r.models_cache) {
    try {
      models_cache = JSON.parse(r.models_cache) as string[];
    } catch {
      models_cache = [];
    }
  }
  return {
    id: r.id,
    name: r.name,
    api_base: r.api_base,
    api_key: r.api_key,
    model: r.model,
    format: (r.format === "anthropic" ? "anthropic" : "openai") as AiFormat,
    multimodal: !!r.multimodal,
    thinking_mode: !!r.thinking_mode,
    thinking_effort: r.thinking_effort || "high",
    enabled: !!r.enabled,
    models_cache,
  };
}

export async function listAiConfigs(): Promise<AiConfig[]> {
  const d = await db();
  const rows = await d.select<AiConfigRow[]>(
    "SELECT * FROM ai_configs ORDER BY id ASC"
  );
  return rows.map(rowToConfig);
}

export async function getActiveAi(): Promise<AiConfig | null> {
  const d = await db();
  const rows = await d.select<AiConfigRow[]>(
    "SELECT * FROM ai_configs WHERE enabled = 1 ORDER BY id ASC LIMIT 1"
  );
  return rows.length ? rowToConfig(rows[0]) : null;
}

export async function saveAiConfig(c: AiConfig): Promise<number> {
  const d = await db();
  const cacheJson = c.models_cache ? JSON.stringify(c.models_cache) : null;
  if (c.id) {
    await d.execute(
      `UPDATE ai_configs SET name=?, api_base=?, api_key=?, model=?, format=?, multimodal=?, thinking_mode=?, thinking_effort=?, models_cache=? WHERE id=?`,
      [
        c.name,
        c.api_base,
        c.api_key,
        c.model,
        c.format,
        c.multimodal ? 1 : 0,
        c.thinking_mode ? 1 : 0,
        c.thinking_effort,
        cacheJson,
        c.id,
      ]
    );
    return c.id;
  }
  const r = await d.execute(
    `INSERT INTO ai_configs(name, api_base, api_key, model, format, multimodal, thinking_mode, thinking_effort, models_cache) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.name,
      c.api_base,
      c.api_key,
      c.model,
      c.format,
      c.multimodal ? 1 : 0,
      c.thinking_mode ? 1 : 0,
      c.thinking_effort,
      cacheJson,
    ]
  );
  return Number(r.lastInsertId);
}

export async function deleteAiConfig(id: number): Promise<void> {
  const d = await db();
  await d.execute("DELETE FROM ai_configs WHERE id = ?", [id]);
}

export async function setActiveAi(id: number): Promise<void> {
  const d = await db();
  // 单选：先全置 0 再置目标 1（两句同一连接，近似事务）
  await d.execute("UPDATE ai_configs SET enabled = 0");
  await d.execute("UPDATE ai_configs SET enabled = 1 WHERE id = ?", [id]);
}

export async function getModelsCache(id: number): Promise<string[]> {
  const d = await db();
  const rows = await d.select<{ models_cache: string | null }[]>(
    "SELECT models_cache FROM ai_configs WHERE id = ?",
    [id]
  );
  if (!rows.length || !rows[0].models_cache) return [];
  try {
    return JSON.parse(rows[0].models_cache) as string[];
  } catch {
    return [];
  }
}

export async function saveModelsCache(id: number, ids: string[]): Promise<void> {
  const d = await db();
  await d.execute(
    "UPDATE ai_configs SET models_cache = ? WHERE id = ?",
    [JSON.stringify(ids), id]
  );
}

/**
 * 旧数据兼容：ai_configs 为空 且 settings 表存在非空 api_base 时，
 * 建一条 format=openai / enabled=1 的记录（旧数据本就按 OpenAI 格式工作）。
 * 启动时调用一次；已导入过则不再触发。
 */
export async function ensureLegacyImport(): Promise<void> {
  const d = await db();
  const cnt = await d.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM ai_configs"
  );
  if (cnt[0]?.n) return; // 表非空，已导入过
  const rows = await d.select<{ key: string; value: string }[]>(
    "SELECT key, value FROM settings"
  );
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  if (!map.api_base) return; // 无旧配置
  let models_cache: string[] = [];
  if (map.models) {
    try {
      models_cache = JSON.parse(map.models) as string[];
    } catch {
      models_cache = [];
    }
  }
  await d.execute(
    `INSERT INTO ai_configs(name, api_base, api_key, model, format, multimodal, thinking_mode, thinking_effort, enabled, models_cache)
     VALUES(?, ?, ?, ?, 'openai', 0, ?, ?, 1, ?)`,
    [
      map.model ? map.model : "默认 AI",
      map.api_base,
      map.api_key ?? "",
      map.model ?? "",
      map.thinking_mode === "true" ? 1 : 0,
      map.thinking_effort || "high",
      models_cache.length ? JSON.stringify(models_cache) : null,
    ]
  );
}

// ---- app 级纯开关（settings 表 key-value），如 auto_selfcheck ----
export async function getSetting(key: string): Promise<string | null> {
  const d = await db();
  const rows = await d.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = ?",
    [key]
  );
  return rows.length ? rows[0].value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const d = await db();
  await d.execute(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}
