/* ── Config & constants ───────────────────────────────────────────────── */
const COORDINATOR_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS       = 3_000;

/* ── State ───────────────────────────────────────────────────────────── */
let state = {
  file:      null,   // File object selected by user
  jobId:     null,
  s3Key:     null,
  pollTimer: null,
};

/* ── DOM refs ────────────────────────────────────────────────────────── */
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const fileInfo       = document.getElementById('file-info');
const fileName       = document.getElementById('file-name');
const fileSize       = document.getElementById('file-size');
const btnClearFile   = document.getElementById('btn-clear-file');
const shardSelect    = document.getElementById('shard-size-select');
const btnStart       = document.getElementById('btn-start');
const runError       = document.getElementById('run-error');
const secProgress    = document.getElementById('section-progress');
const jobIdDisplay   = document.getElementById('job-id-display');
const statusBadge    = document.getElementById('status-badge');
const progressFill   = document.getElementById('progress-bar-fill');
const progressPct    = document.getElementById('progress-pct');
const progressDetail = document.getElementById('progress-detail');
const secResults     = document.getElementById('section-results');
const resTotal       = document.getElementById('res-total');
const resPositive    = document.getElementById('res-positive');
const resNegative    = document.getElementById('res-negative');
const resAccuracy    = document.getElementById('res-accuracy');
const statAccuracy   = document.getElementById('stat-accuracy');
const sentBarWrap    = document.getElementById('sentiment-bar-wrap');
const sentBarPos     = document.getElementById('sentiment-bar-pos');
const sentBarNeg     = document.getElementById('sentiment-bar-neg');
const sentBarPosLbl  = document.getElementById('sentiment-bar-pos-label');
const sentBarNegLbl  = document.getElementById('sentiment-bar-neg-label');
const btnNewJob      = document.getElementById('btn-new-job');

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

/* ── Fetch with 20-second timeout ────────────────────────────────────── */
async function fetchWithTimeout(url, options = {}, ms = COORDINATOR_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
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

  try {
    /* 1. Get presigned upload URL */
    const urlRes = await fetchWithTimeout(config.coordinatorUrl + '/upload-url', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filename: file.name, content_type: ct }),
    });
    if (!urlRes.ok) throw new Error(`upload-url failed: ${await urlRes.text()}`);
    const { job_id, upload_url, s3_key } = await urlRes.json();

    state.jobId = job_id;
    state.s3Key = s3_key;

    /* 2. Upload file directly to S3 (no timeout — large files may take time) */
    btnStart.textContent = 'Uploading to S3…';
    const uploadRes = await fetch(upload_url, {
      method:  'PUT',
      headers: { 'Content-Type': ct },
      body:    file,
    });
    if (!uploadRes.ok) throw new Error(`S3 upload failed: ${uploadRes.status}`);

    /* 3. Start processing */
    btnStart.textContent = 'Starting…';
    const startRes = await fetchWithTimeout(config.coordinatorUrl + '/job/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ job_id, s3_key, shard_size: shardSize }),
    });
    if (!startRes.ok) throw new Error(`job/start failed: ${await startRes.text()}`);
    const startData = await startRes.json();

    /* 4. Show progress UI */
    jobIdDisplay.textContent = job_id.slice(0, 8) + '…';
    showSection(secProgress);
    progressDetail.textContent =
      `${startData.total_rows} reviews · ${startData.total_shards} shards · shard size ${startData.shard_size}`;
    updateProgress(0, startData.total_shards, 'processing');
    startPolling();

  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Request timed out (>20 s) — Lambda cold start?' : err.message;
    showRunError(msg);
    btnStart.disabled = false;
    btnStart.textContent = 'Start Sentiment Analysis';
  }
}

/* ── Progress polling ────────────────────────────────────────────────── */
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollStatus, POLL_INTERVAL_MS);
  pollStatus();
}

function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function pollStatus() {
  try {
    const res = await fetchWithTimeout(
      `${config.coordinatorUrl}/job/status?job_id=${state.jobId}`
    );
    if (!res.ok) return;
    const d = await res.json();
    updateProgress(d.completed_shards, d.total_shards, d.status);

    if (d.status === 'completed') {
      stopPolling();
      await fetchResults();
    } else if (d.status === 'failed') {
      stopPolling();
      setStatusBadge('failed');
    }
  } catch (_) { /* ignore transient poll errors */ }
}

function updateProgress(done, total, status) {
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  progressFill.style.width = pct + '%';
  progressPct.textContent  = pct + '%';
  if (status !== 'processing') {
    progressDetail.textContent = status === 'completed'
      ? `All ${total} shards completed.`
      : `Status: ${status}`;
  }
  setStatusBadge(status);
}

function setStatusBadge(status) {
  statusBadge.className = `badge badge-${status}`;
  statusBadge.textContent = status;
}

/* ── Results ─────────────────────────────────────────────────────────── */
async function fetchResults() {
  try {
    const res = await fetchWithTimeout(
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

  showSection(secResults);
  btnStart.textContent = 'Start Sentiment Analysis';
}

/* ── Reset ───────────────────────────────────────────────────────────── */
btnNewJob.addEventListener('click', () => {
  stopPolling();
  state.jobId = null;
  state.s3Key = null;
  clearFile();
  hideSection(secProgress);
  hideSection(secResults);
  statAccuracy.classList.add('hidden');
  sentBarWrap.hidden = true;
  setStatusBadge('processing');
  progressFill.style.width = '0%';
  progressPct.textContent  = '0%';
  btnStart.textContent = 'Start Sentiment Analysis';
});

/* ── Utilities ───────────────────────────────────────────────────────── */
function showSection(el) { el.classList.remove('hidden'); }
function hideSection(el) { el.classList.add('hidden'); }
function showRunError(msg) {
  runError.textContent = msg;
  runError.classList.toggle('hidden', !msg);
}
function formatBytes(n) {
  if (n < 1024)       return n + ' B';
  if (n < 1024**2)    return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024**2).toFixed(1) + ' MB';
}
