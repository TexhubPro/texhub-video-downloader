// TexHub Video Downloader — Background Service Worker
// Stream detection, playlist parsing, download coordination via tab-based downloader

importScripts(chrome.runtime.getURL('src/shared/utils.js'));

const tabStreams = new Map();
const activeDownloads = {};
const downloadMeta = {};
const downloadHeaderRuleIds = new Map();
// Direct (browser-native) downloads: chrome.downloads id <-> our stream id.
const directDlToStream = new Map();
const streamToDirectDl = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Restore persisted state
chrome.storage.session?.get(['activeDownloads', 'downloadMeta'], (data) => {
  if (data?.activeDownloads) Object.assign(activeDownloads, data.activeDownloads);
  if (data?.downloadMeta) Object.assign(downloadMeta, data.downloadMeta);
});

function persistDownloads() {
  chrome.storage.session?.set({
    activeDownloads: { ...activeDownloads },
    downloadMeta: { ...downloadMeta }
  }).catch(() => {});
}

// ========================
// STREAM DETECTION
// ========================

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const page = details.documentUrl || details.initiator || '';
    if (isHlsUrl(details.url)) {
      addStream(details.tabId, details.url, page, 'hls');
    } else if (isDirectVideoUrl(details.url)) {
      addStream(details.tabId, details.url, page, 'file');
    }
  },
  { urls: ['<all_urls>'] }
);

// isHlsUrl / isDirectVideoUrl / videoFormatLabel / mimeFromName come from src/shared/utils.js.

// Capture the total byte size of direct video files (for the popup preview).
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || !isDirectVideoUrl(details.url)) return;
    const headers = details.responseHeaders || [];
    let size = 0;
    const range = headerValue(headers, 'content-range');    // "bytes 0-1023/123456"
    const m = range && range.match(/\/(\d+)\s*$/);
    if (m) size = parseInt(m[1], 10);
    if (!size) {
      const len = headerValue(headers, 'content-length');
      if (len) size = parseInt(len, 10);
    }
    if (size) setStreamFilesize(details.tabId, details.url, size);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

function headerValue(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h ? h.value || '' : '';
}

function setStreamFilesize(tabId, url, size) {
  const streams = tabStreams.get(tabId);
  if (!streams) return;
  let path;
  try { path = new URL(url).pathname; } catch { path = url; }
  const s = streams.find((st) => {
    try { return new URL(st.url).pathname === path; } catch { return st.url === url; }
  });
  if (s && size > (s.filesize || 0)) s.filesize = size;
}

// ========================
// MESSAGE HANDLING
// ========================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'M3U8_FOUND' && sender.tab) {
    addStream(sender.tab.id, msg.url, msg.pageUrl || sender.tab.url || '', 'hls');
    return;
  }

  if (msg.type === 'VIDEO_FOUND' && sender.tab) {
    addStream(sender.tab.id, msg.url, msg.pageUrl || sender.tab.url || '', 'file');
    return;
  }

  if (msg.type === 'GET_STREAMS') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      sendResponse({ streams: tab ? (tabStreams.get(tab.id) || []) : [] });
    });
    return true;
  }

  if (msg.type === 'GET_TAB_STREAMS') {
    const tabId = sender.tab?.id;
    sendResponse({ streams: tabId ? (tabStreams.get(tabId) || []) : [] });
    return true;
  }

  if (msg.type === 'START_DOWNLOAD') {
    handleStartDownload(msg.streamId, msg.variantIndex).catch(() => {});
    return;
  }

  // Pause / Resume: native downloads use the downloads API; HLS jobs are forwarded
  // to the download tab that owns them.
  if (msg.type === 'PAUSE_DOWNLOAD' || msg.type === 'RESUME_DOWNLOAD') {
    const directId = streamToDirectDl.get(msg.downloadId);
    if (directId != null) {
      if (msg.type === 'PAUSE_DOWNLOAD') chrome.downloads.pause(directId).catch(() => {});
      else chrome.downloads.resume(directId).catch(() => {});
    } else {
      forwardToDownloadTab(msg.downloadId, msg.type);
    }
    if (activeDownloads[msg.downloadId]) {
      activeDownloads[msg.downloadId].status =
        msg.type === 'PAUSE_DOWNLOAD' ? 'paused' : 'downloading';
      persistDownloads();
    }
    return;
  }

  if (msg.type === 'CANCEL_DOWNLOAD') {
    cancelDownload(msg.downloadId).catch(() => {});
    return;
  }

  if (msg.type === 'GET_DOWNLOADS') {
    sendResponse({ downloads: { ...activeDownloads }, meta: { ...downloadMeta } });
    return true;
  }

  // Progress from download tab
  if (msg.type === 'FETCH_PROGRESS') {
    activeDownloads[msg.downloadId] = {
      status: msg.status, progress: msg.progress,
      total: msg.total, current: msg.current,
      bytes: msg.bytes, error: msg.error
    };
    if (msg.status === 'cancelled' || msg.status === 'error') {
      removeDownloadHeaderRules(msg.downloadId);
    }
    persistDownloads();
    return;
  }

  // Download complete from download tab
  if (msg.type === 'FETCH_COMPLETE') {
    activeDownloads[msg.downloadId] = { status: 'complete', progress: 100, bytes: msg.size };
    removeDownloadHeaderRules(msg.downloadId);
    persistDownloads();
    setTimeout(() => {
      if (activeDownloads[msg.downloadId]?.status === 'complete') {
        delete activeDownloads[msg.downloadId];
        delete downloadMeta[msg.downloadId];
        persistDownloads();
      }
    }, 10000);
    return;
  }
});

