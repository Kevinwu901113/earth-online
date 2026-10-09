import { z } from "zod";
import { outputSchemas } from "./schemas.js";

const messages = Object.freeze({
  model_unconfigured: "模型服务尚未配置；内容已保存，请配置后重试。",
  model_timeout: "模型执行超时；内容已保存，可重试。",
  model_execution_failed: "模型调用未完成；内容已保存，请稍后重试。",
  model_output_limit:
    "模型达到本次生成上限，尚未生成完整结果；内容已保存，可重试。",
  model_output_empty: "模型未返回可用结果；内容已保存，可重试。",
  output_json_invalid:
    "模型返回的内容不是完整 JSON，未生成可用结果；内容已保存，可重试。",
  output_schema_invalid:
    "模型返回的内容格式不符合要求，未生成可用结果；内容已保存，可重试。",
  intent_mismatch:
    "规划尚未符合你的本次意图或时间预算，未采用本次结果；内容已保存，可重试。",
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

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function pickFields(value, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(value, field))
      .map((field) => [field, value[field]]),
  );
}

// Guidance is display-only. Discard extra annotations without coercing known
// fields or admitting commands; the published model contract stays strict.
function projectGuidance(value) {
  if (!isObject(value)) return value;
  const guidance = pickFields(value, ["title", "summary", "steps", "sources"]);
  if (Array.isArray(guidance.steps))
    guidance.steps = guidance.steps.map((step) =>
      isObject(step)
        ? pickFields(step, ["title", "minutes", "kind", "detail"])
        : step,
    );
  return guidance;
}

export function verifiedSources(citations, retrieved) {
  const sources = new Map(retrieved.map((source) => [source.url, source]));
  return citations.map((citation) => {
    const source = sources.get(citation.url);
    if (!source)
      throw new AgentError("source_unverified", { phase: "validation" });
    const { retrievedAt: _modelTimestamp, ...fields } = citation;
    return {
      ...fields,
      title: (source.title || citation.title).slice(0, 200),
      ...(source.retrievedAt ? { retrievedAt: source.retrievedAt } : {}),
    };
  });
}

export function validateOutput(kind, value) {
  if (kind === "chat" && isObject(value) && Object.hasOwn(value, "guidance"))
    value = { ...value, guidance: projectGuidance(value.guidance) };
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

export function parseOutput(raw, details = {}) {
  let s = typeof raw === "string" ? raw.trim() : "";
  if (s.startsWith("```"))
    s = s.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(s);
  } catch (error) {
    // V8 may include excerpts of private output in its message. Keep only
    // numeric locations and a fixed category, never the exception message.
    const message = error.message;
    const offset = message.match(
      / at position (\d+)(?: \(line \d+ column \d+\))?$/,
    )?.[1];
    const category = /^(?:Unterminated string|Unexpected end)/.test(message)
      ? "unexpected_end"
      : /^Bad control character/.test(message)
        ? "unescaped_control"
        : /^Bad (?:escaped character|Unicode escape)/.test(message)
          ? "invalid_escape"
          : "invalid_syntax";
    throw new AgentError("output_json_invalid", {
      ...details,
      phase: "parse",
      json: {
        category,
        characters: s.length,
        ...(offset === undefined ? {} : { offset: Number(offset) }),
      },
    });
  }
}

// SDK resolution means the session became idle, not that the model completed.
// Check the documented event envelope before admitting any text to settlement.
export function outputFromRun(kind, result, generation = {}) {
  if (
    !result ||
    !Array.isArray(result.events) ||
    result.events.some((event) => !event || typeof event.type !== "string")
  )
    throw new AgentError("model_execution_failed", {
      phase: "completion",
      execution: { endReason: "unknown" },
    });
  const events = result.events;
  const ends = events.filter((e) => e.type === "turn/end");
  const last = events.findLast((e) => e.type === "assistant/message");
  const unfinished = ends.find((e) => e.data?.reason?.kind !== "completed");
  const reason = (unfinished ?? ends.at(-1))?.data?.reason?.kind;
  const knownReasons = [
    "completed",
    "max-tokens",
    "error",
    "aborted",
    "blocked",
  ];
  const content = last?.data?.message?.content;
  if (
    content !== undefined &&
    (!Array.isArray(content) ||
      content.some((block) => !block || typeof block.type !== "string"))
  )
    throw new AgentError("model_execution_failed", {
      phase: "completion",
      execution: { endReason: "unknown" },
    });
  const execution = {
    endReason: knownReasons.includes(reason) ? reason : "unknown",
    outputCharacters:
      typeof result.finalResponse === "string"
        ? result.finalResponse.length
        : 0,
    reasoningCharacters: (content ?? [])
      .filter((b) => b.type === "reasoning" && typeof b.text === "string")
      .reduce((sum, b) => sum + b.text.length, 0),
  };
  const tokens = last?.data?.usage?.outputTokens;
  if (Number.isSafeInteger(tokens) && tokens >= 0)
    execution.outputTokens = tokens;
  if (Number.isSafeInteger(generation.maxTokens) && generation.maxTokens > 0)
    execution.maxTokens = generation.maxTokens;
  if (["off", "low", "high", "max"].includes(generation.reasoningEffort))
    execution.reasoningEffort = generation.reasoningEffort;
  const details = { contract: `${kind}-v1`, execution };
  if (reason !== "completed")
    throw new AgentError(
      reason === "max-tokens" ? "model_output_limit" : "model_execution_failed",
      {
        ...details,
        phase: "completion",
      },
    );
  if (!execution.outputCharacters || !result.finalResponse.trim())
    throw new AgentError("model_output_empty", {
      ...details,
      phase: "completion",
    });
  return validateOutput(kind, parseOutput(result.finalResponse, details));
}

export function failureFor(error) {
  return error instanceof AgentError
    ? error.failure
    : {
        code: "internal_error",
        message: messages.internal_error,
      };
}
