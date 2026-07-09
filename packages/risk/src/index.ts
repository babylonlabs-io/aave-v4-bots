// Barrel. Modules import from the leaves (`./types`, `./gate`) so nothing depends on this file,
// keeping the package free of index↔module import cycles.

export type {
  ActionOutcome,
  CodeHashReader,
  RiskAction,
  RiskConfig,
  RiskGate,
  RiskSlot,
  RiskState,
} from "./types";

export { createRiskGate } from "./gate";
export { type CodeHashGuardConfig, startCodeHashGuard } from "./guard";
export { settleUnfinished } from "./utils";

// Remote kill switch (§5.6 — `risk` owns it; `observability` only mounts the route).
export {
  type ControlRoutesConfig,
  CONTROL_ROUTE_NAMES,
  createControlRoutes,
  resolveControlToken,
} from "./control";
export { type RiskRuntime, type RiskRuntimeConfig, startRiskRuntime } from "./runtime";
