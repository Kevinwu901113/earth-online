// Shared scoring keeps the file and PostgreSQL backends in the same lexical space.
export const CANDIDATE_LIMIT = 48;
export const LEXICAL_SCAN_LIMIT = 384;
export const CANDIDATES_PER_DOCUMENT = 3;
export const MIN_SEMANTIC_SCORE = 0.62;
const RRF_K = 60;
const stopWords = new Set(
  `我 我想 想 想要 希望 如何 怎么 怎样 什么 一个 这个 那个 自己 我们 你们 用户 请 请问 给我 帮我 可以 需要 已经 目前 现在 只有 每天 每周 今天 晚上 时间 分钟 小时 目标 计划 任务 行动 安排 建议 方法 情况 进行 提高 学习 练习 训练 准备
   a an the and or to of for in on with my me i we you is are be do want need help how what please goal goals plan planning task tasks action actions daily today time minutes minute hours hour week weeks improve learn learning practice training prepare`.split(
    /\s+/,
  ),
);
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
export const normalizeText = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .toLowerCase();
const escapeRegex = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const compareIds = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const isNameTerm = (term) => /[a-z]/.test(term);

export function termPattern(term) {
  const escaped = escapeRegex(term);
  return /[a-z0-9]/.test(term)
    ? `(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`
    : escaped;
}

export function buildQueryPlan(query, variants = []) {
  const groups = [];
  for (const value of [query, ...variants]) {
    // Independent clauses preserve a second intent without another model request.
    for (const clause of normalizeText(value)
      .split(/[\n。；;!?！？]+/)
      .filter(Boolean)
      .slice(0, 4)) {
      const terms = [];
      for (const item of segmenter.segment(clause)) {
        const term = item.segment.trim();
        if (!item.isWordLike || stopWords.has(term) || /^\d+$/.test(term))
          continue;
        if (/\p{Script=Han}/u.test(term) && Array.from(term).length < 2)
          continue;
        if (!terms.includes(term)) terms.push(term);
        if (terms.length === 12) break;
      }
      if (terms.length) groups.push(terms);
    }
  }
  // Round-robin clauses rather than letting a long first sentence use the budget.
  const terms = [];
  for (let position = 0; position < 12 && terms.length < 24; position++) {
    for (const group of groups) {
      if (group[position] && !terms.includes(group[position]))
        terms.push(group[position]);
      if (terms.length === 24) break;
    }
  }
  return {
    terms,
    groups: groups
      .map((g) => g.filter((t) => terms.includes(t)))
      .filter((g) => g.length),
    variants: variants.length,
  };
}

export function lexicalEvidence(candidate, plan) {
  const title = normalizeText(candidate.title);
  const tags = normalizeText((candidate.tags ?? []).join(" "));
  const body = normalizeText(candidate.text);
  const matchedTerms = [],
    bodyTerms = [];
  let nameMatches = 0,
    score = 0;
  for (const term of plan.terms) {
    const pattern = new RegExp(termPattern(term), "u");
    const inTitle = pattern.test(title),
      inTags = pattern.test(tags),
      inBody = pattern.test(body);
    if (inTitle || inTags || inBody) matchedTerms.push(term);
    if (inBody) bodyTerms.push(term);
    if (isNameTerm(term) && (inTitle || inTags)) nameMatches++;
    score += 4 * Number(inTitle) + 3 * Number(inTags) + Number(inBody);
  }
  const coverage = Math.max(
    0,
    ...plan.groups.map(
      (group) =>
        group.filter((term) => matchedTerms.includes(term)).length /
        group.length,
    ),
  );
  return {
    score,
    coverage,
    matchedTerms,
    bodyTerms,
    // One broad title word such as “证据” must not rescue a long geology query.
    // Latin names/code labels remain useful exact anchors (Anki, Python, A2).
    qualified: score > 0 && (nameMatches > 0 || coverage >= 0.34),
  };
}

export function rankLexicalCandidates(
  candidates,
  plan,
  limit = CANDIDATE_LIMIT,
) {
  return candidateWindow(
    candidates
      .map((candidate) => ({
        ...candidate,
        lexical: lexicalEvidence(candidate, plan),
      }))
      .filter((candidate) => candidate.lexical.qualified)
      .sort(
        (a, b) => b.lexical.score - a.lexical.score || compareIds(a.id, b.id),
      ),
    limit,
  );
}

export function candidateWindow(candidates, limit) {
  const counts = new Map(),
    window = [];
  for (const candidate of candidates) {
    const count = counts.get(candidate.documentId) ?? 0;
    if (count >= CANDIDATES_PER_DOCUMENT) continue;
    counts.set(candidate.documentId, count + 1);
    window.push(candidate);
    if (window.length === limit) break;
  }
  return window;
}

export function fuseCandidates(
  semantic,
  lexical,
  plan,
  { minSemanticScore = MIN_SEMANTIC_SCORE } = {},
) {
  const merged = new Map();
  const add = (candidate, weight, rank, channel) => {
    const previous = merged.get(candidate.id);
    const entry = previous ?? {
      ...candidate,
      lexical: lexicalEvidence(candidate, plan),
      semanticScore: null,
      fusionScore: 0,
      matchedBy: [],
    };
    if (channel === "semantic") entry.semanticScore = Number(candidate.score);
    if (channel === "lexical") entry.lexical = candidate.lexical;
    entry.fusionScore += weight / (RRF_K + rank + 1);
    entry.matchedBy.push(channel);
    merged.set(candidate.id, entry);
  };
  // Lexical evidence rescues exact names which the semantic top-window omitted.
  lexical.forEach((candidate, rank) => add(candidate, 1.5, rank, "lexical"));
  semantic
    .filter((candidate) => Number.isFinite(Number(candidate.score)))
    .forEach((candidate, rank) => {
      const evidence = lexicalEvidence(candidate, plan);
      if (evidence.qualified || Number(candidate.score) >= minSemanticScore)
        add(candidate, 1, rank, "semantic");
    });
  return [...merged.values()].sort(
    (a, b) =>
      b.fusionScore - a.fusionScore ||
      b.lexical.score - a.lexical.score ||
      compareIds(a.id, b.id),
  );
}

export function diverseCandidates(candidates) {
  const first = [],
    second = [],
    seen = new Set();
  let semanticOnly = 0;
  for (const candidate of candidates) {
    if (seen.has(candidate.documentId)) {
      second.push(candidate);
      continue;
    }
    if (!candidate.lexical.qualified && ++semanticOnly > 2) continue;
    seen.add(candidate.documentId);
    first.push(candidate);
  }
  // Every document gets one chance before any document gets a second excerpt.
  return [
    ...first,
    ...second.filter((candidate) => seen.has(candidate.documentId)),
  ];
}

export function matchedExcerpt(candidate, limit) {
  const runes = Array.from(candidate.text);
  const normalized = normalizeText(candidate.text);
  const positions = candidate.lexical.bodyTerms
    .map((term) => normalized.search(new RegExp(termPattern(term), "u")))
    .filter((position) => position >= 0)
    .map((position) => Array.from(normalized.slice(0, position)).length);
  const starts = [
    0,
    ...positions.map((position) => Math.max(0, position - 30)),
  ];
  const start = starts.sort(
    (a, b) =>
      positions.filter((p) => p >= b && p < b + limit).length -
        positions.filter((p) => p >= a && p < a + limit).length || a - b,
  )[0];
  let result = "";
  for (const rune of runes.slice(start)) {
    if (result.length + rune.length > limit) break;
    result += rune;
  }
  return result;
}
