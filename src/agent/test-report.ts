export type AgentTestLayer = "model_protocol" | "runtime" | "tool" | "evidence" | "delivery" | "configuration";
export type AgentTestStatus = "passed" | "failed";

export interface AgentTestSideEffects {
  telegramMessages: number;
  mediaJobs: number;
  paidSubmissions: number;
}

export interface AgentTestScenarioReport {
  scenario: string;
  status: AgentTestStatus;
  runStatus: string | null;
  layer: AgentTestLayer;
  durationMs: number;
  trace: string[];
  sideEffects: AgentTestSideEffects;
  error?: string;
}

export interface AgentTestReport {
  kind: "agent_loop_test" | "agent_loop_smoke";
  status: AgentTestStatus;
  durationMs: number;
  scenarios: AgentTestScenarioReport[];
}

export function emptySideEffects(): AgentTestSideEffects {
  return { telegramMessages: 0, mediaJobs: 0, paidSubmissions: 0 };
}

export function reportSummary(report: AgentTestReport): string {
  const passed = report.scenarios.filter((scenario) => scenario.status === "passed").length;
  return `Agent Loop ${report.kind === "agent_loop_smoke" ? "smoke" : "test"}: ${report.status.toUpperCase()} (${passed}/${report.scenarios.length}, ${report.durationMs}ms)`;
}
