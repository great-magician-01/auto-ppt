import { extractStringArg, toolLabel } from "../src/lib/toolUtils";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}

// 完整 JSON
assert(extractStringArg('{"html":"<div>hi</div>"}') === "<div>hi</div>", "完整 html 提取");
assert(extractStringArg('{"content":"## 标题\\n正文"}') === "## 标题\n正文", "转义 \\n 解析");

// 不完整（流式中途）
assert(extractStringArg('{"html":"<div>partial') === "<div>partial", "未闭合提取");
assert(extractStringArg('{"html":"') === "", "仅起始引号");
assert(extractStringArg('') === "", "空串");
assert(extractStringArg('{"html":123}') === "", "非字符串值返回空");

// unicode 转义
assert(extractStringArg('{"html":"\\u4e2d"}') === "中", "unicode 转义");

// toolLabel
assert(toolLabel("write_manuscript", { content: "x".repeat(10) }) === "📝 文案 · 10 字", "manuscript label");
assert(toolLabel("commit_outline", { slides: [1, 2, 3] }) === "🗂 大纲 · 3 页", "outline label");
assert(toolLabel("write_slide_html", {}, { index: 2 }) === "🎨 单页 HTML · 第 3 页", "slide label");
assert(toolLabel("apply_selfcheck", {}) === "🔍 自检改写", "selfcheck label");

console.log("\n全部通过");
