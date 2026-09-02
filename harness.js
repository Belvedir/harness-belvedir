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

// urlHarness is the HTTP seam (Sept 2, mirrors belvedir_harbor.agent):
// BELVEDIR_AGENT_URL names a service that IS the agent — POST
// {"task", "instruction", "run_id"} as JSON (bearer BELVEDIR_AGENT_TOKEN when
// set); the reply's answer-like string field ("answer"/"output"/"content"/
// "text"/"result"/"response", an OpenAI-shaped choices[0].message.content, a
// JSON string) or the raw body is the attempt.
const URL_TIMEOUT_MS = 300_000;

function parseAgentReply(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith('"')) {
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return text;
    }
    if (typeof obj === "string") return obj;
    if (obj && typeof obj === "object") {
      for (const key of ["answer", "output", "content", "text", "result", "response"]) {
        if (typeof obj[key] === "string") return obj[key];
      }
      const content = obj?.choices?.[0]?.message?.content;
      if (typeof content === "string") return content;
      throw new Error("agent reply is JSON without an answer-like string field");
    }
  }
  return text;
}

function urlHarness(url) {
  return async (task) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
    try {
      const token = (process.env.BELVEDIR_AGENT_TOKEN || "").trim();
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/plain",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          task,
          instruction: task,
          run_id: process.env.BELVEDIR_RUN_ID || process.env.FRACTAL_RUN_ID || null,
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`agent HTTP ${res.status}: ${text.slice(0, 300)}`);
      return parseAgentReply(text);
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { defaultHarness, commandHarness, urlHarness, parseAgentReply, SYSTEM_PROMPT };
