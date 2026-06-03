"""
Coordinator Lambda — orchestrates upload, sharding, worker dispatch, and result aggregation.

Routes:
  POST /upload-url      — presigned S3 PUT URL for direct browser upload
  POST /job/start       — shard the uploaded file, dispatch first worker batch
  GET  /job/status      — job progress (completed_shards / total_shards)
  GET  /job/results     — aggregate sentiment + accuracy from all shard outputs
  POST /job/worker-done — worker callback; dispatches next pending shard
"""

import csv
import io
import json
import os
import uuid
from datetime import datetime, timezone

import boto3

s3  = boto3.client("s3")
lam = boto3.client("lambda")

DATA_BUCKET   = os.environ["DATA_BUCKET"]
WORKER_FUNCTION = os.environ["WORKER_FUNCTION"]
MAX_CONCURRENCY = 5
MAX_SHARDS      = 20
MIN_SHARD_SIZE  = 100
MAX_SHARD_SIZE  = 500


# ── Routing ──────────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path   = event.get("rawPath", "/")
    body   = _parse_body(event)
    qs     = event.get("queryStringParameters") or {}

    routes = {
        ("POST", "/upload-url"):      lambda: _upload_url(body),
        ("POST", "/job/start"):       lambda: _start_job(body),
        ("GET",  "/job/status"):      lambda: _job_status(qs),
        ("GET",  "/job/results"):     lambda: _job_results(qs),
        ("POST", "/job/worker-done"): lambda: _worker_done(body),
    }
    handler = routes.get((method, path))
    if not handler:
        return _err(404, f"No route: {method} {path}")
    try:
        return handler()
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return _err(500, str(exc))


# ── Handlers ─────────────────────────────────────────────────────────────────

def _upload_url(body):
    job_id       = str(uuid.uuid4())
    filename     = body.get("filename", "dataset.csv")
    content_type = body.get("content_type", "text/csv")
    key          = f"uploads/{job_id}/{filename}"

    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": DATA_BUCKET, "Key": key, "ContentType": content_type},
        ExpiresIn=300,
    )
    return _ok({"job_id": job_id, "upload_url": url, "s3_key": key})