// ========================
// TAB LIFECYCLE
// ========================

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);

  for (const [downloadId, meta] of Object.entries(downloadMeta)) {
    if (meta.downloadTabId === tabId) {
      removeDownloadHeaderRules(downloadId);
      delete downloadMeta[downloadId].downloadTabId;
      persistDownloads();
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    tabStreams.delete(tabId);
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

// ========================
// STREAM MANAGEMENT
// ========================

async function addStream(tabId, url, pageUrl = '', kind = 'hls') {
  if (!tabStreams.has(tabId)) tabStreams.set(tabId, []);
  const streams = tabStreams.get(tabId);
  const resolvedPageUrl = normalizeHttpUrl(pageUrl) || await getTabHttpUrl(tabId);
  const isFile = kind === 'file';

  let urlPath;
  try { urlPath = new URL(url).pathname; } catch { urlPath = url; }
  const existing = streams.find(s => {
    try { return new URL(s.url).pathname === urlPath; } catch { return s.url === url; }
  });
  if (existing) {
    const incomingUrl = normalizeHttpUrl(url) || url;
    if (incomingUrl && existing.url !== incomingUrl) {
      existing.url = incomingUrl;
      if (existing.type !== 'file') {
        existing.parsed = false;
        existing.error = null;
        parsePlaylist(existing).catch(() => {});
      }
    }
    if (resolvedPageUrl) existing.pageUrl = resolvedPageUrl;
    existing.timestamp = Date.now();
    return;
  }

  const stream = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 7),
    url, timestamp: Date.now(),
    pageUrl: resolvedPageUrl,
    type: isFile ? 'file' : null,
    format: isFile ? videoFormatLabel(url) : '',
    variants: [], segments: [],
    duration: 0, filesize: 0, parsed: isFile, error: null
  };

  streams.push(stream);
  updateBadge(tabId);
  if (!isFile) await parsePlaylist(stream);
}

function updateBadge(tabId) {
  const count = (tabStreams.get(tabId) || []).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#f09018', tabId });
}

// getDomain() / fmtSize() / qualityLabel() etc. live in src/shared/utils.js
// (loaded via importScripts above).

function forwardToDownloadTab(downloadId, type) {
  const tabId = downloadMeta[downloadId]?.downloadTabId;
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type, downloadId }).catch(() => {});
}

async function cancelDownload(downloadId) {
  const tabId = downloadMeta[downloadId]?.downloadTabId;

  // Direct (browser-native) download: cancel it in the download manager.
  const directId = streamToDirectDl.get(downloadId);
  if (directId != null) {
    directDlToStream.delete(directId);
    streamToDirectDl.delete(downloadId);
    chrome.downloads.cancel(directId).catch(() => {});
  }

  await removeDownloadHeaderRules(downloadId);
  delete activeDownloads[downloadId];
  delete downloadMeta[downloadId];
  persistDownloads();
  try { await chrome.storage.local.remove(downloadId); } catch {}
  if (tabId) chrome.tabs.remove(tabId).catch(() => {});
}

function normalizeHttpUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch {
    return '';
  }
}

