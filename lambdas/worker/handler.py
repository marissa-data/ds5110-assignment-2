"""
Worker Lambda — DistilBERT sentiment analysis (dfurman/distilbert-base-uncased-imdb).
Option B: model downloaded from Hugging Face at runtime, cached in /tmp.

Writes two S3 objects per shard:
  outputs/{job_id}/records/shard_XXXX.json  — per-review records (for results endpoint)
  outputs/{job_id}/timing/shard_XXXX.json   — timing + summary (for status polling)
"""

import csv
import io
import json
import os
import urllib.request
from datetime import datetime, timezone

import boto3
from transformers import pipeline

MODEL_ID   = "dfurman/distilbert-base-uncased-imdb"
MODEL_DIR  = "/tmp/model"
BATCH_SIZE = 8
MAX_LENGTH = 256

_pipe = None
s3    = boto3.client("s3")


def lambda_handler(event, context):
    job_id       = event["job_id"]
    shard_id     = event["shard_id"]
    data_bucket  = event["data_bucket"]
    shard_key    = event["shard_key"]
    records_key  = event["records_key"]
    timing_key   = event["timing_key"]
    callback_url = event.get("callback_url", "")

    start_dt = datetime.now(timezone.utc)
    _ensure_model()

    obj     = s3.get_object(Bucket=data_bucket, Key=shard_key)
    content = obj["Body"].read().decode("utf-8", errors="replace")
    rows    = list(csv.DictReader(io.StringIO(content)))

    if not rows:
        end_dt = datetime.now(timezone.utc)
        _write_records(data_bucket, records_key, [])
        _write_timing(data_bucket, timing_key, shard_id, start_dt, end_dt, 0, 0, 0, 0, 0)
        _notify(callback_url, job_id, shard_id)
        return {"job_id": job_id, "shard_id": shard_id, "total": 0}

    has_label = "label" in rows[0]
    texts     = [row.get("text", "") for row in rows]

    raw_results = _pipe(
        texts,
        batch_size=BATCH_SIZE,
        truncation=True,
        max_length=MAX_LENGTH,
    )

    label_to_int = {"POSITIVE": 1, "NEGATIVE": 0}
    records  = []
    positive = negative = correct = total_labeled = 0

    for row, res in zip(rows, raw_results):
        label_name = res["label"]
        label_int  = label_to_int.get(label_name, -1)
        if label_name == "POSITIVE":
            positive += 1
        else:
            negative += 1

        record = {
            "input_text_prefix":    row.get("text", "")[:200],
            "predicted_label":      label_int,
            "predicted_label_name": label_name,
            "score":                round(res["score"], 6),
        }
        if has_label:
            raw_gt = row.get("label", "")
            if raw_gt != "":
                try:
                    gt = int(raw_gt)
                    record["ground_truth_label"] = gt
                    record["correct"] = (label_int == gt)
                    total_labeled += 1
                    if label_int == gt:
                        correct += 1
                except ValueError:
                    pass
        records.append(record)

    end_dt = datetime.now(timezone.utc)
    _write_records(data_bucket, records_key, records)
    _write_timing(data_bucket, timing_key, shard_id, start_dt, end_dt,
                  len(records), positive, negative, correct, total_labeled)
    _notify(callback_url, job_id, shard_id)

    return {"job_id": job_id, "shard_id": shard_id, "total": len(records)}


# ── Model management ──────────────────────────────────────────────────────────

def _ensure_model():
    global _pipe
    if _pipe is not None:
        return
    print(f"Loading model {MODEL_ID} into {MODEL_DIR} …")
    os.makedirs(MODEL_DIR, exist_ok=True)
    _pipe = pipeline(
        "text-classification",
        model=MODEL_ID,
        device=-1,
        model_kwargs={"cache_dir": MODEL_DIR},
    )
    print("Model loaded.")


# ── S3 helpers ────────────────────────────────────────────────────────────────

def _write_records(bucket, key, records):
    s3.put_object(
        Bucket=bucket, Key=key,
        Body=json.dumps(records).encode(),
        ContentType="application/json",
    )


def _write_timing(bucket, key, shard_id, start_dt, end_dt,
                  total, positive, negative, correct, total_labeled):
    exec_s = (end_dt - start_dt).total_seconds()
    s3.put_object(
        Bucket=bucket, Key=key,
        Body=json.dumps({
            "shard_id":         shard_id,
            "start_time":       start_dt.isoformat(),
            "end_time":         end_dt.isoformat(),
            "execution_time_s": round(exec_s, 2),
            "total":            total,
            "positive":         positive,
            "negative":         negative,
            "correct":          correct,
            "total_labeled":    total_labeled,
        }).encode(),
        ContentType="application/json",
    )


def _notify(callback_url, job_id, shard_id):
    if not callback_url:
        return
    payload = json.dumps({"job_id": job_id, "shard_id": shard_id}).encode()
    req = urllib.request.Request(
        callback_url, data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        print(f"Callback failed (non-fatal): {exc}")
