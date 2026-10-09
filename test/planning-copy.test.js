import test from "node:test";
import assert from "node:assert/strict";
import { planningText } from "../public/planning-copy.js";
const screenshotCopy =
  "每天30分钟，按3阶段推进：先练刀工切丝切丁，再对比火力，最后独立做出一道家常菜。假设你已有基本厨具与一把菜刀，每天能留出30分钟。未检索到公开认证标准（标准位留空）；外部学习资源检索服务不可用，故资料存在缺口，本路线仅引用知识库规划参考，且知识库检索不等于能力评估。";
test("legacy route hides internal diagnoses while keeping actionable steps and actual conditions", () => {
  assert.equal(
    planningText(screenshotCopy),
    "每天30分钟，按3阶段推进：先练刀工切丝切丁，再对比火力，最后独立做出一道家常菜。假设你已有基本厨具与一把菜刀，每天能留出30分钟。",
  );
  assert.equal(
    planningText("先练切丝，外部学习资源检索服务不可用。"),
    "先练切丝。",
  );
  assert.equal(
    planningText("外部学习资源检索服务不可用。故资料存在缺口。准备一把菜刀。"),
    "准备一把菜刀。",
  );
});
test("real missing materials, personal evaluation and knowledge-tool learning stay visible", () => {
  for (const text of [
    "请先准备一篇你能打开的英语短文，或告诉我已有的教材。",
    "假设你有菜刀和砧板；如果没有，先准备厨具。",
    "知识库查询练习：运行Python程序，检查报错，再调整索引。",
    "这次回答缺少三个要点，请补充后再提交。",
    "如果你追求职业认证，请确认考试报名条件。",
    "搜索网页，记录你找到的三个可靠来源。",
  ])
    assert.equal(planningText(text), text);
});
test("empty diagnostic-only copy uses only the caller fallback and leaves input unchanged", () => {
  const stored = { summary: "知识库检索不等于能力评估。" };
  assert.equal(
    planningText(stored.summary, "按阶段逐步练习。"),
    "按阶段逐步练习。",
  );
  assert.equal(planningText(stored.summary), "");
  assert.equal(stored.summary, "知识库检索不等于能力评估。");
});