async function getTabHttpUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return normalizeHttpUrl(tab?.url || '');
  } catch {
    return '';
  }
}

// ========================
// PLAYLIST PARSING
// ========================

async function fetchText(url) {
  const res = await fetch(url, {
    credentials: 'include',
    cache: 'no-store'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function parsePlaylist(stream) {
  try {
    const text = await fetchText(stream.url);

    if (text.includes('#EXT-X-STREAM-INF')) {
      stream.type = 'master';
      stream.variants = parseMaster(text, stream.url);
      if (stream.variants.length > 0) {
        try {
          const vText = await fetchText(stream.variants[0].url);
          const parsed = parseMedia(vText, stream.variants[0].url);
          stream.duration = parsed.duration;
          stream.variants[0].segments = parsed.segments;
          stream.variants[0].duration = parsed.duration;
          stream.variants[0].parsed = true;
        } catch {}
      }
    } else if (text.includes('#EXTINF') || text.includes('#EXT-X-TARGETDURATION')) {
      stream.type = 'media';
      const parsed = parseMedia(text, stream.url);
      stream.segments = parsed.segments;
      stream.duration = parsed.duration;
    }

    stream.parsed = true;
  } catch (e) {
    stream.error = e.message;
  }
}

function parseMaster(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim());
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = lines[i].substring(18);
    const v = { bandwidth: 0, resolution: '', codecs: '', name: '', url: '', segments: [], duration: 0, parsed: false };
    const bw = attrs.match(/BANDWIDTH=(\d+)/); if (bw) v.bandwidth = +bw[1];
    const res = attrs.match(/RESOLUTION=(\d+x\d+)/); if (res) v.resolution = res[1];
    const cod = attrs.match(/CODECS="([^"]+)"/); if (cod) v.codecs = cod[1];
    const nam = attrs.match(/NAME="([^"]+)"/); if (nam) v.name = nam[1];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith('#')) { v.url = resolve(lines[j], baseUrl); break; }
    }
    if (v.url) variants.push(v);
  }
  return variants.sort((a, b) => b.bandwidth - a.bandwidth);
}

function parseAttrList(line) {
  const attrs = {};
  const payload = line.includes(':') ? line.slice(line.indexOf(':') + 1) : '';
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(payload))) {
    const key = m[1].toUpperCase();
    let val = m[2] || '';
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    attrs[key] = val;
  }
  return attrs;
}

function parseMedia(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim());
  const segments = [];
  let duration = 0;
  let pendingDur = null;
  let activeInitUrl = '';
  const addedInitUrls = new Set();
  let mediaSeq = 0;
  let nextSeq = 0;
  let currentKey = null;

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const seq = parseInt(line.split(':')[1], 10);
      mediaSeq = Number.isFinite(seq) ? seq : 0;
      nextSeq = mediaSeq;
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const dur = parseFloat(line.split(':')[1]);
      pendingDur = Number.isFinite(dur) ? dur : 0;
      duration += pendingDur;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttrList(line);
      const method = (attrs.METHOD || '').toUpperCase();
      if (!method || method === 'NONE') {
        currentKey = null;
      } else {
        currentKey = {
          method,
          uri: attrs.URI ? resolve(attrs.URI, baseUrl) : '',
          iv: attrs.IV || ''
        };
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrList(line);
      if (attrs.URI) {
        activeInitUrl = resolve(attrs.URI, baseUrl);
        if (activeInitUrl && !addedInitUrls.has(activeInitUrl)) {
          segments.push({ url: activeInitUrl, duration: 0, init: true, seq: nextSeq, key: null });
          addedInitUrls.add(activeInitUrl);
        }
      }
      continue;
    }

    if (line.startsWith('#')) continue;

    if (activeInitUrl && !addedInitUrls.has(activeInitUrl)) {
      segments.push({ url: activeInitUrl, duration: 0, init: true, seq: nextSeq, key: null });
      addedInitUrls.add(activeInitUrl);
    }

    segments.push({
      url: resolve(line, baseUrl),
      duration: pendingDur ?? 0,
      seq: nextSeq,
      key: currentKey ? { ...currentKey } : null
    });
    pendingDur = null;
    nextSeq++;
  }
  return { segments, duration };
}

function resolve(url, base) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try { return new URL(url, base).href; } catch { return url; }
}

// ========================
// DOWNLOAD — opens a tab with download.html
// ========================

