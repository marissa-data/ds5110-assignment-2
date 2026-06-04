# DS5110 Assignment 2 — Session Log 3
**Date:** 2026-06-04
**Tool:** Claude Code (claude-sonnet-4-6)

---

## Session Summary

This session diagnosed and fixed a critical worker Lambda failure that caused the pipeline to appear stuck (status poll numbers climbing into the hundreds with no completion), ran the full five-shard-size experiment suite, and documented the results.

---

## Conversation

**User:** Review everything saved on the VM and at the GitHub repo. The static website seems to be stuck on the status log — ran for over 2 hours, status poll numbers went into the hundreds.

**Assistant:** Pulled all files from the VM and GitHub. Read coordinator, worker, frontend, and deploy scripts. Fetched the assignment PDF from GitHub after pulling the latest commit. Checked all deployed AWS resources:

- `ds5110-a2-worker` — container image, 2048 MB, 600s, 2048 MB ephemeral
- `ds5110-a2-coordinator` — Python zip, 2048 MB, 600s, coordinator layer attached
- API Gateway `w2n4twr218` — all coordinator routes wired

Checked S3 for recent job data. Found 8 jobs — **every single one had 0 timing files**, meaning workers were invoked but never completed. Pulled the three most recent worker CloudWatch log streams and found the root cause:

```
[ERROR] ValueError: Could not load model dfurman/distilbert-base-uncased-imdb
...
File "huggingface_hub/file_download.py", line 1727, in _download_to_tmp_and_move
    xet_get(
```

**Root cause:** HuggingFace migrated `dfurman/distilbert-base-uncased-imdb` to **XetHub storage**. A newer version of `huggingface_hub` (installed in the container) uses `xet_get()` to download, which tries to write logs to `/home/sbx_user1051/.cache/` — a **read-only path in Lambda**. Every worker crashed before writing any output, so the coordinator's S3-based progress counter (counting timing files) never advanced.

---

**User:** Before anything, the AWS credentials are outdated — please open the credentials file so I can paste new ones.

**Assistant:** Read `~/.aws/credentials`. User edited it directly but the paste ran the new credentials into the old session token without a newline, corrupting the file (two `[default]` blocks merged). Fixed by rewriting the file with only the new credentials. Verified with `aws sts get-caller-identity` — new session confirmed.

---

**User:** Check the assignment details to make sure the proposed changes are safe for AWS Academy.

**Assistant:** Pulled the assignment PDF via `git pull` (it had just been added to the repo). Extracted the full text with `pdftotext`. Key findings relevant to the fix:

