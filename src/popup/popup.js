// TexHub Video Downloader — Popup UI
// Stream display, quality selection. Downloads run in a dedicated download tab
// managed by the background worker, so they continue even when the popup is closed.
// Shows active downloads from ALL tabs, not just the current one.
// Shared helpers (fmtSize, fmtDuration, qualityLabel, getDomain, esc) come from
// src/shared/utils.js, loaded before this script in popup.html.

let currentStreams = [];
const activeDownloads = {};
const downloadMetaMap = {};
const hideTimers = {};

document.addEventListener('DOMContentLoaded', init);

// ========================
// INITIALISATION
// ========================

async function init() {
  await loadStreams();

  // Restore active download states (persists across popup close/reopen)
  chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS' }, (res) => {
    if (chrome.runtime.lastError || !res?.downloads) return;
    Object.assign(activeDownloads, res.downloads);
    if (res.meta) Object.assign(downloadMetaMap, res.meta);
    // Schedule auto-hide for any already-completed downloads
    for (const id in activeDownloads) {
      if (activeDownloads[id].status === 'complete') scheduleAutoHide(id);
    }
    render();
  });

  // Listen for live progress relayed from the download tab via the background worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'FETCH_PROGRESS') {
      activeDownloads[msg.downloadId] = {
        status: msg.status, progress: msg.progress || 0,
        total: msg.total, current: msg.current,
        bytes: msg.bytes || 0, error: msg.error
      };
      updateProgressUI(msg.downloadId);
    }
    if (msg.type === 'FETCH_COMPLETE') {
      activeDownloads[msg.downloadId] = { status: 'complete', progress: 100, bytes: msg.size };
      render();
      scheduleAutoHide(msg.downloadId);
    }
  });

  // Auto-refresh stream list every 2 s
  setInterval(loadStreams, 2000);
}

// ========================
// AUTO-HIDE COMPLETED DOWNLOADS
// ========================

function scheduleAutoHide(downloadId) {
  if (hideTimers[downloadId]) clearTimeout(hideTimers[downloadId]);
  hideTimers[downloadId] = setTimeout(() => {
    const card = document.querySelector(`.stream-card[data-sid="${downloadId}"]`);
    if (card && activeDownloads[downloadId]?.status === 'complete') {
      card.classList.add('fading');
      setTimeout(() => {
        delete activeDownloads[downloadId];
        delete hideTimers[downloadId];
        render();
      }, 500);
    }
  }, 3000);
}

// ========================
// LOAD STREAMS FROM BACKGROUND
// ========================

function loadStreams() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (response) => {
      if (chrome.runtime.lastError || !response) { resolve(); return; }

      const incoming = response.streams || [];
      // Re-render when a stream appears/parses, or when a file's size first arrives.
      const key = s => s.id + s.parsed + (s.filesize ? 1 : 0);
      const idsNow  = incoming.map(key).join(',');
      const idsPrev = currentStreams.map(key).join(',');

      if (idsNow !== idsPrev) {
        currentStreams = incoming;
        render();
      } else {
        currentStreams = incoming;
      }

      // Badge shows current tab + active downloads from other tabs
      const activeCount = Object.keys(activeDownloads).filter(id =>
        !['complete', 'error', 'cancelled'].includes(activeDownloads[id]?.status)).length;
      const totalCount = currentStreams.length + activeCount;
      document.getElementById('count').textContent = totalCount || '0';
      resolve();
    });
  });
}

// ========================
// RENDER
// ========================

