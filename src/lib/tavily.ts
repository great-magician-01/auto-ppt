import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "./aiConfig";

export interface TavilyResult {
  answer: string;
  results: { title: string; url: string; content: string }[];
  credits: number;
}

export interface TavilyExtract {
  results: { url: string; raw_content: string }[];
  failed: { url: string; raw_content: string }[];
  credits: number;
}

export async function getTavilyKey(): Promise<string | null> {
  return getSetting("tavily_api_key");
}

export async function setTavilyKey(v: string): Promise<void> {
  await setSetting("tavily_api_key", v);
}

export async function tavilySearch(apiKey: string, query: string): Promise<TavilyResult> {
  return invoke<TavilyResult>("tavily_search", {
    config: { api_key: apiKey },
    query,
  });
}

export async function tavilyExtract(
  apiKey: string,
  urls: string[]
): Promise<TavilyExtract> {
  return invoke<TavilyExtract>("tavily_extract", {
    config: { api_key: apiKey },
    urls: urls.slice(0, 3), // 上限 3/次
  });
}

// ---- 用量记录（settings.tavily_usage，JSON 字符串）----
export interface TavilyUsage {
  searchCalls: number;
  extractCalls: number;
  extractUrls: number;
  credits: number;
}

const EMPTY: TavilyUsage = { searchCalls: 0, extractCalls: 0, extractUrls: 0, credits: 0 };

export async function getTavilyUsage(): Promise<TavilyUsage> {
  const raw = await getSetting("tavily_usage");
  if (!raw) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<TavilyUsage>) };
  } catch {
    return { ...EMPTY };
  }
}

async function saveUsage(u: TavilyUsage): Promise<void> {
  await setSetting("tavily_usage", JSON.stringify(u));
}

export async function recordTavilySearch(credits: number): Promise<TavilyUsage> {
  const u = await getTavilyUsage();
  u.searchCalls += 1;
  u.credits += credits;
  await saveUsage(u);
  return u;
}

export async function recordTavilyExtract(
  credits: number,
  urls: number
): Promise<TavilyUsage> {
  const u = await getTavilyUsage();
  u.extractCalls += 1;
  u.extractUrls += urls;
  u.credits += credits;
  await saveUsage(u);
  return u;
}

export async function resetTavilyUsage(): Promise<void> {
  await saveUsage({ ...EMPTY });
}
