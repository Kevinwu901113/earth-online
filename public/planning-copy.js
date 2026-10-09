// Presentation only: keep the stored route, criteria, commands and evidence intact.
const internalDiagnostics = [
  /(?:外部(?:学习)?资源|学习资源|搜索|检索)(?:检索)?(?:服务|工具|功能).{0,12}(?:不可用|未启用|未配置|无法使用|调用失败|未开放)/iu,
  /(?:未|没有|尚未|无法).{0,8}(?:检索到|找到|获得).{0,12}(?:公开|公共)(?:认证)?标准/iu,
  /(?:standardId|standardVersion|标准(?:字段|位)).{0,8}(?:留空|为空|null|空值)/iu,
  /知识库(?:检索|规划参考|参考).{0,18}(?:不等于|不代表|不能替代|并非).{0,12}(?:能力评估|认证|能力认证)/iu,
  /(?:本路线|本计划|本方案|本次规划|该路线).{0,10}(?:仅|只).{0,8}(?:引用|参考|使用).{0,8}知识库/iu,
  /(?:检索不可用|检索无命中|未检索到来源|无检索来源|未找到检索来源)/iu,
  /(?:earth_(?:search|knowledge|standards)|context\.knowledge|DSH|SDK|JSON\s*Schema).{0,20}(?:不可用|未配置|未启用|校验|约束|字段|返回)/iu,
  /external (?:resource|learning resource|search|retrieval).{0,25}(?:unavailable|not configured)/iu,
];
const consequence =
  /^(?:故|因此|所以|且|并且|同时|本路线|该路线|本次).{0,15}(?:资料(?:存在)?缺口|资料不足|知识库|认证标准|标准位)/u;

export function planningText(value, fallback = "") {
  const text = String(value ?? "");
  let removed = false;
  let priorDiagnostic = false;
  const sentences = text.split(/(?<=[。！？；;\n])/u).map((sentence) => {
    let diagnostic = priorDiagnostic;
    const clauses = sentence.split(/(?<=[，,])/u).filter((clause) => {
      const content = clause.replace(/^[\s#*>]+/u, "");
      if (
        internalDiagnostics.some((pattern) => pattern.test(content)) ||
        (diagnostic && consequence.test(content))
      ) {
        diagnostic = true;
        removed = true;
        return false;
      }
      diagnostic = false;
      return true;
    });
    priorDiagnostic = diagnostic;
    const result = clauses.join("");
    if (
      clauses.length &&
      clauses.length < sentence.split(/(?<=[，,])/u).length
    ) {
      const ending = sentence.match(/[。！？；;\n]\s*$/u)?.[0] ?? "。";
      return result.replace(/[，,]\s*$/u, ending);
    }
    return result;
  });
  const result = removed ? sentences.join("").trim() : text;
  return result.trim() ? result : fallback;
}
