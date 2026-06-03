/* ── Config ───────────────────────────────────────────────────────────── */
const COORDINATOR_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS       = 3_000;

/* ── State ────────────────────────────────────────────────────────────── */
let state = {
  file:         null,
  jobId:        null,
  s3Key:        null,
  pollTimer:    null,
  elapsedTimer: null,
  jobStartMs:   null,
  seenShards:   new Set(),
  coordTimings: [],
  hasLabel:     false,
  pollCount:    0,
};

/* ── DOM refs ─────────────────────────────────────────────────────────── */
const dropZone          = document.getElementById('drop-zone');
const fileInput         = document.getElementById('file-input');
const fileInfo          = document.getElementById('file-info');
const fileName          = document.getElementById('file-name');
const fileSize          = document.getElementById('file-size');
const btnClearFile      = document.getElementById('btn-clear-file');
const shardSelect       = document.getElementById('shard-size-select');
const btnStart          = document.getElementById('btn-start');
const runError          = document.getElementById('run-error');
const secProgress       = document.getElementById('section-progress');
const secTiming         = document.getElementById('section-timing');
const secShardLog       = document.getElementById('section-shard-log');
const secResults        = document.getElementById('section-results');
const jobIdDisplay      = document.getElementById('job-id-display');
const statusBadge       = document.getElementById('status-badge');
const workersDone       = document.getElementById('workers-done');
const workersTotal      = document.getElementById('workers-total');
const elapsedTime       = document.getElementById('elapsed-time');
const progressFill      = document.getElementById('progress-bar-fill');
const progressPct       = document.getElementById('progress-pct');
const progressDetail    = document.getElementById('progress-detail');
const coordTimingBody   = document.getElementById('coord-timing-body');
const shardLogBody      = document.getElementById('shard-log-body');
const shardLogCount     = document.getElementById('shard-log-count');
const colAccuracyHdr    = document.getElementById('col-accuracy-hdr');
const resTotal          = document.getElementById('res-total');
const resPositive       = document.getElementById('res-positive');
const resNegative       = document.getElementById('res-negative');
const resAccuracy       = document.getElementById('res-accuracy');
const statAccuracy      = document.getElementById('stat-accuracy');
const sentBarWrap       = document.getElementById('sentiment-bar-wrap');
const sentBarPos        = document.getElementById('sentiment-bar-pos');
const sentBarNeg        = document.getElementById('sentiment-bar-neg');
const sentBarPosLbl     = document.getElementById('sentiment-bar-pos-label');
const sentBarNegLbl     = document.getElementById('sentiment-bar-neg-label');
const resElapsed        = document.getElementById('res-elapsed');
const resWorkerAvg      = document.getElementById('res-worker-avg');
const resWorkerMin      = document.getElementById('res-worker-min');
const resWorkerMax      = document.getElementById('res-worker-max');
const resCoordAvg       = document.getElementById('res-coord-avg');
const btnNewJob         = document.getElementById('btn-new-job');

/* ── Load config ─────────────────────────────────────────────────────── */
let config = {};
(async () => {
  try {
    const res = await fetch('config.json');
    config = await res.json();
  } catch (e) {
    showRunError('Failed to load config.json: ' + e.message);
  }
})();

/* ── Fetch with timeout ──────────────────────────────────────────────── */
async function fetchWithTimeout(url, options = {}, ms = COORDINATOR_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

/* Wraps fetchWithTimeout and records coordinator timing. */
async function timedFetch(label, url, options = {}, ms = COORDINATOR_TIMEOUT_MS) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(url, options, ms);
  } catch (err) {
    const dur = Date.now() - t0;
    appendCoordTiming(label, dur, true);
    throw err;
  }
  const dur = Date.now() - t0;
  appendCoordTiming(label, dur, !res.ok);
  return res;
}

/* ── File selection ──────────────────────────────────────────────────── */
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) setFile(fileInput.files[0]); });
btnClearFile.addEventListener('click', clearFile);

