export const REPAIR_MODEL = "gpt-6.1-sol";

export function repairModelArgs(effort) {
  if (!["medium", "high"].includes(effort)) throw new Error("unsupported_repair_effort");
  return ["--model", REPAIR_MODEL, "-c", `model_reasoning_effort="${effort}"`];
}

// Only a controller-classified engine test failure may spend the second call.
// Access errors, model errors, policy violations, audits and publication errors
// propagate directly. Each attempt owns a fresh checkout and the same candidate.
export class EngineValidationFailure extends Error {
  constructor(report, cause) {
    super("engine_repair_validation_failed", { cause });
    this.report = report;
  }
}

export async function withRepairEscalation(attempt) {
  try {
    return await attempt("medium", null);
  } catch (error) {
    if (!(error instanceof EngineValidationFailure)) throw error;
    return attempt("high", error.report);
  }
}
