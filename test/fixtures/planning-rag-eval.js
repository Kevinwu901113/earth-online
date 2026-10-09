export const evaluationDocuments = [
  {
    id: "generic",
    title: "泛用规划模板",
    content: "把目标拆成小任务，每天记录进度。",
    tags: ["规划"],
  },
  {
    id: "anki",
    title: "Anki 卡片间隔复习",
    content: "用 Anki 制作问题卡片，先回忆答案，再核对。隔天复习困难卡片。",
    tags: ["Anki", "间隔复习"],
  },
  {
    id: "python",
    title: "Python 函数练习",
    content: "使用 Python 写带参数和返回值的函数，测试边界输入。",
    tags: ["Python", "编程"],
  },
  {
    id: "interview",
    title: "面试行为问题",
    content: "面试时用具体经历说明自己的职责、行动和结果。",
    tags: ["面试", "求职"],
  },
  {
    id: "reading",
    title: "英语阅读",
    content: "英语阅读时先找段落主旨，再用自己的话概括证据。",
    tags: ["英语", "阅读"],
  },
  {
    id: "exercise",
    title: "锻炼起步",
    content: "锻炼从能轻松完成的活动开始，观察疲劳，再逐步增加。",
    tags: ["锻炼", "运动"],
  },
].map((doc) => ({ ...doc, url: "https://example.test/reference/" + doc.id }));

export const evaluationQueries = [
  { name: "exact-product", query: "Anki", expected: ["anki"] },
  { name: "english-tool", query: "Python", expected: ["python"] },
  { name: "chinese-topic", query: "面试", expected: ["interview"] },
  {
    name: "two-intents",
    query: "英语阅读\n锻炼",
    expected: ["reading", "exercise"],
  },
  { name: "out-of-domain", query: "火星矿石开采", expected: [] },
];

export const axis = (position) =>
  Array.from({ length: 512 }, (_, index) => Number(index === position));
// Deliberately misleading broad semantic match: names must be rescued by lexical evidence.
export const evaluationEmbedding = {
  key: "evaluation-misleading-semantic-512",
  async embed(text, { query = false } = {}) {
    if (query) return axis(text.includes("火星") ? 2 : 0);
    if (text.startsWith("泛用规划模板")) return axis(0);
    const vector = axis(1);
    vector[0] = 0.1;
    vector[1] = Math.sqrt(0.99);
    return vector;
  },
};
