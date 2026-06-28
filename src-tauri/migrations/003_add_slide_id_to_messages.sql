-- 给消息加 slide_id：每页独立会话（NULL = 项目级，如大纲生成完成的提示）
ALTER TABLE messages ADD COLUMN slide_id INTEGER;
