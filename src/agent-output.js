import { z } from "zod";
import { outputSchemas } from "./schemas.js";

const messages = Object.freeze({
  model_unconfigured: "模型服务尚未配置；内容已保存，请配置后重试。",
  model_timeout: "模型执行超时；内容已保存，可重试。",
  model_execution_failed: "模型调用未完成；内容已保存，请稍后重试。",
  output_json_invalid:
    "模型返回的内容不是完整 JSON，未生成可用结果；内容已保存，可重试。",
  output_schema_invalid:
    "模型返回的内容格式不符合要求，未生成可用结果；内容已保存，可重试。",
  source_unverified:
    "路线引用了未经检索确认的来源，未采用本次结果；可重新规划。",
  job_interrupted: "执行中断，结果未提交；原始内容已保留，请重试。",
  internal_error:
    "处理未完成；内容已保存，请重试。若仍失败，请提供任务编号排查。",
});

export class AgentError extends Error {
  constructor(code, details = {}) {
    super(messages[code]);
    this.name = "AgentError";
    this.failure = { code, message: messages[code], ...details };
  }
}

export function outputContract(kind) {
  const schema = outputSchemas[kind];
  if (!schema) throw new Error("Unknown agent job kind");
  return z.toJSONSchema(schema, { io: "input" });
}

export function outputInstruction(kind) {
  return (
    "\n输出契约（必须满足全部字段类型、长度、枚举和额外字段限制）：\n" +
    JSON.stringify(outputContract(kind))
  );
}

const typeOf = (value) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

// Allow only schema-owned property names in diagnostics. Never retain values,
// model text, arbitrary object keys, Zod messages, or provider exception bodies.
function fieldNames(schema, names = new Set()) {
  if (!schema || typeof schema !== "object") return names;
  for (const key of Object.keys(schema.properties ?? {})) names.add(key);
  for (const child of Object.values(schema)) {
    if (Array.isArray(child)) child.forEach((s) => fieldNames(s, names));
    else if (child && typeof child === "object") fieldNames(child, names);
  }
  return names;
}

export function validateOutput(kind, value) {
  const parsed = outputSchemas[kind].safeParse(value);
  if (parsed.success) return parsed.data;
  const names = fieldNames(outputContract(kind));
  const issues = parsed.error.issues.slice(0, 20).map((issue) => {
    const path = issue.path.map((p) =>
      typeof p === "number" ? p : names.has(p) ? p : "*",
    );
    let received = value;
    for (const part of issue.path) received = received?.[part];
    const safe = { path, code: issue.code, received: typeOf(received) };
    if (
      [
        "string",
        "number",
        "int",
        "object",
        "array",
        "boolean",
        "null",
      ].includes(issue.expected)
    )
      safe.expected = issue.expected;
    for (const key of ["minimum", "maximum"])
      if (Number.isFinite(issue[key])) safe[key] = issue[key];
    if (typeof received === "string" || Array.isArray(received))
      safe.length = received.length;
    return safe;
  });
  throw new AgentError("output_schema_invalid", {
    phase: "validation",
    contract: `${kind}-v1`,
    issues,
    issueCount: parsed.error.issues.length,
  });
}

export function parseOutput(raw) {
  try {
    let s = raw.trim();
    if (s.startsWith("```"))
      s = s.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    return JSON.parse(s);
  } catch {
    throw new AgentError("output_json_invalid", { phase: "parse" });
  }
}

export function failureFor(error) {
  return error instanceof AgentError
    ? error.failure
    : {
        code: "internal_error",
        message: messages.internal_error,
      };
}
