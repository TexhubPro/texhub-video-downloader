// interceptor.js — Runs in the page's MAIN world
// Overrides fetch() and XMLHttpRequest.open() to detect HLS playlists and
// direct video files loaded by JS, and reports them to the content script.

(function () {
  'use strict';

  // Self-contained (MAIN world has no access to the extension's shared utils).
  const DIRECT_VIDEO_RE = /\.(mp4|m4v|webm|mkv|mov|ogv|avi|flv|wmv|mpg|mpeg|3gp)(?:[?#]|$)/i;
  const seen = new Set();

  function pathOf(u) {
    try { return new URL(u, location.href).pathname; } catch { return u; }
  }

  function check(raw) {
    if (!raw || typeof raw !== 'string') return;
    const lower = raw.toLowerCase();
    let kind = null;
    if (lower.includes('.m3u8')) kind = 'hls';
    else if (DIRECT_VIDEO_RE.test(pathOf(raw))) kind = 'file';
    if (!kind) return;

    // Resolve to absolute URL
    let url = raw;
    try { url = new URL(raw, location.href).href; } catch { /* keep raw */ }

    if (seen.has(url)) return;
    seen.add(url);
    window.postMessage({ __texhub_media: true, url, kind, pageUrl: location.href }, '*');
  }

  // ── Intercept fetch() ──
  const origFetch = window.fetch;
  window.fetch = function (input, ...args) {
    check(typeof input === 'string' ? input : input?.url);
    return origFetch.call(this, input, ...args);
  };

  // ── Intercept XMLHttpRequest.open() ──
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    check(typeof url === 'string' ? url : url?.toString());
    return origOpen.call(this, method, url, ...rest);
  };

  // ── Watch DOM for <video> / <source> elements with m3u8 src ──
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const tag = node.tagName;
        if (tag === 'VIDEO' || tag === 'SOURCE') {
          check(node.src || node.getAttribute('src'));
        }
        if (node.querySelectorAll) {
          node.querySelectorAll('video, source').forEach((el) => {
            check(el.src || el.getAttribute('src'));
          });
        }
      }
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }
})();
