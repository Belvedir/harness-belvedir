#!/usr/bin/env node
// Belvedir first-party environment runner.
//
// run = environment (tasks + verifiers) x harness (agent code) x model.
// This process is the RUNNER: it owns task parsing, verifier dispatch, and
// results.json. The harness is a seam it invokes per task (default: the
// minimal loop in harness.js — task -> one model call -> output; override
// with BELVEDIR_HARNESS_CMD). A harness never grades itself: self-graded
// scores are the reward-hacking front door for "harness improvements".
//
// Platform contract (see the Belvedir benchmarks docs):
//   reads  BELVEDIR_TASKS_FILE   JSONL task set, one object per line
//   env    MODEL                 model under test (required)
//          MODEL_API_BASE        OpenAI-compatible base URL; blank = inferred
//                                from the model id (claude-* -> Anthropic,
//                                gpt-*/o* -> OpenAI)
//          MODEL_API_KEY         key for that endpoint
//          JUDGE_MODEL           judge for the "judge" verifier; defaults to
//                                a PINNED model, never the model under test
//          JUDGE_API_BASE/KEY    blank = the model endpoint's base/key
//          MODEL_LABEL           echoed as results.model when set
//          BELVEDIR_TASK_ATTEMPTS  attempts per task (default 1)
//          BELVEDIR_GRADING        pass@1 | pass@k | mean
//          BELVEDIR_HARNESS_CMD    harness seam: shell command run per task
//                                  (task on stdin + $TASK, attempt on stdout)
//   writes results.json at the repo root: numeric top-level score in 0..1
//
// Task lines are verifier-tagged; bare {task, expect} is sugar for the judge
// verifier:
//   {"task": "...", "verify": {"kind": "judge", "expect": "..."}}
//   {"task": "...", "expect": "..."}

"use strict";
const fs = require("fs");
const { defaultHarness, commandHarness } = require("./harness");

// Never the model under test: an unset judge must not silently self-grade.
const DEFAULT_JUDGE_MODEL = "anthropic/claude-haiku-4-5";
const CONCURRENCY = 4;
const MODEL_TIMEOUT_MS = 300_000;
const JUDGE_TIMEOUT_MS = 120_000;
const HTTP_RETRIES = 3;
const JUDGE_CLIP_CHARS = 8_000;
const RESULTS_SOFT_CAP_BYTES = 200 * 1024;
// Above these, the score would say more about infrastructure than the model.
const MAX_ATTEMPT_ERROR_RATE = 0.3;
const MAX_JUDGE_ERROR_RATE = 0.1;

function log(msg) {
  console.log(`belvedir-runner: ${msg}`);
}

function fail(msg) {
  log(msg);
  process.exit(1);
}

function inferBase(model) {
  if (/^(anthropic\/)?claude-/.test(model)) return "https://api.anthropic.com/v1";
  if (/^(openai\/)?(gpt-|o\d)/.test(model)) return "https://api.openai.com/v1";
  return null;
}

function endpointFor(kind) {
  const model =
    kind === "judge"
      ? (process.env.JUDGE_MODEL || "").trim() || DEFAULT_JUDGE_MODEL
      : (process.env.MODEL || "").trim();
  const modelBase = (process.env.MODEL_API_BASE || "").trim();
  const base =
    kind === "judge"
      ? (process.env.JUDGE_API_BASE || "").trim() || modelBase || inferBase(model)
      : modelBase || inferBase(model);
  const key =
    kind === "judge"
      ? (process.env.JUDGE_API_KEY || "").trim() ||
        (process.env.MODEL_API_KEY || "").trim()
      : (process.env.MODEL_API_KEY || "").trim();
  return { model, base, key };
}