function setFile(f) {
  const ext = f.name.split('.').pop().toLowerCase();
  if (!['csv', 'parquet'].includes(ext)) {
    showRunError('Only .csv and .parquet files are supported.');
    return;
  }
  showRunError('');
  state.file = f;
  fileName.textContent = f.name;
  fileSize.textContent = formatBytes(f.size);
  fileInfo.classList.remove('hidden');
  btnStart.disabled = false;
}

function clearFile() {
  state.file = null;
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  btnStart.disabled = true;
  showRunError('');
}

/* ── Start pipeline ──────────────────────────────────────────────────── */
btnStart.addEventListener('click', runPipeline);

async function runPipeline() {
  if (!state.file) return;
  showRunError('');
  btnStart.disabled = true;
  btnStart.textContent = 'Uploading…';

  const file      = state.file;
  const ext       = file.name.split('.').pop().toLowerCase();
  const shardSize = parseInt(shardSelect.value, 10);
  const ct        = ext === 'parquet' ? 'application/octet-stream' : 'text/csv';

  // Reset state for this run
  state.seenShards   = new Set();
  state.coordTimings = [];
  state.pollCount    = 0;
  clearShardLog();
  clearCoordTimingTable();

  try {
    /* 1. Get presigned upload URL */
    const urlRes = await timedFetch('Get upload URL',
      config.coordinatorUrl + '/upload-url', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ filename: file.name, content_type: ct }),
      }
    );
    if (!urlRes.ok) throw new Error(`upload-url failed: ${await urlRes.text()}`);
    const { job_id, upload_url, s3_key } = await urlRes.json();

    state.jobId = job_id;
    state.s3Key = s3_key;

    /* 2. Upload file directly to S3 via presigned URL */
    btnStart.textContent = 'Uploading to S3…';
    const t0Upload = Date.now();
    const uploadRes = await fetch(upload_url, {
      method:  'PUT',
      headers: { 'Content-Type': ct },
      body:    file,
    });
    appendCoordTiming('S3 upload (direct)', Date.now() - t0Upload, !uploadRes.ok);
    if (!uploadRes.ok) throw new Error(`S3 upload failed: ${uploadRes.status}`);

    /* 3. Start processing */
    btnStart.textContent = 'Starting…';
    const startRes = await timedFetch('Start job / shard',
      config.coordinatorUrl + '/job/start', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ job_id, s3_key, shard_size: shardSize }),
      }
    );
    if (!startRes.ok) throw new Error(`job/start failed: ${await startRes.text()}`);
    const startData = await startRes.json();

    /* 4. Show progress UI and begin polling */
    state.jobStartMs = Date.now();
    state.hasLabel   = false; // will be set on first status response
    jobIdDisplay.textContent = job_id.slice(0, 8) + '…';
    workersTotal.textContent = startData.total_shards;
    workersDone.textContent  = '0';
    showSection(secProgress);
    showSection(secTiming);
    showSection(secShardLog);
    progressDetail.textContent =
      `${startData.total_rows} reviews · ${startData.total_shards} shards · ${startData.shard_size} per shard`;
    updateProgressBar(0, startData.total_shards, 'processing');
    startElapsedTimer();
    startPolling();

  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Request timed out (>20 s) — Lambda cold start? You can retry or wait and try again.'
      : err.message;
    showRunError(msg);
    btnStart.disabled = false;
    btnStart.textContent = 'Start Sentiment Analysis';
  }
}

/* ── Elapsed timer ───────────────────────────────────────────────────── */
function startElapsedTimer() {
  stopElapsedTimer();
  state.elapsedTimer = setInterval(() => {
    if (state.jobStartMs === null) return;
    elapsedTime.textContent = formatElapsed(Date.now() - state.jobStartMs);
  }, 1000);
}

function stopElapsedTimer() {
  if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
}

/* ── Polling ─────────────────────────────────────────────────────────── */
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollStatus, POLL_INTERVAL_MS);
  pollStatus();
}

