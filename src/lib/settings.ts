import { db } from "./db";

export interface ApiSettings {
  api_base: string;
  api_key: string;
  model: string;
  thinking_mode: boolean; // 开/关
  thinking_effort: string; // "high" | "max"，仅开启时发送
}

export async function getSettings(): Promise<ApiSettings> {
  const d = await db();
  const rows = await d.select<{ key: string; value: string }[]>(
    "SELECT key, value FROM settings"
  );
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    api_base: map.api_base ?? "",
    api_key: map.api_key ?? "",
    model: map.model ?? "",
    thinking_mode: map.thinking_mode === "true",
    thinking_effort: map.thinking_effort || "high",
  };
}

export async function saveSettings(s: ApiSettings) {
  const d = await db();
  for (const [k, v] of Object.entries(s)) {
    await d.execute(
      `INSERT INTO settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [k, v]
    );
  }
}

export async function hasSettings(): Promise<boolean> {
  const { api_base, api_key, model } = await getSettings();
  return Boolean(api_base && api_key && model);
}

/** 模型列表缓存（settings 表 key=models），重开设置页时回填下拉。 */
export async function getModelsCache(): Promise<string[]> {
  const d = await db();
  const rows = await d.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'models'"
  );
  if (!rows.length) return [];
  try {
    return JSON.parse(rows[0].value) as string[];
  } catch {
    return [];
  }
}

export async function saveModelsCache(ids: string[]): Promise<void> {
  const d = await db();
  await d.execute(
    `INSERT INTO settings(key, value) VALUES('models', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(ids)]
  );
}
