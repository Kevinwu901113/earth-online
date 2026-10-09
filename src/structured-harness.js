// The SDK's idle result is not a schema guarantee. Own generation, validation,
// repair, cancellation and the total deadline above the provider transport.
const repairCodes = new Set([
  "output_json_invalid",
  "output_schema_invalid",
  "intent_mismatch",
]);
const issueCodes = new Set([
  "invalid_type",
  "too_small",
  "too_big",
  "invalid_format",
  "invalid_value",
  "unrecognized_keys",
  "invalid_union",
  "custom",
  "invalid_key",
  "invalid_element",
  "intent_requires_clarification",
  "planning_requires_visual_guidance",
  "guidance_over_budget",
  "command_not_requested",
  "target_not_available",
  "target_mismatch",
  "route_over_budget",
  "action_over_budget",
  "tree_contract_invalid",
  "goal_contract_mismatch",
]);
const types = new Set([
  "string",
  "number",
  "int",
  "object",
  "array",
  "boolean",
  "null",
  "undefined",
]);
const fields = (schema, names = new Set()) => {
  if (!schema || typeof schema !== "object") return names;
  for (const name of Object.keys(schema.properties ?? {})) names.add(name);
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach((child) => fields(child, names));
    else if (value && typeof value === "object") fields(value, names);
  }
  return names;
};

export function repairFeedback(failure, contract) {
  const names = fields(contract);
  const feedback = {
    code: repairCodes.has(failure?.code)
      ? failure.code
      : "output_schema_invalid",
  };
  if (Array.isArray(failure?.issues))
    feedback.issues = failure.issues.slice(0, 20).map((value) => {
      const issue = value && typeof value === "object" ? value : {};
      const safe = {
        path: (Array.isArray(issue.path) ? issue.path : [])
          .slice(0, 20)
          .map((part) =>
            Number.isSafeInteger(part) && part >= 0 && part <= 1000000
              ? part
              : names.has(part)
                ? part
                : "*",
          ),
        code: issueCodes.has(issue.code) ? issue.code : "custom",
      };
      for (const key of ["received", "expected"])
        if (types.has(issue[key])) safe[key] = issue[key];
      for (const key of ["minimum", "maximum", "length"])
        if (Number.isFinite(issue[key])) safe[key] = issue[key];
      return safe;
    });
  if (
    [
      "unexpected_end",
      "unescaped_control",
      "invalid_escape",
      "invalid_syntax",
    ].includes(failure?.json?.category)
  )
    feedback.json = { category: failure.json.category };
  return feedback;
}

export async function runStructuredHarness({
  prompt,
  contract,
  createHarness,
  decode,
  finalize,
  validate,
  errorClass,
  sessionId,
  timeoutMs,
  signal,
  maxAttempts = 3,
  onAttempt,
}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3)
    throw new TypeError("Harness attempts must be between one and three");
  const started = performance.now();
  const controller = new AbortController();
  let active,
    interrupted,
    rejectInterrupted,
    timer,
    attempts = 0,
    feedback;
  const interruption = new Promise((_, reject) => {
    rejectInterrupted = reject;
  });
  // Attach a handler even when cancellation precedes the first async operation.
  interruption.catch(() => {});
  const stop = (code) => {
    if (interrupted) return;
    interrupted = new errorClass(code, { phase: "execution" });
    controller.abort();
    void Promise.resolve()
      .then(() => active?.close())
      .catch(() => {});
    rejectInterrupted(interrupted);
  };
  const aborted = () => stop("job_interrupted");
  const bounded = async (operation) => {
    if (interrupted) throw interrupted;
    const result = await Promise.race([
      Promise.resolve().then(operation),
      interruption,
    ]);
    if (interrupted) throw interrupted;
    return result;
  };
  const close = async (harness) => {
    // SDK teardown has its own EOF/TERM/KILL bounds. Never start a replacement
    // alongside a runtime whose teardown failed or did not finish.
    let cleanupTimer;
    try {
      await Promise.race([
        Promise.resolve().then(() => harness.close()),
        new Promise((_, reject) => {
          cleanupTimer = setTimeout(
            () =>
              reject(
                new errorClass("model_execution_failed", { phase: "cleanup" }),
              ),
            4000,
          );
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
  };
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  timer = setTimeout(
    () => stop("model_timeout"),
    Math.max(0, Math.ceil(timeoutMs)),
  );
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      active = await bounded(() =>
        createHarness(attempt, {
          signal: controller.signal,
          remainingMs: Math.max(0, timeoutMs - (performance.now() - started)),
        }),
      );
      let failure, output;
      try {
        const input =
          prompt +
          (feedback
            ? "\n应用校验未通过。基于完全相同的原始资料重新生成完整结果，不改变用户目标、预算或已知事实；纠正以下脱敏错误，并严格满足原输出契约。只输出完整 JSON：\n" +
              JSON.stringify(feedback)
            : "");
        const result = await bounded(() => {
          if (interrupted) throw interrupted;
          attempts++;
          try {
            Promise.resolve(
              onAttempt?.({ attempt, maxAttempts, status: "running" }),
            ).catch(() => {});
          } catch {}
          return active.run(input, { sessionId });
        });
        output = await bounded(() => decode(result));
        const meta = { signal: controller.signal, attempt };
        if (finalize)
          output = (await bounded(() => finalize(output, meta))) ?? output;
        if (validate) await bounded(() => validate(output, meta));
      } catch (error) {
        failure =
          interrupted ??
          (error instanceof errorClass
            ? error
            : new errorClass("model_execution_failed", { phase: "execution" }));
      }
      try {
        await close(active);
      } catch {
        failure =
          interrupted ??
          new errorClass("model_execution_failed", { phase: "cleanup" });
      }
      active = undefined;
      if (interrupted) failure = interrupted;
      if (!failure) return output;
      const retryable = repairCodes.has(failure.failure?.code);
      if (!retryable || attempt === maxAttempts) {
        failure.failure.harness = {
          attempts,
          maxAttempts,
          exhausted: retryable && attempt === maxAttempts,
        };
        throw failure;
      }
      feedback = repairFeedback(failure.failure, contract);
    }
  } catch (error) {
    const failure =
      error instanceof errorClass
        ? error
        : new errorClass("model_execution_failed", { phase: "execution" });
    if (!failure.failure.harness)
      failure.failure.harness = { attempts, maxAttempts, exhausted: false };
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", aborted);
    if (active) await close(active).catch(() => {});
  }
}
