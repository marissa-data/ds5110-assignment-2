"""
Worker Lambda — DistilBERT sentiment analysis via ONNX Runtime.

Each invocation:
  1. Downloads model files from S3 to /tmp on cold start (cached for warm calls).
  2. Reads one shard CSV (columns: text, optionally label).
  3. Runs batched DistilBERT inference.
  4. Writes {positive, negative, total, [correct, total_labeled]} JSON output.
  5. POSTs job_id + shard_id back to the coordinator callback URL.
"""

import csv
import io
import json
import os
import urllib.request

import boto3
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_DIR   = "/tmp/model"
MODEL_FILES = ["model.onnx", "tokenizer.json", "config.json"]
BATCH_SIZE  = 16
MAX_LENGTH  = 512

# Module-level cache — populated once per execution environment
_tokenizer: Tokenizer | None = None
_session:   ort.InferenceSession | None = None
_id2label:  dict | None = None

s3 = boto3.client("s3")


def lambda_handler(event, context):
    job_id       = event["job_id"]
    shard_id     = event["shard_id"]
    data_bucket  = event["data_bucket"]
    shard_key    = event["shard_key"]
    output_key   = event["output_key"]
    callback_url = event.get("callback_url", "")

    _ensure_model(data_bucket)

    obj     = s3.get_object(Bucket=data_bucket, Key=shard_key)
    content = obj["Body"].read().decode("utf-8", errors="replace")
    rows    = list(csv.DictReader(io.StringIO(content)))

    if not rows:
        _write_result(data_bucket, output_key, 0, 0, 0, 0, 0)
        _notify(callback_url, job_id, shard_id)
        return {"job_id": job_id, "shard_id": shard_id, "total": 0}

    has_label = "label" in rows[0]
    texts     = [row.get("text", "") for row in rows]

    # Batched inference
    positive = negative = 0
    predictions = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch  = texts[i : i + BATCH_SIZE]
        preds  = _infer(batch)
        predictions.extend(preds)
        for pred in preds:
            label = _id2label.get(str(pred), "NEGATIVE")
            if label == "POSITIVE":
                positive += 1
            else:
                negative += 1

    # Accuracy — only if ground-truth labels are present
    correct = total_labeled = 0
    if has_label:
        for row, pred in zip(rows, predictions):
            raw = row.get("label", "")
            if raw == "":
                continue
            try:
                gt = int(raw)          # 0 = NEGATIVE, 1 = POSITIVE
            except ValueError:
                continue
            total_labeled += 1
            pred_binary = 1 if _id2label.get(str(pred), "NEGATIVE") == "POSITIVE" else 0
            if pred_binary == gt:
                correct += 1

    total = len(rows)
    _write_result(data_bucket, output_key, positive, negative, total,
                  correct, total_labeled)
    _notify(callback_url, job_id, shard_id)

    return {
        "job_id": job_id, "shard_id": shard_id,
        "positive": positive, "negative": negative, "total": total,
        "correct": correct, "total_labeled": total_labeled,
    }


# ── Model management ──────────────────────────────────────────────────────────

def _ensure_model(data_bucket):
    global _tokenizer, _session, _id2label
    if _session is not None:
        return

    os.makedirs(MODEL_DIR, exist_ok=True)
    for fname in MODEL_FILES:
        dest = os.path.join(MODEL_DIR, fname)
        if not os.path.exists(dest):
            print(f"Downloading model/{fname} …")
            s3.download_file(data_bucket, f"model/{fname}", dest)

    _tokenizer = Tokenizer.from_file(os.path.join(MODEL_DIR, "tokenizer.json"))
    _tokenizer.enable_truncation(max_length=MAX_LENGTH)
    _tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = int(os.environ.get("ORT_THREADS", "2"))
    _session = ort.InferenceSession(
        os.path.join(MODEL_DIR, "model.onnx"),
        sess_options=opts,
        providers=["CPUExecutionProvider"],
    )

    with open(os.path.join(MODEL_DIR, "config.json")) as f:
        cfg = json.load(f)
    _id2label = cfg.get("id2label", {"0": "NEGATIVE", "1": "POSITIVE"})
    print("Model loaded. id2label:", _id2label)


def _infer(texts):
    encodings      = _tokenizer.encode_batch(texts)
    input_ids      = np.array([e.ids            for e in encodings], dtype=np.int64)
    attention_mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
    logits = _session.run(
        ["logits"],
        {"input_ids": input_ids, "attention_mask": attention_mask},
    )[0]
    return np.argmax(logits, axis=1).tolist()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _write_result(bucket, key, positive, negative, total, correct, total_labeled):
    result = {"positive": positive, "negative": negative, "total": total,
              "correct": correct, "total_labeled": total_labeled}
    s3.put_object(Bucket=bucket, Key=key,
                  Body=json.dumps(result).encode(), ContentType="application/json")


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