def _start_job(body):
    job_id     = body.get("job_id")
    s3_key     = body.get("s3_key")
    if not job_id or not s3_key:
        return _err(400, "job_id and s3_key are required")

    # Shard size — clamp to [MIN, MAX] then further enforce MAX_SHARDS cap later
    requested = int(body.get("shard_size", int(os.environ.get("SHARD_SIZE", "200"))))
    shard_size = max(MIN_SHARD_SIZE, min(MAX_SHARD_SIZE, requested))

    try:
        obj     = s3.get_object(Bucket=DATA_BUCKET, Key=s3_key)
        content = obj["Body"].read()
    except Exception as exc:
        return _err(400, f"Cannot read uploaded file: {exc}")

    # Parse based on file extension
    ext = s3_key.rsplit(".", 1)[-1].lower() if "." in s3_key else "csv"
    try:
        if ext == "parquet":
            rows = _parse_parquet(content)
        else:
            rows = _parse_csv(content.decode("utf-8", errors="replace"))
    except Exception as exc:
        return _err(400, f"Parse error: {exc}")

    if not rows:
        return _err(400, "File has no data rows")

    has_label = "label" in rows[0]

    # Enforce MAX_SHARDS: if shard_size would exceed cap, increase it
    effective_size = max(shard_size, -(-len(rows) // MAX_SHARDS))

    shard_ids = []
    for i in range(0, len(rows), effective_size):
        chunk = rows[i : i + effective_size]
        sid   = len(shard_ids)
        _write_shard(job_id, sid, chunk, has_label)
        shard_ids.append(sid)

    total       = len(shard_ids)
    first_batch = shard_ids[:MAX_CONCURRENCY]
    pending     = shard_ids[MAX_CONCURRENCY:]

    meta = {
        "job_id":           job_id,
        "status":           "processing",
        "total_shards":     total,
        "completed_shards": 0,
        "pending_shards":   pending,
        "running_shards":   first_batch,
        "has_label":        has_label,
        "shard_size":       effective_size,
        "total_rows":       len(rows),
        "created_at":       _now(),
        "updated_at":       _now(),
    }
    _write_meta(job_id, meta)

    callback_url = os.environ.get("API_CALLBACK_URL", "")
    for sid in first_batch:
        _invoke_worker(job_id, sid, callback_url)

    return _ok({
        "job_id":       job_id,
        "total_shards": total,
        "total_rows":   len(rows),
        "shard_size":   effective_size,
        "status":       "processing",
    })


def _job_status(qs):
    meta = _read_meta(qs.get("job_id"))
    if meta is None:
        return _err(404, "Job not found")
    total = meta["total_shards"]
    done  = meta["completed_shards"]
    return _ok({
        "job_id":           meta["job_id"],
        "status":           meta["status"],
        "total_shards":     total,
        "completed_shards": done,
        "progress_pct":     round(done / max(total, 1) * 100, 1),
        "total_rows":       meta.get("total_rows", 0),
        "has_label":        meta.get("has_label", False),
    })


def _job_results(qs):
    meta = _read_meta(qs.get("job_id"))
    if meta is None:
        return _err(404, "Job not found")

    positive = negative = total = correct = total_labeled = 0
    prefix   = f"outputs/{meta['job_id']}/"
    pager    = s3.get_paginator("list_objects_v2")
    for page in pager.paginate(Bucket=DATA_BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            try:
                r = json.loads(
                    s3.get_object(Bucket=DATA_BUCKET, Key=obj["Key"])["Body"].read()
                )
                positive      += r.get("positive", 0)
                negative      += r.get("negative", 0)
                total         += r.get("total", 0)
                correct       += r.get("correct", 0)
                total_labeled += r.get("total_labeled", 0)
            except Exception:
                pass

    result = {
        "job_id":       meta["job_id"],
        "status":       meta["status"],
        "positive":     positive,
        "negative":     negative,
        "total":        total,
        "positive_pct": round(positive / max(total, 1) * 100, 1),
    }
    if total_labeled > 0:
        result["accuracy"]      = round(correct / total_labeled * 100, 2)
        result["correct"]       = correct
        result["total_labeled"] = total_labeled

    return _ok(result)


def _worker_done(body):
    job_id   = body.get("job_id")
    shard_id = body.get("shard_id")
    if not job_id or shard_id is None:
        return _err(400, "job_id and shard_id required")

    meta = _read_meta(job_id)
    if meta is None:
        return _err(404, "Job not found")

    running = meta.get("running_shards", [])
    if shard_id in running:
        running.remove(shard_id)
    meta["completed_shards"] = meta.get("completed_shards", 0) + 1

    pending      = meta.get("pending_shards", [])
    callback_url = os.environ.get("API_CALLBACK_URL", "")
    while pending and len(running) < MAX_CONCURRENCY:
        nxt = pending.pop(0)
        running.append(nxt)
        _invoke_worker(job_id, nxt, callback_url)

    meta["running_shards"] = running
    meta["pending_shards"] = pending
    meta["updated_at"]     = _now()

    if meta["completed_shards"] >= meta["total_shards"]:
        meta["status"] = "completed"

    _write_meta(job_id, meta)
    return _ok({"ok": True})


# ── Parsing ───────────────────────────────────────────────────────────────────

def _parse_csv(text):
    reader = csv.DictReader(io.StringIO(text))
    if "text" not in (reader.fieldnames or []):
        raise ValueError("CSV must contain a 'text' column")
    rows = []
    for row in reader:
        r = {"text": row.get("text", "")}
        if "label" in row and row["label"] != "":
            r["label"] = row["label"]
        rows.append(r)
    return rows


def _parse_parquet(content_bytes):
    import pyarrow.parquet as pq

    table = pq.read_table(io.BytesIO(content_bytes))
    cols  = table.schema.names
    if "text" not in cols:
        raise ValueError("Parquet file must contain a 'text' column")

    texts  = table.column("text").to_pylist()
    labels = table.column("label").to_pylist() if "label" in cols else None

    rows = []
    for i, text in enumerate(texts):
        r = {"text": str(text) if text is not None else ""}
        if labels is not None and labels[i] is not None:
            r["label"] = str(labels[i])
        rows.append(r)
    return rows


# ── S3 helpers ────────────────────────────────────────────────────────────────

def _write_shard(job_id, shard_id, rows, has_label):
    buf = io.StringIO()
    fields = ["text", "label"] if has_label else ["text"]
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    s3.put_object(
        Bucket=DATA_BUCKET,
        Key=f"shards/{job_id}/shard_{shard_id:04d}.csv",
        Body=buf.getvalue().encode(),
        ContentType="text/csv",
    )


def _invoke_worker(job_id, shard_id, callback_url):
    payload = {
        "job_id":       job_id,
        "shard_id":     shard_id,
        "data_bucket":  DATA_BUCKET,
        "shard_key":    f"shards/{job_id}/shard_{shard_id:04d}.csv",
        "output_key":   f"outputs/{job_id}/shard_{shard_id:04d}.json",
        "callback_url": callback_url,
    }
    lam.invoke(
        FunctionName=WORKER_FUNCTION,
        InvocationType="Event",
        Payload=json.dumps(payload).encode(),
    )


def _write_meta(job_id, meta):
    s3.put_object(
        Bucket=DATA_BUCKET,
        Key=f"metadata/{job_id}/job.json",
        Body=json.dumps(meta).encode(),
        ContentType="application/json",
    )


def _read_meta(job_id):
    if not job_id:
        return None
    try:
        return json.loads(
            s3.get_object(Bucket=DATA_BUCKET,
                          Key=f"metadata/{job_id}/job.json")["Body"].read()
        )
    except Exception:
        return None


def _parse_body(event):
    try:
        return json.loads(event.get("body") or "{}")
    except Exception:
        return {}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _ok(body):
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        "body": json.dumps(body),
    }


def _err(code, msg):
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        "body": json.dumps({"error": msg}),
    }
