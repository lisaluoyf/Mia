import fs from "node:fs";
import { spawn } from "node:child_process";

const promptPath = process.env.PROMPT_FILE || "/run/job/prompt.txt";
const resultPath = process.env.RESULT_FILE || "/run/job/result.txt";
const model = process.env.ALLOWED_MODEL || "gpt-5.4";
const gatewayBaseURL = process.env.GATEWAY_BASE_URL || "http://gateway:8080/v1";

const userPrompt = fs.readFileSync(promptPath, "utf8").trim();
if (!userPrompt) throw new Error("prompt must not be empty");

const instructions = `You are editing a persistent Mia mini-app project in /workspace.
Inspect the existing files before changing them. Implement the user's request completely.
The deliverable must be a static mobile-friendly web app that runs from index.html.
Keep all project files under /workspace. Do not use remote scripts, CDNs, analytics, trackers,
or runtime network requests. Use only HTML, CSS, JavaScript, and local assets.
Run lightweight local checks when useful. Do not start a long-running server.

User request:
${userPrompt}`;

const args = [
  "exec",
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
  "--ephemeral",
  "--dangerously-bypass-approvals-and-sandbox",
  "--model",
  model,
  "--cd",
  "/workspace",
  "--output-last-message",
  resultPath,
  "-c",
  'model_provider="mia_gateway"',
  "-c",
  'model_providers.mia_gateway.name="Mia job gateway"',
  "-c",
  `model_providers.mia_gateway.base_url="${gatewayBaseURL}"`,
  "-c",
  'model_providers.mia_gateway.env_key="CODEX_API_KEY"',
  "-c",
  'model_providers.mia_gateway.wire_api="responses"',
  "-c",
  'shell_environment_policy.exclude=["CODEX_API_KEY","JOB_TOKEN"]',
  instructions,
];

const child = spawn("codex", args, {
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME || "/tmp/home",
    CODEX_HOME: process.env.CODEX_HOME || "/tmp/codex-home",
    CODEX_API_KEY: process.env.JOB_TOKEN || "",
    LANG: "C.UTF-8",
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`codex terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