async function chat(endpoint, messages, { timeoutMs, maxTokens, temperature }) {
  const url = `${endpoint.base.replace(/\/+$/, "")}/chat/completions`;
  let lastErr;
  for (let attempt = 0; attempt < HTTP_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${endpoint.key}`,
        },
        body: JSON.stringify({
          model: endpoint.model,
          messages,
          max_tokens: maxTokens,
          ...(temperature !== undefined ? { temperature } : {}),
        }),
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`HTTP ${res.status}: ${body}`);
      } else {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new Error("no message content in response");
        }
        return content;
      }
    } catch (e) {
      if (e?.name === "AbortError") lastErr = new Error(`timeout after ${timeoutMs}ms`);
      else if (!lastErr || e !== lastErr) lastErr = e;
      // Non-retryable errors were thrown above; everything here retries.
    } finally {
      clearTimeout(timer);
    }
    if (attempt < HTTP_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("request failed");
}

function clip(text, max) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\n[truncated]` : s;
}

function normalized(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// The judge grades TASK SATISFACTION with the reference as evidence, never
// answer similarity: the references in generated environments are the
// incumbent production model's own outputs, and a similarity judge is
// structurally biased toward whatever model already serves the group.
const JUDGE_SYSTEM =
  "You are a strict but fair grader of an AI agent's attempt at a task. " +
  "Respond with ONLY a JSON object, no prose, no code fences.";

function judgeUserPrompt(task, expect, attempt) {
  return [
    "Task the agent was given:",
    `<task>\n${clip(task, JUDGE_CLIP_CHARS)}\n</task>`,
    "",
    "Reference outcome. This is one real answer known to have satisfied the",
    "task. Treat it as EVIDENCE of what success looks like — what facts,",
    "outcomes, and constraints matter — NOT as the only acceptable answer.",
    `<reference>\n${clip(expect, JUDGE_CLIP_CHARS)}\n</reference>`,
    "",
    "Attempt to grade:",
    `<attempt>\n${clip(attempt, JUDGE_CLIP_CHARS)}\n</attempt>`,
    "",
    "Does the attempt ACCOMPLISH THE TASK?",
    "- A different approach, format, wording, or level of detail than the",
    "  reference still PASSES. Never grade similarity to the reference.",
    "- FAIL an attempt that is empty, evasive, refuses, only restates or",
    "  plans the task, or contradicts load-bearing facts the reference",
    "  establishes.",
    'Respond with ONLY: {"pass": true or false, "reason": "<one short sentence>"}',
  ].join("\n");
}

function parseVerdict(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (typeof obj.pass !== "boolean") return null;
    return { pass: obj.pass, reason: String(obj.reason ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}

async function judgeVerify(judge, task, expect, attempt) {
  // Degenerate responders never reach the judge: an empty answer or a
  // task echo must not pass, and must not spend judge tokens finding out.
  if (!normalized(attempt)) return { pass: false, reason: "empty attempt" };
  if (normalized(attempt) === normalized(task)) {
    return { pass: false, reason: "attempt echoes the task" };
  }
  const messages = [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: judgeUserPrompt(task, expect, attempt) },
  ];
  // One re-ask on an unparseable verdict before counting a judge error.
  for (let i = 0; i < 2; i++) {
    const text = await chat(judge, messages, {
      timeoutMs: JUDGE_TIMEOUT_MS,
      maxTokens: 512,
      temperature: 0,
    });
    const verdict = parseVerdict(text);
    if (verdict) return verdict;
  }
  throw new Error("judge returned no parseable verdict");
}

function parseTasks(raw) {
  const tasks = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      fail(`task file line ${i + 1} is not valid JSON`);
    }
    const task = typeof obj.task === "string" ? obj.task : null;
    if (!task) fail(`task file line ${i + 1} has no "task" string`);
    let verify = obj.verify;
    if (!verify && typeof obj.expect === "string") {
      verify = { kind: "judge", expect: obj.expect };
    }
    if (!verify || typeof verify !== "object" || !verify.kind) {
      fail(`task file line ${i + 1} has no verifier ("verify" or "expect")`);
    }
    if (verify.kind !== "judge") {
      // Refusing beats silently judge-grading a task that shipped a
      // different verifier — the score would measure the wrong thing.
      fail(
        `task file line ${i + 1} uses verifier kind "${verify.kind}"; this runner supports: judge`
      );
    }
    if (typeof verify.expect !== "string" || !verify.expect.trim()) {
      fail(`task file line ${i + 1}: the judge verifier needs an "expect" string`);
    }
    tasks.push({ index: tasks.length, task, verify });
  }
  return tasks;
}

async function runPool(items, worker, concurrency) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      await worker(queue.shift());
    }
  });
  await Promise.all(runners);
}

