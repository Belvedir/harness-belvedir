// The harness seam. A harness is: given a task, produce an attempt. It never
// grades — verification belongs to the runner (run.js).
//
// defaultHarness is the minimal first-party loop: forward the task to the
// model under test in one chat call, return the output. Deliberately nearly
// nothing: a generated environment measures the MODEL on the training set's
// tasks, and any scaffold cleverness here would be a confound nobody chose.
//
// commandHarness is the bring-your-own seam: BELVEDIR_HARNESS_CMD names a
// shell command run once per task with the task on stdin (and in $TASK);
// whatever it prints to stdout is the attempt. The command talks to the model
// itself via MODEL/MODEL_API_BASE/MODEL_API_KEY from its environment.

"use strict";
const { spawn } = require("child_process");

const SYSTEM_PROMPT =
  "You are an AI agent completing a task for a user. Produce the actual " +
  "final result of the task — not a plan, not a description of what you " +
  "would do. Be direct and complete.";

const COMMAND_TIMEOUT_MS = 300_000;
const COMMAND_OUTPUT_CAP = 1024 * 1024;

async function defaultHarness(task, ctx) {
  return ctx.chat([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ]);
}

function commandHarness(cmd) {
  return (task, ctx) =>
    new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", cmd], {
        env: { ...process.env, TASK: task, TASK_INDEX: String(ctx.index) },
        stdio: ["pipe", "pipe", "inherit"],
      });
      let out = "";
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        child.kill("SIGKILL");
        reject(new Error(`harness command timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      child.stdout.on("data", (chunk) => {
        if (out.length < COMMAND_OUTPUT_CAP) out += chunk.toString();
      });
      child.on("error", (e) => {
        if (done) return;
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        if (done) return;
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`harness command exited ${code}`));
        else resolve(out);
      });
      child.stdin.end(task);
    });
}

module.exports = { defaultHarness, commandHarness, SYSTEM_PROMPT };