function render() {
  const content    = document.getElementById('content');
  const emptyState = document.getElementById('emptyState');

  // Build list: current tab streams + active downloads from other tabs
  const currentIds = new Set(currentStreams.map(s => s.id));
  const ACTIVE_STATES = ['starting', 'downloading', 'paused', 'merging', 'converting', 'saving'];
  const orphanIds = Object.keys(activeDownloads)
    .filter(id => !currentIds.has(id) && ACTIVE_STATES.includes(activeDownloads[id]?.status));

  const allCards = [...currentStreams];
  for (const id of orphanIds) {
    const meta = downloadMetaMap[id] || {};
    allCards.push({
      id,
      url: meta.url || '',
      type: 'media',
      variants: [],
      segments: new Array(meta.segmentCount || 0),
      duration: meta.duration || 0,
      parsed: true,
      _crossTab: true
    });
  }

  if (allCards.length === 0) {
    content.style.display    = 'none';
    emptyState.style.display = 'flex';
    return;
  }

  content.style.display    = 'flex';
  emptyState.style.display = 'none';
  content.innerHTML = allCards.map(renderCard).join('');

  // Attach listeners
  content.querySelectorAll('.quality-pill').forEach(p => p.addEventListener('click', onQualityClick));
  content.querySelectorAll('.download-btn').forEach(b => b.addEventListener('click', onDownloadClick));
  content.querySelectorAll('.copy-btn').forEach(b => b.addEventListener('click', onCopyClick));
  content.querySelectorAll('.pause-btn').forEach(b => b.addEventListener('click', onPauseClick));
  content.querySelectorAll('.resume-btn').forEach(b => b.addEventListener('click', onResumeClick));
  content.querySelectorAll('.cancel-btn').forEach(b => b.addEventListener('click', onCancelClick));
  content.querySelectorAll('.preview-video').forEach(attachPreview);
}

// Fill resolution / duration from the <video>'s metadata (works cross-origin —
// only pixel readback is blocked, not dimensions or duration).
function attachPreview(video) {
  video.addEventListener('loadedmetadata', () => {
    const card = video.closest('.stream-card');
    if (!card) return;
    if (video.videoWidth && video.videoHeight) {
      const el = card.querySelector('[data-role="res"]');
      if (el) el.textContent = video.videoWidth + '×' + video.videoHeight;
    }
    if (isFinite(video.duration) && video.duration > 0) {
      const el = card.querySelector('[data-role="dur"]');
      if (el) el.textContent = fmtDuration(video.duration);
    }
  }, { once: true });

  // If the container can't be previewed inline, hide the player but keep the meta.
  video.addEventListener('error', () => { video.style.display = 'none'; }, { once: true });

  // Click to play / pause for a quick look.
  video.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {}); else video.pause();
  });
}

// ── Single stream card ──

