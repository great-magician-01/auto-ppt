-- 思考内容持久化：把每次生成/对话完成时的 reasoning（思考过程）挂到对应助手消息上
ALTER TABLE messages ADD COLUMN reasoning TEXT;
