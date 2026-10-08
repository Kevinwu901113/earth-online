// Display names only: persisted node names and IDs remain unchanged.
const labels = {
  self: "自我",
  body: "身心",
  mind: "认知",
  practice: "实践",
  physical: "体能",
  sport: "运动",
  emotion: "情绪",
  attention: "专注",
  language: "语言",
  learning: "学习",
  logic: "逻辑",
  knowledge: "知识",
  information: "信息",
  communication: "沟通",
  life: "生活",
  finance: "财务",
  professional: "职业",
  art: "创作",
};
export function nodeLabel(node, parent) {
  if (labels[node.id]) return labels[node.id];
  let name = String(node.name ?? "").trim();
  if (Array.from(name).length <= 3) return name;
  if (parent?.name && name.startsWith(parent.name)) {
    const rest = name.slice(parent.name.length).trim();
    if (Array.from(rest).length >= 2) name = rest;
  }
  name = name.replace(/(?:能力|技能|方法|管理|训练|练习)$/, "");
  return Array.from(name || node.name)
    .slice(0, 3)
    .join("");
}
