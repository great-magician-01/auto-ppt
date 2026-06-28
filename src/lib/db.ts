import Database from "@tauri-apps/plugin-sql";

let _db: Database | null = null;

export async function db(): Promise<Database> {
  if (!_db) {
    _db = await Database.load("sqlite:auto_ppt.db");
  }
  return _db;
}

export interface Project {
  id?: number;
  title: string;
  topic: string;
  style?: string | null;
  design_tokens?: string | null;
  theme_css?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Slide {
  id?: number;
  project_id: number;
  sort: number;
  title?: string | null;
  outline?: string | null;
  html_content?: string | null;
  image_path?: string | null;
  updated_at?: string;
}

export type ChatRole = "system" | "user" | "assistant";

export interface Message {
  id?: number;
  project_id: number;
  slide_id?: number | null;
  role: ChatRole;
  content: string;
  /** 思考过程（仅助手完成消息可能附带，由生成/对话结束时回填） */
  reasoning?: string | null;
  created_at?: string;
}

// ---- projects ----
export async function listProjects(): Promise<Project[]> {
  const d = await db();
  return d.select<Project[]>("SELECT * FROM projects ORDER BY updated_at DESC");
}

export async function getProject(id: number): Promise<Project | null> {
  const d = await db();
  const rows = await d.select<Project[]>("SELECT * FROM projects WHERE id = ?", [id]);
  return rows[0] ?? null;
}

export async function createProject(
  title: string,
  topic: string,
  style?: string | null
): Promise<number> {
  const d = await db();
  const r = await d.execute(
    "INSERT INTO projects(title, topic, style) VALUES(?, ?, ?)",
    [title, topic, style ?? null]
  );
  return Number(r.lastInsertId);
}

export async function updateProject(
  id: number,
  fields: Partial<Pick<Project, "title" | "design_tokens" | "theme_css" | "style">>
) {
  const d = await db();
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  await d.execute(`UPDATE projects SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, vals);
}

// ---- slides ----
export async function listSlides(projectId: number): Promise<Slide[]> {
  const d = await db();
  return d.select<Slide[]>(
    "SELECT * FROM slides WHERE project_id = ? ORDER BY sort ASC",
    [projectId]
  );
}

export async function upsertSlide(slide: Slide): Promise<number> {
  const d = await db();
  if (slide.id) {
    await d.execute(
      `UPDATE slides SET title=?, outline=?, html_content=?, image_path=?, sort=?, updated_at=datetime('now') WHERE id=?`,
      [slide.title, slide.outline, slide.html_content, slide.image_path, slide.sort, slide.id]
    );
    return slide.id;
  }
  const r = await d.execute(
    "INSERT INTO slides(project_id, sort, title, outline, html_content) VALUES(?, ?, ?, ?, ?)",
    [slide.project_id, slide.sort, slide.title, slide.outline, slide.html_content]
  );
  return Number(r.lastInsertId);
}

export async function deleteSlide(id: number) {
  const d = await db();
  await d.execute("DELETE FROM slides WHERE id = ?", [id]);
}

export async function getFirstSlide(projectId: number): Promise<Slide | null> {
  const d = await db();
  const rows = await d.select<Slide[]>(
    "SELECT * FROM slides WHERE project_id = ? ORDER BY sort ASC LIMIT 1",
    [projectId]
  );
  return rows[0] ?? null;
}

// ---- messages ----
export async function listMessages(projectId: number): Promise<Message[]> {
  const d = await db();
  return d.select<Message[]>(
    "SELECT * FROM messages WHERE project_id = ? ORDER BY id ASC",
    [projectId]
  );
}

/** 单页会话：该幻灯片的全部消息（生成完成简述 + 对话修改），按时间序。 */
export async function listSlideMessages(slideId: number): Promise<Message[]> {
  const d = await db();
  return d.select<Message[]>(
    "SELECT * FROM messages WHERE slide_id = ? ORDER BY id ASC",
    [slideId]
  );
}

/** 项目级会话（slide_id 为空，如大纲生成/修改完成的提示），用于大纲工作台。 */
export async function listProjectMessages(projectId: number): Promise<Message[]> {
  const d = await db();
  return d.select<Message[]>(
    "SELECT * FROM messages WHERE project_id = ? AND slide_id IS NULL ORDER BY id ASC",
    [projectId]
  );
}

export async function addMessage(
  projectId: number,
  role: ChatRole,
  content: string,
  slideId?: number | null,
  reasoning?: string | null
) {
  const d = await db();
  await d.execute(
    "INSERT INTO messages(project_id, slide_id, role, content, reasoning) VALUES(?, ?, ?, ?, ?)",
    [projectId, slideId ?? null, role, content, reasoning ?? null]
  );
}

// ---- exports ----
export async function addExport(projectId: number, path: string) {
  const d = await db();
  await d.execute("INSERT INTO exports(project_id, pptx_path) VALUES(?, ?)", [projectId, path]);
}