function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function pollStatus() {
  state.pollCount++;
  const label = `Status poll #${state.pollCount}`;
  try {
    const res = await timedFetch(
      label,
      `${config.coordinatorUrl}/job/status?job_id=${state.jobId}`
    );
    if (!res.ok) return;
    const d = await res.json();

    state.hasLabel = d.has_label;
    colAccuracyHdr.classList.toggle('hidden', !d.has_label);

    updateProgressBar(d.completed_shards, d.total_shards, d.status);
    workersDone.textContent  = d.completed_shards;
    workersTotal.textContent = d.total_shards;

    // Append newly completed shards to the log table
    if (Array.isArray(d.shards)) {
      for (const shard of d.shards) {
        if (!state.seenShards.has(shard.shard_id)) {
          state.seenShards.add(shard.shard_id);
          appendShardRow(shard, d.has_label);
        }
      }
      shardLogCount.textContent =
        `(${state.seenShards.size} / ${d.total_shards} complete)`;
    }

    if (d.status === 'completed') {
      stopPolling();
      stopElapsedTimer();
      setStatusBadge('completed');
      await fetchResults();
    } else if (d.status === 'failed') {
      stopPolling();
      stopElapsedTimer();
      setStatusBadge('failed');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      appendCoordTiming(label + ' (timed out)', COORDINATOR_TIMEOUT_MS, true);
    }
    /* Non-fatal — keep polling */
  }
}

function updateProgressBar(done, total, status) {
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  progressFill.style.width = pct + '%';
  progressPct.textContent  = pct + '%';
  setStatusBadge(status);
}

function setStatusBadge(status) {
  statusBadge.className   = `badge badge-${status}`;
  statusBadge.textContent = status;
}

/* ── Coordinator timing table ────────────────────────────────────────── */
function appendCoordTiming(label, durationMs, isError) {
  state.coordTimings.push(durationMs);
  const tr = document.createElement('tr');
  const ts = new Date().toLocaleTimeString();
  tr.innerHTML = `
    <td>${label}${isError ? ' <span style="color:var(--neg)">(error)</span>' : ''}</td>
    <td class="num ${durationMs > 10000 ? 'slow' : durationMs < 500 ? 'fast' : ''}">${durationMs.toLocaleString()} ms</td>
    <td class="ts">${ts}</td>
  `;
  coordTimingBody.appendChild(tr);
}

function clearCoordTimingTable() {
  coordTimingBody.innerHTML = '';
}

/* ── Shard log table ─────────────────────────────────────────────────── */
function appendShardRow(shard, hasLabel) {
  const tr     = document.createElement('tr');
  const total  = shard.total  ?? 0;
  const pos    = shard.positive ?? 0;
  const neg    = shard.negative ?? 0;
  const posP   = total > 0 ? (pos / total * 100).toFixed(1) : '—';
  const negP   = total > 0 ? (neg / total * 100).toFixed(1) : '—';
  const execS  = shard.execution_time_s != null ? shard.execution_time_s.toFixed(1) + ' s' : '—';

  let accuracyCell = '<td class="num">—</td>';
  if (hasLabel && shard.total_labeled > 0) {
    const acc = (shard.correct / shard.total_labeled * 100).toFixed(1);
    accuracyCell = `<td class="num">${acc}%</td>`;
  } else if (hasLabel) {
    accuracyCell = '<td class="num">n/a</td>';
  }

  tr.innerHTML = `
    <td class="num">${shard.shard_id}</td>
    <td class="num">${total}</td>
    <td class="num tag-pos">${pos} <span class="muted">(${posP}%)</span></td>
    <td class="num tag-neg">${neg} <span class="muted">(${negP}%)</span></td>
    ${accuracyCell}
    <td class="num">${execS}</td>
  `;
  shardLogBody.appendChild(tr);
}

function clearShardLog() {
  shardLogBody.innerHTML   = '';
  shardLogCount.textContent = '';
}

