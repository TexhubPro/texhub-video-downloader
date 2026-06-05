// content.js — Runs in ISOLATED world
// Bridges messages from interceptor.js (MAIN world) → background service worker,
// performs page scan, adds download overlay on video elements.

// ── Forward detections from MAIN world ──

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__texhub_media) return;
  reportMedia(event.data.url, event.data.kind, event.data.pageUrl || location.href);
});

// Send a detection to the background worker, picking the right message by kind.
function reportMedia(url, kind, pageUrl = location.href) {
  if (!url) return;
  let abs = url;
  try { abs = new URL(url, location.href).href; } catch {}
  const type = kind === 'file' || (kind == null && isDirectVideoUrl(abs)) ? 'VIDEO_FOUND'
             : isHlsUrl(abs) ? 'M3U8_FOUND'
             : null;
  if (!type) return;
  chrome.runtime.sendMessage({ type, url: abs, pageUrl }).catch(() => {});
}

// ── One-time page scan ──

function scanPage() {
  document.querySelectorAll('video, source').forEach((el) => {
    const src = el.src || el.getAttribute('src');
    if (!src) return;
    if (isHlsUrl(src)) reportMedia(src, 'hls');
    else if (isDirectVideoUrl(src)) reportMedia(src, 'file');
  });

  document.querySelectorAll('script:not([src])').forEach((script) => {
    const text = script.textContent || '';
    (text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || [])
      .forEach((url) => reportMedia(url, 'hls'));
    (text.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m4v|webm|mkv|mov)[^\s"'<>]*/gi) || [])
      .forEach((url) => reportMedia(url, 'file'));
  });

  // After scan, attach overlays to any video elements
  attachOverlays();
}

if (document.readyState === 'complete') {
  scanPage();
} else {
  window.addEventListener('load', () => setTimeout(scanPage, 1000));
}

// ========================
// OVERLAY ON VIDEO ELEMENTS
// ========================

const OVERLAY_ATTR = 'data-m3u8-overlay';

function injectStyles() {
  if (document.getElementById('m3u8-dl-styles')) return;
  const style = document.createElement('style');
  style.id = 'm3u8-dl-styles';
  style.textContent = `
    .m3u8-dl-wrapper { position: relative; }

    .m3u8-dl-overlay {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 2147483647;
      opacity: 0;
      transition: opacity .2s;
      pointer-events: none;
    }
    .m3u8-dl-wrapper:hover .m3u8-dl-overlay,
    .m3u8-dl-overlay.visible {
      opacity: 1;
      pointer-events: auto;
    }

    .m3u8-dl-btn {
      width: 40px; height: 40px;
      border-radius: 50%;
      border: none;
      background: rgba(240,144,24,.92);
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 8px rgba(0,0,0,.4);
      transition: transform .15s, background .15s;
      backdrop-filter: blur(4px);
    }
    .m3u8-dl-btn:hover { background: #d97e10; transform: scale(1.1); }
    .m3u8-dl-btn:active { transform: scale(.95); }
    .m3u8-dl-btn svg { width: 20px; height: 20px; }

    /* Quality picker modal */
    .m3u8-modal-bg {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(0,0,0,.6);
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(2px);
    }
    .m3u8-modal {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 20px;
      min-width: 280px;
      max-width: 360px;
      color: #e6edf3;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      box-shadow: 0 8px 32px rgba(0,0,0,.5);
    }
    .m3u8-modal h3 {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 14px;
      background: linear-gradient(135deg, #f6a942, #f09018);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .m3u8-modal-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      margin-bottom: 6px;
      border-radius: 8px;
      border: 1px solid #30363d;
      background: #0d1117;
      cursor: pointer;
      transition: border-color .2s, background .2s;
    }
    .m3u8-modal-item:hover {
      border-color: #f09018;
      background: rgba(240,144,24,.08);
    }
    .m3u8-modal-item .qlabel {
      font-size: 13px;
      font-weight: 600;
    }
    .m3u8-modal-item .qmeta {
      font-size: 11px;
      color: #8b949e;
    }
    .m3u8-modal-close {
      width: 100%;
      margin-top: 10px;
      padding: 8px;
      border-radius: 8px;
      border: 1px solid #30363d;
      background: transparent;
      color: #8b949e;
      font-size: 12px;
      cursor: pointer;
      transition: all .2s;
    }
    .m3u8-modal-close:hover { border-color: #ef4444; color: #ef4444; }
  `;
  document.head.appendChild(style);
}

function attachOverlays() {
  injectStyles();
  document.querySelectorAll('video').forEach(addOverlayToVideo);

  // Watch for dynamically added videos
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO') addOverlayToVideo(n);
        n.querySelectorAll?.('video').forEach(addOverlayToVideo);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

function addOverlayToVideo(video) {
  if (video.hasAttribute(OVERLAY_ATTR)) return;
  video.setAttribute(OVERLAY_ATTR, '1');

  // Wrap video if needed
  let wrapper = video.parentElement;
  const parentStyle = getComputedStyle(wrapper);
  if (parentStyle.position === 'static') {
    wrapper.style.position = 'relative';
  }

  const overlay = document.createElement('div');
  overlay.className = 'm3u8-dl-overlay';

  const btn = document.createElement('button');
  btn.className = 'm3u8-dl-btn';
  btn.title = 'Download video';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>`;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onOverlayClick();
  });

  overlay.appendChild(btn);
  wrapper.appendChild(overlay);
}

function onOverlayClick() {
  chrome.runtime.sendMessage({ type: 'GET_TAB_STREAMS' }, (res) => {
    if (chrome.runtime.lastError || !res?.streams?.length) return;

    const streams = res.streams.filter(s => s.parsed);
    if (!streams.length) return;

    // If single media stream or direct file → download directly
    if (streams.length === 1 && (streams[0].type === 'media' || streams[0].type === 'file')) {
      chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        streamId: streams[0].id,
        variantIndex: 0
      });
      return;
    }

    // If single master with one variant → download directly
    if (streams.length === 1 && streams[0].type === 'master' && streams[0].variants.length === 1) {
      chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        streamId: streams[0].id,
        variantIndex: 0
      });
      return;
    }

    // Multiple qualities or streams → show picker
    showQualityModal(streams);
  });
}

function showQualityModal(streams) {
  // Remove existing modal
  document.querySelector('.m3u8-modal-bg')?.remove();

  const bg = document.createElement('div');
  bg.className = 'm3u8-modal-bg';

  const modal = document.createElement('div');
  modal.className = 'm3u8-modal';
  modal.innerHTML = '<h3>Select Quality</h3>';

  for (const stream of streams) {
    if (stream.type === 'master' && stream.variants.length) {
      stream.variants.forEach((v, idx) => {
        const item = document.createElement('div');
        item.className = 'm3u8-modal-item';

        const label = qualityLabel(v.resolution, v.bandwidth);
        const res = v.resolution || (v.bandwidth ? Math.round(v.bandwidth / 1000) + 'k' : '');

        item.innerHTML = `<span class="qlabel">${label}</span><span class="qmeta">${res}</span>`;
        item.addEventListener('click', () => {
          bg.remove();
          chrome.runtime.sendMessage({
            type: 'START_DOWNLOAD',
            streamId: stream.id,
            variantIndex: idx
          });
        });
        modal.appendChild(item);
      });
    } else if (stream.type === 'media' || stream.type === 'file') {
      const item = document.createElement('div');
      item.className = 'm3u8-modal-item';
      const meta = stream.type === 'file'
        ? (stream.format || 'Video') + ' file'
        : stream.segments.length + ' segments';
      item.innerHTML = `<span class="qlabel">Default</span><span class="qmeta">${meta}</span>`;
      item.addEventListener('click', () => {
        bg.remove();
        chrome.runtime.sendMessage({
          type: 'START_DOWNLOAD',
          streamId: stream.id,
          variantIndex: 0
        });
      });
      modal.appendChild(item);
    }
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'm3u8-modal-close';
  closeBtn.textContent = 'Cancel';
  closeBtn.addEventListener('click', () => bg.remove());
  modal.appendChild(closeBtn);

  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
  bg.appendChild(modal);
  document.body.appendChild(bg);
}

// qualityLabel() is provided by src/shared/utils.js, injected before this
// content script (see content_scripts order in manifest.json).
