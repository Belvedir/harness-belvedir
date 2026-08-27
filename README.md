# harness-belvedir

Belvedir's first-party benchmark driver: the default way a generated
environment (a task set distilled from one of your training sets) gets
executed and scored.

A run decomposes as:

```
run = environment (tasks + verifiers)  ×  harness (agent code)  ×  model
       the fixed instrument               the two experimental variables
```

This repo is two of those pieces:

- **The runner** (`run.js`) — fixed, first-party. Reads the task file,
  invokes the harness once per task per attempt, dispatches each task's
  verifier, aggregates, and writes `results.json`. The harness never grades
  itself: verification is owned by the runner so scores stay comparable when
  the harness is the thing being changed.
- **The minimal default harness** (`harness.js`) — nearly nothing on
  purpose: forward the task to the model under test in one chat call, return
  the output. With the harness held at this default, a score measures the
  MODEL on the environment's tasks; any scaffold cleverness would be a
  confound. Swap in your own agent with `BELVEDIR_HARNESS_CMD` (below).

## Task file format

One JSON object per line. Verifier-tagged; the bare legacy form is sugar for
the judge verifier:

```jsonl
{"task": "Summarize the three most recent inbox items", "verify": {"kind": "judge", "expect": "mentions all three subjects"}}
{"task": "Schedule a 30-minute meeting tomorrow avoiding conflicts", "expect": "picks a free slot"}
```

Supported verifier kinds today: `judge`. A task set carrying an unsupported
kind fails the run up front rather than being silently judge-graded.

### How the judge grades

The judge grades **task satisfaction, not similarity**. In generated
environments the `expect` reference is a real production answer that
satisfied the task — often the incumbent model's own output — so a
similarity grader would be structurally biased toward whatever model already
serves that traffic. The judge treats the reference as evidence of what
success looks like; an attempt that accomplishes the task differently
passes. Empty attempts and task echoes fail without spending judge tokens.

## Environment variables (set by the Belvedir platform)

| Variable | Meaning |
|---|---|
| `MODEL` | Model under test (required) |
| `MODEL_API_BASE` | OpenAI-compatible base URL. Blank = inferred from the model id (`claude-*` → Anthropic, `gpt-*`/`o*` → OpenAI) |
| `MODEL_API_KEY` | Key for that endpoint |
| `JUDGE_MODEL` | Judge for the `judge` verifier. Defaults to a **pinned independent model** (`anthropic/claude-haiku-4-5`), never the model under test; the runner warns if you point it at the model under test |
| `JUDGE_API_BASE` / `JUDGE_API_KEY` | Blank = the model endpoint's base/key |
| `MODEL_LABEL` | Echoed as `results.model` when set (trained-model runs) |
| `BELVEDIR_TASKS_FILE` | Path to the task file (the platform runner downloads it) |
| `BELVEDIR_TASK_ATTEMPTS` | Attempts per task, default 1 |
| `BELVEDIR_GRADING` | `pass@1` (average over attempts, default), `pass@k` (task passes if any attempt does), `mean` |
| `BELVEDIR_HARNESS_CMD` | Optional harness seam: a shell command run once per task — task on stdin and in `$TASK`, attempt read from stdout, nonzero exit = failed attempt. It reads `MODEL`/`MODEL_API_BASE`/`MODEL_API_KEY` from its environment |

## Output

`results.json` at the repo root, per the Belvedir contract:

```json
{
  "score": 0.86,
  "model": "anthropic/claude-sonnet-5",
  "total": 50,
  "passed": 43,
  "judge_model": "anthropic/claude-haiku-4-5",
  "tasks": [{ "index": 0, "pass": true, "score": 1, "reason": "..." }]
}
```

`score` is in 0..1. The run reports **no score** (and fails honestly) when
more than 30% of attempts error (the score would measure the endpoint, not
the model) or the judge fails on more than 10% of attempts.

## Running locally

```bash
export BELVEDIR_TASKS_FILE=./tasks.jsonl
export MODEL=anthropic/claude-sonnet-5
export MODEL_API_BASE=https://openrouter.ai/api/v1
export MODEL_API_KEY=sk-or-...
node run.js
```

Requires Node 18+. No dependencies.