- LabRole must be used — no new IAM roles ✅ (env var change doesn't touch IAM)
- CPU-only dependencies, no CUDA ✅
- Option B (runtime download from HuggingFace) is explicitly allowed ✅
- Worker: 2048 MB / 600s / 2048 MB ephemeral ✅ (already correct)
- Coordinator: 2048 MB / 600s ✅
- Concurrency limit 5, never exceed 20 workers ✅
- API Gateway vs Lambda Function URL: assignment says "Lambda Function URL" but also says "design is acceptable as long as the final prototype works end to end" — Lambda Function URLs are blocked by Academy SCP, API Gateway is the documented workaround ✅

All three proposed changes are within Academy constraints.

---

**User:** Yes please (proceed with the fix).

**Assistant:** Applied the fix in three parts:

**1. Lambda env var update (immediate, no rebuild):**
```
HF_HOME=/tmp
TRANSFORMERS_CACHE=/tmp/model
HF_HUB_DISABLE_XET=1
```
Updated via `aws lambda update-function-configuration`. Took effect immediately on next invocation.

**2. worker/handler.py — set env vars at module level:**
```python
import os
os.environ.setdefault("HF_HOME", "/tmp")
os.environ.setdefault("TRANSFORMERS_CACHE", "/tmp/model")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
```
Added before all other imports so they're in place before any HuggingFace code runs.

**3. deploy.sh — corrected worker configuration:**
Changed `--timeout 300 --memory-size 3008` to `--timeout 600 --memory-size 2048` (matching assignment spec), and replaced `ORT_THREADS=2` with the three new HF env vars.

**Smoke test:** Submitted a 5-row CSV job (1 shard). Completed in **14 seconds**, 5/5 correct. Pipeline confirmed working.

Committed and pushed to GitHub:
```
061de6f Fix worker Lambda: redirect HuggingFace cache to /tmp and disable XetHub
```

---

**User:** Website link?

**Assistant:** `http://ds5110-a2-frontend-175407131980.s3-website-us-east-1.amazonaws.com`

Recommended starting with 200 reviews/shard as the baseline (5 shards, single wave, perfect concurrency utilization), then testing 100 and 500 to bracket the tradeoff.

---

**User:** It worked. Uploaded results PDF. Also gave end-to-end design run-down request.

**Assistant:** Read the 200-shard results PDF. Provided full end-to-end design run-down:

- **Frontend:** 4 static files in S3 website bucket; reads `config.json` for API URL
- **Upload flow:** browser → coordinator `/upload-url` → presigned PUT direct to S3 data bucket
- **Coordinator Lambda:** reads CSV/Parquet, shards, writes shard CSVs to S3, invokes ≤5 workers, manages pending queue via `job.json`, dispatches next shard on each `/job/worker-done` callback
- **Worker Lambda:** container image (PyTorch too large for zip); downloads DistilBERT to `/tmp/model`; runs batched inference; writes per-review records and timing file to S3
- **Progress tracking:** coordinator counts timing files in `outputs/{job_id}/timing/` — one per completed worker, no shared-state race conditions
- **API Gateway:** routes all coordinator endpoints; Lambda Function URLs blocked by Academy SCP

Results from 200/shard run: 1m 24s total, 77.3s avg worker, 91.7% accuracy.

---

**User:** Pull from git and review the test-results folder — how do different shard sizes affect results?

**Assistant:** Pulled 5 PDFs from `test-results/`. Extracted and compared all runs:

| Shard | Shards | Waves | Total Elapsed | Avg Worker | Avg Coord Poll |
|---|---|---|---|---|---|
| 100 | 10 | 2 | 1m 36s | 38.3s | 244ms |
| 200 | 5 | 1 | **1m 24s** ✓ | 77.3s | 154ms |
| 300 | 4 | 1 | 1m 48s | 92.4s | 151ms |
| 400 | 3 | 1 | 2m 24s | 117.5s | 152ms |
| 500 | 2 | 1 | 2m 57s | 175.4s | 127ms |

Key findings:
- **200/shard is fastest** — perfectly fills 5 concurrent slots in one wave
- **100/shard is slower than 200** despite smaller per-shard work — the 2-wave structure means wave 2 waits for the slowest wave-1 worker (56.4s bottleneck)
- **Worker time scales ~linearly** with shard size (~0.35s/review on CPU DistilBERT)
- **300 and 400** leave uneven remainders (100 and 200 rows respectively in the last shard), causing one fast worker while others run long
- **Coordinator poll latency is higher at 100/shard** (244ms vs ~150ms) because `/job/status` reads all 10 timing files from S3 on every poll
- **Accuracy identical at 91.7%** across all configurations

---

**User:** How do Docker containers fit into the pipeline?

**Assistant:** Explained the role of Docker:

- Worker dependencies (PyTorch CPU ~650 MB + transformers ~200 MB) exceed Lambda's 250 MB zip limit → container image required
- Dockerfile: `public.ecr.aws/lambda/python:3.12` base → pip install PyTorch CPU + transformers → COPY handler.py
- Image pushed to Amazon ECR (private Docker registry); Lambda pulls from ECR on cold start
- Cold start: ECR pull → Python imports → `_ensure_model()` downloads DistilBERT to `/tmp/model` (~1–3 min first time)
- Warm invocation: container already running, `/tmp/model` populated → inference starts immediately (~33–38s for 100 reviews)
- Each of the 5 parallel workers is its own independent container instance — no shared `/tmp`
- Coordinator uses a zip (just boto3 + pyarrow Layer) — cold starts in milliseconds

---

## AWS Resources

| Resource | Name/Value |
|---|---|
| Account | 175407131980 |
| Region | us-east-1 |
| Coordinator Lambda | ds5110-a2-coordinator (zip, 2048 MB, 600s) |
| Worker Lambda | ds5110-a2-worker (container image, 2048 MB, 600s, 2048 MB ephemeral) |
| API Gateway | ds5110-a2-api (w2n4twr218) |
| Frontend S3 | ds5110-a2-frontend-175407131980 |
| Data S3 | ds5110-a2-data-175407131980 |
| IAM Role | LabRole |
| Frontend URL | http://ds5110-a2-frontend-175407131980.s3-website-us-east-1.amazonaws.com |
| API Base URL | https://w2n4twr218.execute-api.us-east-1.amazonaws.com |

## Bug Fixed This Session

| Item | Detail |
|---|---|
| Root cause | HuggingFace migrated model to XetHub; `xet_get()` writes to read-only Lambda filesystem |
| Fix | `HF_HOME=/tmp`, `TRANSFORMERS_CACHE=/tmp/model`, `HF_HUB_DISABLE_XET=1` |
| Applied via | Lambda env var update (immediate) + handler.py + deploy.sh |
| Commit | `061de6f` |