async function main() {
  if (typeof fetch !== "function") {
    fail("this runner needs Node 18+ (global fetch)");
  }
  const tasksFile =
    process.env.BELVEDIR_TASKS_FILE || process.env.FRACTAL_TASKS_FILE;
  if (!tasksFile) {
    fail(
      "BELVEDIR_TASKS_FILE is not set. This driver runs a provided task set (an environment generated from a training set, or tasks authored on the harness) — it has no built-in suite."
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(tasksFile, "utf8");
  } catch (e) {
    fail(`task file unreadable: ${e.message}`);
  }
  const tasks = parseTasks(raw);
  if (tasks.length === 0) fail("task file is empty");

  const model = endpointFor("model");
  if (!model.model) fail("MODEL is not set");
  if (!model.base) {
    fail(
      `MODEL_API_BASE is not set and can't be inferred from "${model.model}"; set it to an OpenAI-compatible base URL`
    );
  }
  if (!model.key) fail("MODEL_API_KEY is not set");
  const judge = endpointFor("judge");
  if (!judge.base) fail("the judge has no endpoint; set JUDGE_API_BASE or MODEL_API_BASE");
  if (judge.model === model.model && judge.base === model.base) {
    log(
      `warning: the judge (${judge.model}) IS the model under test — self-graded scores are not trustworthy; set JUDGE_MODEL to an independent model`
    );
  }

  const attempts = Math.max(
    1,
    parseInt(process.env.BELVEDIR_TASK_ATTEMPTS || "1", 10) || 1
  );
  const grading = (process.env.BELVEDIR_GRADING || "pass@1").toLowerCase();
  const harnessCmd = (process.env.BELVEDIR_HARNESS_CMD || "").trim();
  const harness = harnessCmd ? commandHarness(harnessCmd) : defaultHarness;
  log(
    `${tasks.length} tasks · model ${model.model} · judge ${judge.model} · ${attempts} attempt(s), ${grading}` +
      (harnessCmd ? " · harness: command" : " · harness: minimal loop")
  );

  let attemptErrors = 0;
  let judgeErrors = 0;
  let judgedAttempts = 0;

  await runPool(
    tasks,
    async (t) => {
      const verdicts = [];
      for (let a = 0; a < attempts; a++) {
        let output;
        try {
          output = await harness(t.task, {
            index: t.index,
            attempt: a,
            model,
            chat: (messages) =>
              chat(model, messages, {
                timeoutMs: MODEL_TIMEOUT_MS,
                maxTokens: 4096,
              }),
          });
        } catch (e) {
          attemptErrors++;
          verdicts.push({ pass: false, reason: `attempt error: ${String(e.message).slice(0, 150)}` });
          continue;
        }
        try {
          verdicts.push(await judgeVerify(judge, t.task, t.verify.expect, output));
          judgedAttempts++;
        } catch (e) {
          judgeErrors++;
          verdicts.push({ pass: false, reason: `judge error: ${String(e.message).slice(0, 150)}` });
        }
      }
      const passes = verdicts.filter((v) => v.pass).length;
      t.score = grading === "pass@k" ? (passes > 0 ? 1 : 0) : passes / verdicts.length;
      t.pass = t.score >= 0.5;
      t.reason = verdicts[0]?.reason ?? "";
      log(`task ${t.index + 1}/${tasks.length}: ${t.pass ? "pass" : "fail"}${t.reason ? ` (${t.reason})` : ""}`);
    },
    CONCURRENCY
  );

  const totalAttempts = tasks.length * attempts;
  if (attemptErrors / totalAttempts > MAX_ATTEMPT_ERROR_RATE) {
    fail(
      `${attemptErrors}/${totalAttempts} attempts errored — the score would measure the endpoint, not the model; no score reported`
    );
  }
  if (judgeErrors / totalAttempts > MAX_JUDGE_ERROR_RATE) {
    fail(
      `the judge failed on ${judgeErrors}/${totalAttempts} attempts; no score reported`
    );
  }

  const score = tasks.reduce((s, t) => s + t.score, 0) / tasks.length;
  const results = {
    score,
    model: (process.env.MODEL_LABEL || "").trim() || model.model,
    total: tasks.length,
    passed: tasks.filter((t) => t.pass).length,
    judge_model: judge.model,
    grading,
    attempts_per_task: attempts,
    attempt_errors: attemptErrors,
    judge_errors: judgeErrors,
    tasks: tasks.map((t) => ({ index: t.index, pass: t.pass, score: t.score, reason: t.reason })),
  };
  let out = JSON.stringify(results, null, 2);
  if (Buffer.byteLength(out) > RESULTS_SOFT_CAP_BYTES) {
    delete results.tasks;
    out = JSON.stringify(results, null, 2);
    log("per-task detail dropped from results.json (size cap)");
  }
  fs.writeFileSync("results.json", out);
  log(`done: score ${score.toFixed(3)} (${results.passed}/${tasks.length} passed, ${judgedAttempts} judged)`);
}

main().catch((e) => fail(e?.stack || String(e)));