/* ── Results ─────────────────────────────────────────────────────────── */
async function fetchResults() {
  try {
    const res = await timedFetch(
      'Fetch results',
      `${config.coordinatorUrl}/job/results?job_id=${state.jobId}`
    );
    if (!res.ok) return;
    const d = await res.json();
    displayResults(d);
  } catch (e) {
    showRunError('Could not fetch results: ' + e.message);
  }
}

function displayResults(d) {
  resTotal.textContent    = d.total.toLocaleString();
  resPositive.textContent = `${d.positive.toLocaleString()} (${d.positive_pct}%)`;
  resNegative.textContent = `${(100 - d.positive_pct).toFixed(1)}% · ${d.negative.toLocaleString()}`;

  if (d.accuracy != null) {
    resAccuracy.textContent = d.accuracy.toFixed(1) + '%';
    statAccuracy.classList.remove('hidden');
  }

  sentBarPos.style.width    = d.positive_pct + '%';
  sentBarNeg.style.width    = (100 - d.positive_pct) + '%';
  sentBarPosLbl.textContent = d.positive_pct + '% pos';
  sentBarNegLbl.textContent = (100 - d.positive_pct).toFixed(1) + '% neg';
  sentBarWrap.hidden        = false;

  // Timing summary
  const totalMs = state.jobStartMs ? Date.now() - state.jobStartMs : 0;
  resElapsed.textContent = formatElapsed(totalMs);

  // Worker timing stats from completed shards in the log table
  const workerTimes = Array.from(state.seenShards)
    .map(id => {
      const row = shardLogBody.querySelectorAll('tr')[id];
      return row ? null : null; // use coordTimings approach instead
    });

  // Re-derive from shard data we've accumulated
  const execTimes = [];
  shardLogBody.querySelectorAll('tr').forEach(tr => {
    const lastCell = tr.querySelector('td:last-child');
    if (lastCell) {
      const t = parseFloat(lastCell.textContent);
      if (!isNaN(t)) execTimes.push(t);
    }
  });

  if (execTimes.length > 0) {
    const avg = execTimes.reduce((a, b) => a + b, 0) / execTimes.length;
    resWorkerAvg.textContent = avg.toFixed(1) + ' s';
    resWorkerMin.textContent = Math.min(...execTimes).toFixed(1) + ' s';
    resWorkerMax.textContent = Math.max(...execTimes).toFixed(1) + ' s';
  }

  // Coordinator timing average
  if (state.coordTimings.length > 0) {
    const avg = state.coordTimings.reduce((a, b) => a + b, 0) / state.coordTimings.length;
    resCoordAvg.textContent = Math.round(avg).toLocaleString() + ' ms';
  }

  showSection(secResults);
  btnStart.textContent = 'Start Sentiment Analysis';
}

/* ── Reset ───────────────────────────────────────────────────────────── */
btnNewJob.addEventListener('click', () => {
  stopPolling();
  stopElapsedTimer();
  state.jobId      = null;
  state.s3Key      = null;
  state.jobStartMs = null;
  clearFile();
  hideSection(secProgress);
  hideSection(secTiming);
  hideSection(secShardLog);
  hideSection(secResults);
  statAccuracy.classList.add('hidden');
  sentBarWrap.hidden = true;
  setStatusBadge('processing');
  progressFill.style.width = '0%';
  progressPct.textContent  = '0%';
  btnStart.textContent     = 'Start Sentiment Analysis';
  clearCoordTimingTable();
  clearShardLog();
  elapsedTime.textContent = '0:00';
});

/* ── Utilities ───────────────────────────────────────────────────────── */
function showSection(el) { el.classList.remove('hidden'); }
function hideSection(el) { el.classList.add('hidden'); }

function showRunError(msg) {
  runError.textContent = msg;
  runError.classList.toggle('hidden', !msg);
}

function formatBytes(n) {
  if (n < 1024)    return n + ' B';
  if (n < 1024**2) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024**2).toFixed(1) + ' MB';
}

function formatElapsed(ms) {
  const s   = Math.floor(ms / 1000);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return min > 0
    ? `${min}m ${sec.toString().padStart(2, '0')}s`
    : `${sec}s`;
}
