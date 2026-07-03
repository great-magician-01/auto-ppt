-- 工具调用卡片：assistant 消息携带的工具调用摘要 JSON {name,label}；null 表示无工具调用
ALTER TABLE messages ADD COLUMN tool_call TEXT;
