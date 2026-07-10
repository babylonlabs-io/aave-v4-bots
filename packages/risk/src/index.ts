// Barrel. Modules import from the leaves (`./types`, `./gate`) so nothing depends on this file,
// keeping the package free of index↔module import cycles.
//
// The kill switch's routes and server, and the code-hash guard's timer, are assembled by
// `startRiskRuntime` and are not part of the public surface.

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
export { settleUnfinished } from "./utils";

// Stands up the process's one gate: thresholds, the boot + periodic code-hash check, and the
// remote kill switch on its own socket.
export { type RiskRuntime, type RiskRuntimeConfig, startRiskRuntime } from "./runtime";