function qualityFromVariant(variant) {
  if (!variant) return 'auto';
  return variant.resolution || (variant.bandwidth ? Math.round(variant.bandwidth / 1000) + 'k' : 'auto');
}

function pickVariant(variants, wanted, fallbackIndex) {
  if (!variants.length) return null;
  if (wanted) {
    const exact = variants.find(v => v.resolution === wanted.resolution && v.bandwidth === wanted.bandwidth);
    if (exact) return exact;
  }
  const idx = Number.isInteger(fallbackIndex) ? Math.max(0, fallbackIndex) : 0;
  return variants[Math.min(idx, variants.length - 1)];
}

async function refreshSegmentsForDownload(stream, variantIndex) {
  if (stream.type === 'master' && stream.variants.length) {
    const wanted = stream.variants[variantIndex] || stream.variants[0];
    let variants = stream.variants;

    // Refresh master playlist first to avoid expired variant URLs/tokens.
    try {
      const masterText = await fetchText(stream.url);
      const freshVariants = parseMaster(masterText, stream.url);
      if (freshVariants.length) {
        variants = freshVariants;
        stream.variants = freshVariants;
      }
    } catch {}

    const selected = pickVariant(variants, wanted, variantIndex) || variants[0];
    const mediaText = await fetchText(selected.url);
    const parsed = parseMedia(mediaText, selected.url);

    selected.segments = parsed.segments;
    selected.duration = parsed.duration;
    selected.parsed = true;
    stream.duration = parsed.duration || stream.duration;

    return {
      segments: parsed.segments,
      quality: qualityFromVariant(selected)
    };
  }

  const mediaText = await fetchText(stream.url);
  const parsed = parseMedia(mediaText, stream.url);
  stream.segments = parsed.segments;
  stream.duration = parsed.duration;

  return { segments: parsed.segments, quality: 'default' };
}

function getDownloadReferer(stream) {
  return normalizeHttpUrl(stream.pageUrl) || normalizeHttpUrl(stream.url) || '';
}

function getRequestDomains(urls) {
  const domains = new Set();
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      if (u.hostname) domains.add(u.hostname);
    } catch {}
  }
  return [...domains];
}

function collectRequestUrls(segments) {
  const out = new Set();
  for (const s of segments || []) {
    if (s?.url) out.add(s.url);
    if (s?.key?.uri) out.add(s.key.uri);
  }
  return [...out];
}

async function allocateRuleIds(count) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const used = new Set(existing.map(r => r.id));
  for (const ids of downloadHeaderRuleIds.values()) {
    for (const id of ids) used.add(id);
  }

  const out = [];
  let id = 10000;
  while (out.length < count && id < 999999) {
    if (!used.has(id)) out.push(id);
    id++;
  }
  if (out.length < count) throw new Error('No free DNR rule IDs available');
  return out;
}

async function installDownloadHeaderRules(downloadId, tabId, referer, requestUrls) {
  if (!chrome.declarativeNetRequest) return;
  if (!tabId || !referer) return;

  await removeDownloadHeaderRules(downloadId);

  const origin = (() => {
    try { return new URL(referer).origin; } catch { return ''; }
  })();
  const requestDomains = getRequestDomains(requestUrls);
  if (!requestDomains.length) return;

  const [ruleId] = await allocateRuleIds(1);
  const requestHeaders = [
    { header: 'referer', operation: 'set', value: referer }
  ];
  if (origin) requestHeaders.push({ header: 'origin', operation: 'set', value: origin });

  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders
      },
      condition: {
        tabIds: [tabId],
        requestDomains,
        resourceTypes: ['xmlhttprequest']
      }
    }]
  });

  downloadHeaderRuleIds.set(downloadId, [ruleId]);
}

async function removeDownloadHeaderRules(downloadId) {
  const ids = downloadHeaderRuleIds.get(downloadId);
  if (!ids?.length || !chrome.declarativeNetRequest) return;

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch {}

  downloadHeaderRuleIds.delete(downloadId);
}

function hostSlug(url) {
  try { return new URL(url).hostname.replace(/\./g, '_'); } catch { return 'video'; }
}

