// utils.js — Shared helpers
// Loaded in every context: popup, content script, download page, and the
// service worker (via importScripts). Declares plain globals so each context
// can use them without a module system.

function fmtSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtDuration(sec) {
  sec = Number(sec) || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function qualityLabel(resolution, bandwidth) {
  if (resolution) {
    const h = parseInt(resolution.split('x')[1], 10);
    if (h >= 2160) return '4K';
    if (h >= 1440) return '2K';
    if (h >= 1080) return 'FHD';
    if (h >= 720)  return 'HD';
    if (h >= 480)  return 'SD';
    if (h >= 360)  return '360p';
    return h + 'p';
  }
  if (bandwidth) {
    if (bandwidth > 5000000) return 'High';
    if (bandwidth > 2000000) return 'Med';
    return 'Low';
  }
  return 'Auto';
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return 'Unknown'; }
}

// ── Video format detection ──
// Direct/progressive containers we can download as a single file.
// (.ts is intentionally excluded — it is an HLS segment, not a standalone file.)
const DIRECT_VIDEO_RE = /\.(mp4|m4v|webm|mkv|mov|ogv|ogg|avi|flv|wmv|mpg|mpeg|3gp)(?:[?#]|$)/i;

function urlPathname(url) {
  try { return new URL(url, 'http://_').pathname; } catch { return String(url || ''); }
}

function isHlsUrl(url) {
  return typeof url === 'string' && url.toLowerCase().includes('.m3u8');
}

function isDirectVideoUrl(url) {
  if (typeof url !== 'string') return false;
  return DIRECT_VIDEO_RE.test(urlPathname(url));
}

// Uppercase container label, e.g. "MP4", "WEBM". Falls back to "VIDEO".
function videoFormatLabel(url) {
  const m = urlPathname(url).match(/\.([a-z0-9]{2,4})(?:[?#]|$)/i);
  return m ? m[1].toUpperCase() : 'VIDEO';
}

// MIME type for a filename's extension (used when saving direct files).
function mimeFromName(name) {
  const ext = (String(name || '').match(/\.([a-z0-9]{2,4})$/i)?.[1] || '').toLowerCase();
  return ({
    mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm',
    mkv: 'video/x-matroska', mov: 'video/quicktime', ogv: 'video/ogg',
    ogg: 'video/ogg', avi: 'video/x-msvideo', flv: 'video/x-flv',
    wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
    '3gp': 'video/3gpp', ts: 'video/mp2t'
  })[ext] || 'application/octet-stream';
}

// HTML-escape a value for safe interpolation. DOM-only (popup / content / download).
function esc(str) {
  if (str == null) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}