function renderCard(stream) {
  const domain   = getDomain(stream.url);
  const duration = stream.duration ? fmtDuration(stream.duration) : '--:--';
  const dl       = activeDownloads[stream.id];
  const busy     = dl && !['complete', 'error', 'cancelled'].includes(dl.status);
  const paused   = dl && dl.status === 'paused';
  const crossTab = stream._crossTab;

  // Quality pills (hide for cross-tab downloads)
  let qualityHtml = '';
  if (!crossTab) {
    if (stream.type === 'master' && stream.variants.length) {
      qualityHtml = `<div class="quality-selector" data-sid="${esc(stream.id)}">
        ${stream.variants.map((v, i) => {
          const label = qualityLabel(v.resolution, v.bandwidth);
          const res   = v.resolution || (v.bandwidth ? Math.round(v.bandwidth / 1000) + 'k' : '');
          const size  = (stream.duration > 0 && v.bandwidth > 0)
                          ? '~' + fmtSize(v.bandwidth * stream.duration / 8) : '';
          return `<div class="quality-pill${i === 0 ? ' selected' : ''}"
                       data-sid="${esc(stream.id)}" data-idx="${i}"
                       data-vurl="${esc(v.url)}">
            <span class="quality-label">${esc(label)}</span>
            <span class="quality-res">${esc(res)}</span>
            ${size ? `<span class="quality-size">${esc(size)}</span>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    } else if (stream.type === 'media') {
      qualityHtml = `<div class="quality-selector" data-sid="${esc(stream.id)}">
        <div class="quality-pill selected" data-sid="${esc(stream.id)}" data-idx="0">
          <span class="quality-label">Default</span>
          <span class="quality-res">${stream.segments.length} segments</span>
        </div>
      </div>`;
    }
  }

  // Inline video preview for direct files (thumbnail + resolution / duration / size).
  let previewHtml = '';
  if (!crossTab && stream.type === 'file') {
    const sizeTxt = stream.filesize ? esc(fmtSize(stream.filesize)) : '—';
    previewHtml = `<div class="file-preview">
      <video class="preview-video" src="${esc(stream.url)}" muted preload="metadata" playsinline></video>
      <div class="preview-meta">
        <span class="chip accent">${esc(stream.format || 'VIDEO')}</span>
        <span class="chip" data-role="res">—</span>
        <span class="chip" data-role="dur">${stream.duration > 0 ? esc(fmtDuration(stream.duration)) : '—'}</span>
        <span class="chip" data-role="size">${sizeTxt}</span>
      </div>
    </div>`;
  }

  // Progress
  let progressHtml = '';
  if (dl) {
    const cls = dl.status === 'complete' ? 'status-complete'
              : dl.status === 'error'    ? 'status-error'
              : dl.status === 'paused'   ? 'status-paused' : '';
    let txt = '';
    if (dl.status === 'starting')    txt = 'Starting\u2026';
    if (dl.status === 'downloading') txt = `Downloading ${dl.current || 0} / ${dl.total || '?'}`;
    if (dl.status === 'paused')      txt = `Paused \u2014 ${dl.current || 0} / ${dl.total || '?'}`;
    if (dl.status === 'merging')     txt = 'Merging segments\u2026';
    if (dl.status === 'converting')  txt = 'Converting to MP4\u2026';
    if (dl.status === 'saving')      txt = 'Saving file\u2026';
    if (dl.status === 'complete')    txt = 'Complete! ' + fmtSize(dl.bytes || 0);
    if (dl.status === 'error')       txt = 'Error: ' + (dl.error || 'unknown');

    progressHtml = `
      <div class="progress-container active">
        <div class="progress-bar"><div class="progress-fill${dl.status === 'paused' ? ' paused' : ''}" style="width:${dl.progress||0}%"></div></div>
        <div class="progress-info">
          <span class="progress-status ${cls}">
            <span class="status-dot"></span>
            <span class="status-text">${esc(txt)}</span>
          </span>
          <span class="progress-bytes">${dl.bytes ? fmtSize(dl.bytes) : ''}</span>
        </div>
      </div>`;
  }

  // Control buttons (pause/resume/cancel)
  let controlsHtml = '';
  if (busy) {
    controlsHtml = `<div class="download-controls">
      ${paused
        ? `<button class="ctrl-btn resume-btn" data-sid="${esc(stream.id)}" title="Resume">
            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>
            Resume
          </button>`
        : `<button class="ctrl-btn pause-btn" data-sid="${esc(stream.id)}" title="Pause">
            <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            Pause
          </button>`
      }
      <button class="ctrl-btn cancel-btn" data-sid="${esc(stream.id)}" title="Cancel">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Cancel
      </button>
    </div>`;
  }

  // Cross-tab badge
  const crossTabBadge = crossTab
    ? `<span class="cross-tab-badge">Other tab</span>` : '';

  return `
  <div class="stream-card${dl?.status === 'complete' ? ' complete' : ''}" data-sid="${esc(stream.id)}">
    <div class="stream-header">
      <div class="stream-icon">
        <svg viewBox="0 0 24 24" fill="none"><polygon points="6,3 20,12 6,21" fill="#f09018"/></svg>
      </div>
      <div class="stream-info">
        <div class="stream-domain">${esc(domain)} ${crossTabBadge}</div>
        <div class="stream-meta">
          ${stream.type !== 'file' || stream.duration > 0
            ? `<span class="meta-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                ${esc(duration)}
              </span>` : ''}
          ${!crossTab && stream.type === 'master'
            ? `<span class="meta-item">${stream.variants.length} qualities</span>` : ''}
          ${!crossTab && stream.type === 'media'
            ? `<span class="meta-item">${stream.segments.length} segments</span>` : ''}
          ${!crossTab && stream.type === 'file'
            ? `<span class="meta-item">${esc(stream.format || 'Video')} file</span>` : ''}
        </div>
      </div>
      ${!crossTab ? `<button class="copy-btn" data-url="${esc(stream.url)}" title="Copy URL">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
        </svg>
      </button>` : ''}
    </div>

    ${!crossTab ? `<div class="stream-url"><code>${esc(stream.url)}</code></div>` : ''}

    ${previewHtml}

    ${qualityHtml}

    <div class="download-section">
      ${busy ? `
        <div class="download-warning active" style="border-color:rgba(16,185,129,.18);background:rgba(16,185,129,.07);color:#10b981">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <span>${paused ? 'Download paused' : 'Download continues in background'}</span>
        </div>` : ''}

      ${!crossTab ? `<button class="download-btn" data-sid="${esc(stream.id)}" ${busy ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        ${busy ? (paused ? 'Paused' : 'Downloading\u2026') : 'Download'}
      </button>` : ''}

      ${controlsHtml}
      ${progressHtml}
    </div>
  </div>`;
}

// ========================
// EVENT HANDLERS
// ========================

function onQualityClick(e) {
  const pill     = e.currentTarget;
  const selector = pill.closest('.quality-selector');
  selector.querySelectorAll('.quality-pill').forEach(p => p.classList.remove('selected'));
  pill.classList.add('selected');
}

function onCopyClick(e) {
  const btn = e.currentTarget;
  const url = btn.dataset.url;
  navigator.clipboard.writeText(url).then(() => {
    const prev = btn.innerHTML;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5">
      <polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => { btn.innerHTML = prev; }, 1200);
  });
}

async function onDownloadClick(e) {
  const btn      = e.currentTarget;
  const streamId = btn.dataset.sid;

  const card     = btn.closest('.stream-card');
  const selPill  = card.querySelector('.quality-pill.selected');
  const varIdx   = selPill ? parseInt(selPill.dataset.idx, 10) : 0;

  btn.disabled    = true;
  btn.textContent = 'Preparing\u2026';

  activeDownloads[streamId] = { status: 'starting', progress: 0, current: 0, total: 0, bytes: 0 };
  render();

  chrome.runtime.sendMessage({
    type: 'START_DOWNLOAD',
    streamId,
    variantIndex: varIdx
  });
}

function onPauseClick(e) {
  const sid = e.currentTarget.dataset.sid;
  chrome.runtime.sendMessage({ type: 'PAUSE_DOWNLOAD', downloadId: sid });
  if (activeDownloads[sid]) activeDownloads[sid].status = 'paused';
  render();
}

function onResumeClick(e) {
  const sid = e.currentTarget.dataset.sid;
  chrome.runtime.sendMessage({ type: 'RESUME_DOWNLOAD', downloadId: sid });
  if (activeDownloads[sid]) activeDownloads[sid].status = 'downloading';
  render();
}

function onCancelClick(e) {
  const sid = e.currentTarget.dataset.sid;
  chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD', downloadId: sid });
  delete activeDownloads[sid];
  render();
}

// ── Incremental progress update (avoids full re-render) ──

function updateProgressUI(sid) {
  const card = document.querySelector(`.stream-card[data-sid="${sid}"]`);
  if (!card) { render(); return; }   // card might not exist yet (cross-tab) → full render

  const dl = activeDownloads[sid];
  if (!dl) return;

  let container = card.querySelector('.progress-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'progress-container active';
    container.innerHTML = `
      <div class="progress-bar"><div class="progress-fill"></div></div>
      <div class="progress-info">
        <span class="progress-status"><span class="status-dot"></span><span class="status-text"></span></span>
        <span class="progress-bytes"></span>
      </div>`;
    card.querySelector('.download-section').appendChild(container);
  }
  container.classList.add('active');

  const fill  = container.querySelector('.progress-fill');
  const stxt  = container.querySelector('.status-text');
  const bytes = container.querySelector('.progress-bytes');

  fill.style.width = dl.progress + '%';
  if (dl.status === 'paused') fill.classList.add('paused');
  else fill.classList.remove('paused');

  if (dl.status === 'starting')    stxt.textContent = 'Starting\u2026';
  if (dl.status === 'downloading') stxt.textContent = `Downloading ${dl.current} / ${dl.total}`;
  if (dl.status === 'paused')      stxt.textContent = `Paused \u2014 ${dl.current} / ${dl.total}`;
  if (dl.status === 'merging')     stxt.textContent = 'Merging segments\u2026';
  if (dl.status === 'converting')  stxt.textContent = 'Converting to MP4\u2026';

  if (dl.bytes) bytes.textContent = fmtSize(dl.bytes);
}

// Utilities (getDomain, fmtDuration, fmtSize, qualityLabel, esc) are provided by
// src/shared/utils.js, loaded before this script.