// Build a filename for a direct video file, preserving its original extension.
function directFilename(url, host) {
  let ext = (urlPathname(url).match(/\.([a-z0-9]{2,4})(?:[?#]|$)/i)?.[1] || 'mp4').toLowerCase();
  let base = 'video';
  try {
    const last = urlPathname(url).split('/').pop() || '';
    const stem = last.replace(/\.[a-z0-9]+$/i, '');
    if (stem) base = stem;
  } catch {}
  return ('video_' + host + '_' + base + '_' + Date.now() + '.' + ext).replace(/[^\w.\-]+/g, '_');
}

// Push a progress snapshot to the popup (mirrors the messages the HLS download tab sends).
function emitProgress(streamId) {
  const d = activeDownloads[streamId];
  if (!d) return;
  chrome.runtime.sendMessage({
    type: 'FETCH_PROGRESS', downloadId: streamId,
    status: d.status, progress: d.progress,
    total: d.total, current: d.current, bytes: d.bytes, error: d.error
  }).catch(() => {});
}

async function handleDirectFileDownload(streamId, stream, host) {
  const filename = directFilename(stream.url, host);
  const quality = stream.format || videoFormatLabel(stream.url);

  activeDownloads[streamId] = { status: 'downloading', progress: 0, total: 1, current: 0, bytes: 0 };
  downloadMeta[streamId] = {
    domain: getDomain(stream.url), url: stream.url, quality, segmentCount: 1, duration: 0
  };
  persistDownloads();
  emitProgress(streamId);

  let dlId;
  try {
    dlId = await new Promise((resolve, reject) => {
      chrome.downloads.download({ url: stream.url, filename, saveAs: true }, (id) => {
        if (chrome.runtime.lastError || id == null) {
          reject(new Error(chrome.runtime.lastError?.message || 'Download could not start'));
        } else {
          resolve(id);
        }
      });
    });
  } catch (e) {
    activeDownloads[streamId] = { status: 'error', progress: 0, error: e.message };
    persistDownloads();
    emitProgress(streamId);
    return;
  }

  directDlToStream.set(dlId, streamId);
  streamToDirectDl.set(streamId, dlId);
  pollDirectProgress(dlId, streamId);
}

// Poll the browser download for byte progress until it finishes.
// (chrome.downloads.onChanged covers terminal state if this loop is suspended.)
async function pollDirectProgress(dlId, streamId) {
  for (;;) {
    if (!directDlToStream.has(dlId)) return;
    let item;
    try { [item] = await chrome.downloads.search({ id: dlId }); } catch { return; }
    if (!item) return;

    if (item.state === 'complete') { finalizeDirectDownload(dlId, streamId, item); return; }
    if (item.state === 'interrupted') {
      activeDownloads[streamId] = { status: 'error', progress: 0, error: item.error || 'Download interrupted' };
      persistDownloads();
      emitProgress(streamId);
      directDlToStream.delete(dlId);
      streamToDirectDl.delete(streamId);
      return;
    }

    const total = item.totalBytes || 0;
    const got = item.bytesReceived || 0;
    activeDownloads[streamId] = {
      status: item.paused ? 'paused' : 'downloading',
      progress: total > 0 ? Math.round(got / total * 100) : 0,
      total: 1, current: 0, bytes: got
    };
    persistDownloads();
    emitProgress(streamId);
    await sleep(item.paused ? 1200 : 700);
  }
}

function finalizeDirectDownload(dlId, streamId, item) {
  const size = item?.bytesReceived || item?.totalBytes || 0;
  activeDownloads[streamId] = { status: 'complete', progress: 100, bytes: size };
  persistDownloads();
  chrome.runtime.sendMessage({ type: 'FETCH_COMPLETE', downloadId: streamId, size }).catch(() => {});
  directDlToStream.delete(dlId);
  streamToDirectDl.delete(streamId);
  setTimeout(() => {
    if (activeDownloads[streamId]?.status === 'complete') {
      delete activeDownloads[streamId];
      delete downloadMeta[streamId];
      persistDownloads();
    }
  }, 10000);
}

// Catch terminal state even if the poll loop was suspended by the service worker.
chrome.downloads.onChanged.addListener((delta) => {
  const streamId = directDlToStream.get(delta.id);
  if (!streamId || !delta.state) return;
  if (delta.state.current === 'complete') {
    chrome.downloads.search({ id: delta.id })
      .then(([item]) => finalizeDirectDownload(delta.id, streamId, item || {}))
      .catch(() => finalizeDirectDownload(delta.id, streamId, {}));
  } else if (delta.state.current === 'interrupted') {
    activeDownloads[streamId] = { status: 'error', progress: 0, error: 'Download interrupted' };
    persistDownloads();
    emitProgress(streamId);
    directDlToStream.delete(delta.id);
    streamToDirectDl.delete(streamId);
  }
});

async function handleStartDownload(streamId, variantIndex) {
  let stream = null;
  for (const [, streams] of tabStreams) {
    const s = streams.find(st => st.id === streamId);
    if (s) { stream = s; break; }
  }
  if (!stream) return;

  const host = hostSlug(stream.url);

  // ── Direct video file: hand the URL straight to the browser's downloader. ──
  // This is a normal browser download (sends cookies, supports any size / resume),
  // so it works for large or session-protected MP4/WebM/etc. files.
  if (stream.type === 'file') {
    await handleDirectFileDownload(streamId, stream, host);
    return;
  }

  // ── HLS: resolve segment list for the chosen variant. ──
  const safeVariantIndex = Number.isInteger(+variantIndex) ? +variantIndex : 0;
  let segments = [];
  let quality = 'default';

  try {
    const refreshed = await refreshSegmentsForDownload(stream, safeVariantIndex);
    segments = refreshed.segments;
    quality = refreshed.quality;
  } catch {
    // Fallback to previously parsed data if refresh fails.
    if (stream.type === 'master' && stream.variants.length) {
      const variant = stream.variants[safeVariantIndex] || stream.variants[0];
      quality = qualityFromVariant(variant);
      if (!variant.parsed || !variant.segments || !variant.segments.length) {
        const text = await fetchText(variant.url);
        const p = parseMedia(text, variant.url);
        variant.segments = p.segments;
        variant.duration = p.duration;
        variant.parsed = true;
      }
      segments = variant.segments;
    } else {
      segments = stream.segments;
    }
  }

  if (!segments.length) {
    activeDownloads[streamId] = { status: 'error', error: 'No segments found', progress: 0 };
    persistDownloads();
    return;
  }

  const preparedSegments = segments.map((s, idx) => ({
    url: s?.url || '',
    duration: Number.isFinite(+s?.duration) ? +s.duration : 0,
    init: !!s?.init,
    seq: Number.isFinite(+s?.seq) ? +s.seq : idx,
    key: s?.key ? {
      method: s.key.method || '',
      uri: s.key.uri || '',
      iv: s.key.iv || ''
    } : null
  })).filter(s => !!s.url);

  await launchDownload(streamId, stream, {
    preparedSegments,
    filename: 'video_' + host + '_' + quality + '_' + Date.now() + '.ts',
    quality, total: segments.length, direct: false
  });
}

// Opens the download tab, hands it the segment list via storage, and installs the
// Referer/Origin header rules. Shared by both HLS and direct-file downloads.
async function launchDownload(streamId, stream, { preparedSegments, filename, quality, total, direct }) {
  if (!preparedSegments.length) {
    activeDownloads[streamId] = { status: 'error', error: 'No data found', progress: 0 };
    persistDownloads();
    return;
  }
  const requestUrls = collectRequestUrls(preparedSegments);

  // Store URLs first; the download tab waits until "ready=true".
  await chrome.storage.local.set({
    [streamId]: { segments: preparedSegments, filename, ready: false, direct: !!direct }
  });

  activeDownloads[streamId] = {
    status: 'starting', progress: 0,
    total, current: 0, bytes: 0
  };
  downloadMeta[streamId] = {
    domain: getDomain(stream.url),
    url: stream.url,
    quality,
    segmentCount: total,
    duration: stream.duration || 0
  };
  persistDownloads();

  let dlTab = null;
  try {
    dlTab = await chrome.tabs.create({
      url: chrome.runtime.getURL('src/download/download.html?id=' + streamId),
      active: true
    });
    if (dlTab?.id) {
      downloadMeta[streamId].downloadTabId = dlTab.id;
      persistDownloads();
    }
  } catch {
    activeDownloads[streamId] = { status: 'error', error: 'Failed to open download tab', progress: 0 };
    delete downloadMeta[streamId];
    persistDownloads();
    await chrome.storage.local.remove(streamId);
    return;
  }

  const referer = getDownloadReferer(stream);
  try {
    await installDownloadHeaderRules(streamId, dlTab?.id, referer, requestUrls);
  } catch {}

  await chrome.storage.local.set({
    [streamId]: { segments: preparedSegments, filename, ready: true, direct: !!direct }
  });
}
