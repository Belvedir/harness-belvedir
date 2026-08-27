// End-to-end test of the runner against a mock OpenAI-compatible endpoint.
// No network, no keys: the mock plays both the model under test and the
// judge, keyed off the model id in each request. The runner is spawned
// asynchronously — a sync spawn would block the event loop the mock server
// needs to answer the runner's requests.
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const MODEL_ID = "test/model";
const JUDGE_ID = "test/judge";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const user = parsed.messages.find((m) => m.role === "user")?.content ?? "";
    let content;
    // Judge requests are recognized by prompt shape, not model id — the
    // self-grading test points JUDGE_MODEL at the model under test.
    const isJudge = user.includes("<attempt>");
    if (isJudge) {
      const attempt = (user.match(/<attempt>\n([\s\S]*?)\n<\/attempt>/) || [])[1] || "";
      const pass = attempt.includes("correct final answer");
      content = JSON.stringify({ pass, reason: pass ? "accomplishes the task" : "does not" });
    } else if (parsed.model === MODEL_ID) {
      // The model under test: behavior keyed off markers in the task.
      if (user.includes("ECHO")) content = user; // degenerate: echoes the task
      else if (user.includes("BAD")) content = "I cannot help with that.";
      else content = "Here is the correct final answer, done differently than the reference.";
    } else {
      res.writeHead(400).end("unknown model");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

function runRunner(dir, extraEnv) {
  return new Promise((resolve) => {
    execFile(
      "node",
      [path.join(__dirname, "..", "run.js")],
      {
        cwd: dir,
        env: {
          ...process.env,
          MODEL: MODEL_ID,
          MODEL_API_KEY: "test-key",
          JUDGE_MODEL: JUDGE_ID,
          ...extraEnv,
        },
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr });
      }
    );
  });
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-belvedir-"));

  // 1. The happy path: legacy sugar + tagged form + a degenerate echo + a bad
  // attempt. Expect 2 passes out of 4.
  const tasksFile = path.join(dir, "tasks.jsonl");
  fs.writeFileSync(
    tasksFile,
    [
      JSON.stringify({ task: "Answer the customer question", expect: "a helpful reply" }),
      JSON.stringify({ task: "Tagged form works too", verify: { kind: "judge", expect: "anything" } }),
      JSON.stringify({ task: "ECHO this back", expect: "a real answer" }),
      JSON.stringify({ task: "Do the BAD thing", expect: "a completed result" }),
    ].join("\n")
  );
  let r = await runRunner(dir, {
    MODEL_API_BASE: base,
    BELVEDIR_TASKS_FILE: tasksFile,
    MODEL_LABEL: "my-trained-model",
  });
  check("runner exits 0", r.status === 0, r.stdout + r.stderr);
  const results = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8"));
  check("score is 0.5 (2/4)", results.score === 0.5, `got ${results.score}`);
  check("MODEL_LABEL echoed as results.model", results.model === "my-trained-model");
  check("judge_model recorded", results.judge_model === JUDGE_ID);
  const echoTask = results.tasks.find((t) => t.index === 2);
  check(
    "echo attempt failed without judge",
    echoTask && !echoTask.pass && /echoes the task/.test(echoTask.reason),
    JSON.stringify(echoTask)
  );

  // 2. Unsupported verifier kind refuses up front — no results.json.
  fs.rmSync(path.join(dir, "results.json"));
  fs.writeFileSync(tasksFile, JSON.stringify({ task: "x", verify: { kind: "state_diff", golden: {} } }));
  r = await runRunner(dir, { MODEL_API_BASE: base, BELVEDIR_TASKS_FILE: tasksFile });
  check("unsupported verifier exits nonzero", r.status === 1, r.stdout);
  check("unsupported verifier names the kind", /state_diff/.test(r.stdout), r.stdout);
  check("no results.json written on refusal", !fs.existsSync(path.join(dir, "results.json")));

  // 3. Missing task file refuses (this driver has no built-in suite).
  r = await runRunner(dir, { MODEL_API_BASE: base });
  check("missing BELVEDIR_TASKS_FILE exits nonzero", r.status === 1, r.stdout);

  // 4. Self-grading warns: judge = model under test.
  fs.writeFileSync(tasksFile, JSON.stringify({ task: "Answer this", expect: "an answer" }));
  r = await runRunner(dir, {
    MODEL_API_BASE: base,
    BELVEDIR_TASKS_FILE: tasksFile,
    JUDGE_MODEL: MODEL_ID,
  });
  check("self-grading run still executes", r.status === 0, r.stdout + r.stderr);
  check("self-grading warning printed", /judge .* IS the model under test/.test(r.stdout), r.stdout);

  // 5. pass@k: 1 task, 2 attempts, both pass -> 1.0.
  fs.writeFileSync(tasksFile, JSON.stringify({ task: "Answer well", expect: "an answer" }));
  r = await runRunner(dir, {
    MODEL_API_BASE: base,
    BELVEDIR_TASKS_FILE: tasksFile,
    BELVEDIR_TASK_ATTEMPTS: "2",
    BELVEDIR_GRADING: "pass@k",
  });
  const r5 = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8"));
  check("pass@k over attempts", r.status === 0 && r5.score === 1 && r5.attempts_per_task === 2, r.stdout);

  fs.rmSync(dir, { recursive: true, force: true });
}

server.listen(0, "127.0.0.1", () => {
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  main(base)
    .catch((e) => {
      failures++;
      console.error(`FAIL test crashed — ${e.stack}`);
    })
    .finally(() => {
      server.close();
      if (failures > 0) process.exit(1);
      console.log("all tests passed");
    });
});
