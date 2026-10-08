export function skillFixture(job, context) {
  const g = context.goals[0],
    id = "learning_method",
    exists = context.personalTree.nodes.some((n) => n.id === id);
  return {
    treePatch: {
      schemaVersion: "earth.tree.patch.v1",
      baseRevision: context.personalTree.revision,
      requestId: job.id,
      goalId: context.skillGoalId,
      addNodes: exists
        ? []
        : [
            {
              id,
              name: "自主学习",
              description: "持续学习与复习的能力",
              icon: "knowledge",
              kind: "ability",
              parentId: "learning",
              prerequisites: [],
              baseline: { status: "unlit", basis: "unknown", quote: null },
              stat: 0,
              milestone: null,
            },
          ],
      reuseNodeIds: exists ? [id] : [],
      updateNodes: [],
    },
    plan: {
      schemaVersion: "earth.plan.v3",
      goal: { title: g.title, target: g.criterion, minutes: g.minutes },
      summary: "测试学习安排",
      assumptions: [],
      targetSkillIds: [id],
      strategy: [
        {
          name: "学习",
          skillIds: [id],
          approach: "复习当前主题",
          timing: "今天",
        },
      ],
      resources: [],
      tasks: [
        {
          id: "study",
          name: "整理要点",
          skillIds: [id],
          minutes: 5,
          stat: 0,
          purpose: "学习",
          resourceIds: [],
          readiness: "ready",
          materialQuestion: null,
          actions: [{ name: "整理要点", minutes: 5, detail: "写下三个要点。" }],
        },
      ],
    },
  };
}
