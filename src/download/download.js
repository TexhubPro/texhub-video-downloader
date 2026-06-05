// download.js — Tab-based downloader
// Fetches HLS segments, merges, converts TS→MP4, saves file

const params = new URLSearchParams(location.search);
const downloadId = params.get('id');

const statusEl = document.getElementById('status');
const fillEl   = document.getElementById('fill');
const segEl    = document.getElementById('seg');
const szEl     = document.getElementById('sz');
const logEl    = document.getElementById('log');
const cancelEl = document.getElementById('cancelBtn');

let cancelled = false;
let paused = false;

// fmtSize() lives in src/shared/utils.js (loaded before this script).

function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

// Pause / Resume / Cancel commands are relayed by the background worker
// (popup → background → this download tab).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.downloadId && msg.downloadId !== downloadId) return;
  if (msg?.type === 'PAUSE_DOWNLOAD')  paused = true;
  if (msg?.type === 'RESUME_DOWNLOAD') paused = false;
  if (msg?.type === 'CANCEL_DOWNLOAD') cancelDownload();
});

function progress(status, pct, total, current, bytes) {
  chrome.runtime.sendMessage({
    type: 'FETCH_PROGRESS', downloadId,
    status, progress: pct, total, current, bytes
  }).catch(() => {});
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getDownloadInfo() {
  return new Promise((resolve) => {
    chrome.storage.local.get(downloadId, (data) => resolve(data[downloadId] || null));
  });
}

async function waitUntilReady(timeoutMs = 12000) {
  const start = Date.now();
  while (!cancelled && (Date.now() - start) < timeoutMs) {
    const info = await getDownloadInfo();
    if (info?.ready && Array.isArray(info.segments) && info.segments.length) return info;
    await sleep(120);
  }
  return null;
}

function hasFourCC(u8, off, a, b, c, d) {
  return u8[off] === a && u8[off + 1] === b && u8[off + 2] === c && u8[off + 3] === d;
}

function detectTsPacketSpec(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
  const packetSizes = [188, 192, 204];

  for (const packetSize of packetSizes) {
    if (u8.length < packetSize * 5) continue;
    const limit = Math.min(4096, u8.length - packetSize * 5);
    for (let i = 0; i < limit; i++) {
      if (u8[i] !== 0x47) continue;
      let ok = true;
      for (let n = 1; n < 5; n++) {
        if (u8[i + n * packetSize] !== 0x47) { ok = false; break; }
      }
      if (ok) return { packetSize, offset: i };
    }
  }
  return null;
}

function normalizeTsPayload(data, spec) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
  if (!spec) return null;

  const count = Math.floor((u8.length - spec.offset) / spec.packetSize);
  if (count <= 0) return null;
  if (spec.packetSize === 188 && spec.offset === 0) return u8;

  const out = new Uint8Array(count * 188);
  for (let i = 0; i < count; i++) {
    const src = spec.offset + i * spec.packetSize;
    const dst = i * 188;
    if (src + 188 > u8.length) break;
    out.set(u8.subarray(src, src + 188), dst);
  }
  return out;
}

function looksLikeTs(data) {
  return !!detectTsPacketSpec(data);
}

function looksLikeMp4OrFmp4(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
  if (u8.length < 8) return false;
  const lim = Math.min(u8.length - 8, 8192);
  for (let i = 0; i < lim; i++) {
    if (hasFourCC(u8, i, 0x66, 0x74, 0x79, 0x70)) return true; // ftyp
    if (hasFourCC(u8, i, 0x73, 0x74, 0x79, 0x70)) return true; // styp
    if (hasFourCC(u8, i, 0x6d, 0x6f, 0x6f, 0x66)) return true; // moof
    if (hasFourCC(u8, i, 0x73, 0x69, 0x64, 0x78)) return true; // sidx
  }
  return false;
}

function concatUint8Arrays(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function tryInternalRemux(tsData) {
  if (typeof self.remuxTS2MP4 !== 'function') return null;
  try {
    const out = self.remuxTS2MP4(tsData);
    if (!out || out.length <= 100) return null;
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  } catch (e) {
    log('Primary remuxer failed: ' + e.message);
    return null;
  }
}

function tryMuxJsRemux(tsData) {
  return new Promise((resolve) => {
    const Transmuxer = self.muxjs?.mp4?.Transmuxer;
    if (!Transmuxer) {
      log('mux.js not available');
      resolve(null);
      return;
    }

    try {
      const tx = new Transmuxer({ keepOriginalTimestamps: true, remux: true });
      const initParts = [];
      const mediaParts = [];
      let hadError = false;
      let errorText = '';

      tx.on('data', (segment) => {
        if (segment?.initSegment?.length) initParts.push(new Uint8Array(segment.initSegment));
        if (segment?.data?.length) mediaParts.push(new Uint8Array(segment.data));
      });

      tx.on('error', (err) => {
        hadError = true;
        errorText = err?.message || String(err || 'unknown');
      });

      tx.on('done', () => {
        if (hadError) {
          log('mux.js transmux error: ' + errorText);
          resolve(null);
          return;
        }
        if (!initParts.length || !mediaParts.length) {
          resolve(null);
          return;
        }
        const out = concatUint8Arrays([initParts[0], ...mediaParts]);
        resolve(out.length > 100 ? out : null);
      });

      tx.push(tsData instanceof Uint8Array ? tsData : new Uint8Array(tsData));
      tx.flush();
    } catch (e) {
      log('mux.js transmux failed: ' + e.message);
      resolve(null);
    }
  });
}

async function buildGuaranteedMp4(merged, filename) {
  const outName = filename.replace(/\.ts$/i, '.mp4');
  const tsSpec = detectTsPacketSpec(merged);
  const isTsInput = !!tsSpec;
  const isMp4Input = looksLikeMp4OrFmp4(merged);
  const normalizedTs = tsSpec ? normalizeTsPayload(merged, tsSpec) : null;

  if (isMp4Input && !isTsInput) {
    log('Detected MP4/fMP4 stream, no remux needed');
    return {
      blob: new Blob([merged], { type: 'video/mp4' }),
      fname: outName
    };
  }

  if (isTsInput) {
    log('Detected MPEG-TS stream (packet ' + tsSpec.packetSize + ', offset ' + tsSpec.offset + '), converting...');
    const tsPayload = normalizedTs || (merged instanceof Uint8Array ? merged : new Uint8Array(merged));

    const internal = tryInternalRemux(tsPayload);
    if (internal) {
      log('MP4 conversion OK (primary remuxer)');
      return {
        blob: new Blob([internal], { type: 'video/mp4' }),
        fname: outName
      };
    }

    log('Primary remuxer failed, trying mux.js fallback...');
    const muxOut = await tryMuxJsRemux(tsPayload);
    if (muxOut) {
      log('MP4 conversion OK (mux.js fallback)');
      return {
        blob: new Blob([muxOut], { type: 'video/mp4' }),
        fname: outName
      };
    }

    if (isMp4Input) {
      log('Byte signature indicates MP4/fMP4, saving as MP4 directly');
      return {
        blob: new Blob([merged], { type: 'video/mp4' }),
        fname: outName
      };
    }

    throw new Error('TS to MP4 conversion failed in all converters');
  }

  if (isMp4Input) {
    return {
      blob: new Blob([merged], { type: 'video/mp4' }),
      fname: outName
    };
  }

  throw new Error('Unsupported stream format (possibly DRM or unknown container)');
}

function cancelDownload() {
  cancelled = true;
  statusEl.textContent = 'Cancelled';
  log('Download cancelled by user');
  chrome.runtime.sendMessage({
    type: 'FETCH_PROGRESS', downloadId,
    status: 'cancelled', progress: 0, total: 0, current: 0, bytes: 0
  }).catch(() => {});
  chrome.storage.local.remove(downloadId);
  cancelEl.classList.add('hide');
}

cancelEl?.addEventListener('click', cancelDownload);

function normalizeSegments(items) {
  return (items || []).map((item, idx) => {
    if (typeof item === 'string') {
      return { url: item, duration: 0, seq: idx, key: null, init: false };
    }
    return {
      url: item?.url || '',
      duration: Number.isFinite(+item?.duration) ? +item.duration : 0,
      seq: Number.isFinite(+item?.seq) ? +item.seq : idx,
      key: item?.key ? {
        method: String(item.key.method || '').toUpperCase(),
        uri: item.key.uri || '',
        iv: item.key.iv || ''
      } : null,
      init: !!item?.init
    };
  }).filter(s => !!s.url);
}

async function fetchArrayBufferWithAuth(url) {
  const r = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    referrerPolicy: 'no-referrer-when-downgrade'
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.arrayBuffer();
}

function parseHexIv(ivText) {
  let hex = String(ivText || '').trim();
  if (!hex) return null;
  if (hex.toLowerCase().startsWith('0x')) hex = hex.slice(2);
  if (!hex) return null;
  if (hex.length % 2) hex = '0' + hex;
  if (hex.length > 32) hex = hex.slice(-32);
  while (hex.length < 32) hex = '0' + hex;

  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    out[i] = Number.isFinite(b) ? b : 0;
  }
  return out;
}

function seqToIv(seq) {
  const out = new Uint8Array(16);
  let n = BigInt(Math.max(0, Number.isFinite(+seq) ? +seq : 0));
  for (let i = 15; i >= 0 && n > 0n; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

const aesKeyCache = new Map();

async function getAesKey(uri) {
  if (!uri) throw new Error('Missing AES key URI');
  if (aesKeyCache.has(uri)) return aesKeyCache.get(uri);

  const p = (async () => {
    const raw = new Uint8Array(await fetchArrayBufferWithAuth(uri));
    if (raw.byteLength !== 16) throw new Error('AES-128 key must be 16 bytes');
    return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
  })();

  aesKeyCache.set(uri, p);
  return p;
}

async function decryptIfNeeded(segment, data) {
  const key = segment?.key;
  if (!key || segment?.init) return data;
  if (!key.method || key.method === 'NONE') return data;
  if (key.method !== 'AES-128') throw new Error('Unsupported encryption method: ' + key.method);

  const cryptoKey = await getAesKey(key.uri);
  const iv = key.iv ? parseHexIv(key.iv) : seqToIv(segment.seq);

  try {
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  } catch (e) {
    throw new Error('AES decrypt failed: ' + e.message);
  }
}

// ── Start ──

if (!downloadId) {
  statusEl.textContent = 'Error: no download ID';
  statusEl.classList.add('err');
} else {
  (async () => {
    log('Waiting for prepared download info...');
    const info = await waitUntilReady();
    if (!info) {
      statusEl.textContent = 'Error: download info not ready';
      statusEl.classList.add('err');
      log('ERROR: Timed out waiting for download data (id=' + downloadId + ')');
      progress('error', 0, 0, 0, 0);
      chrome.storage.local.remove(downloadId);
      return;
    }
    log(info.direct
      ? 'Direct video file'
      : 'Found ' + info.segments.length + ' segments');
    log('Filename: ' + info.filename);
    run(normalizeSegments(info.segments), info.filename, !!info.direct);
  })();
}

async function run(segments, filename, direct) {
  const BATCH = 6;
  const chunks = new Array(segments.length);
  let totalBytes = 0;
  let failCount = 0;

  statusEl.textContent = 'Downloading segments...';

  for (let i = 0; i < segments.length && !cancelled; i += BATCH) {
    // Honour pause requests at each batch boundary.
    while (paused && !cancelled) {
      const pct = Math.round(i / segments.length * 100);
      statusEl.textContent = 'Paused — ' + i + ' / ' + segments.length + ' segments';
      progress('paused', pct, segments.length, i, totalBytes);
      await sleep(300);
    }
    if (cancelled) break;

    const end = Math.min(i + BATCH, segments.length);
    const batch = segments.slice(i, end);

    const results = await Promise.all(batch.map(async (segment, idx) => {
      const gi = i + idx;
      for (let retry = 0; retry < 3; retry++) {
        try {
          const encrypted = await fetchArrayBufferWithAuth(segment.url);
          const buf = await decryptIfNeeded(segment, encrypted);
          totalBytes += buf.byteLength || 0;
          return { i: gi, buf, ok: true };
        } catch (err) {
          if (retry < 2) {
            await new Promise(r => setTimeout(r, 500 * (retry + 1)));
          } else {
            log('Segment ' + gi + ' FAILED: ' + err.message);
            failCount++;
            return { i: gi, buf: new ArrayBuffer(0), ok: false };
          }
        }
      }
    }));

    for (const r of results) chunks[r.i] = r.buf;

    const done = end;
    const pct = Math.round(done / segments.length * 100);
    fillEl.style.width = pct + '%';
    segEl.textContent = done + ' / ' + segments.length;
    szEl.textContent = fmtSize(totalBytes);
    statusEl.textContent = 'Downloading: ' + done + ' / ' + segments.length + ' segments';

    if (done % 30 === 0 || done === segments.length) {
      log('Downloaded ' + done + '/' + segments.length + ' — ' + fmtSize(totalBytes));
    }

    progress('downloading', pct, segments.length, done, totalBytes);
  }

  if (cancelled) return;

  if (failCount > 0) log(failCount + ' segments failed (will be skipped)');
  if (totalBytes === 0) {
    statusEl.textContent = 'Error: all segments failed to download';
    statusEl.classList.add('err');
    log('ERROR: No data downloaded. Check if video requires authentication.');
    progress('error', 0, segments.length, segments.length, 0);
    chrome.storage.local.remove(downloadId);
    return;
  }

  // ── Merge ──
  statusEl.textContent = 'Merging segments...';
  log('Merging ' + segments.length + ' segments (' + fmtSize(totalBytes) + ')...');
  progress('merging', 100, segments.length, segments.length, totalBytes);
  await new Promise(r => setTimeout(r, 50));

  let mergedSize = 0;
  for (const c of chunks) if (c) mergedSize += c.byteLength;

  const merged = new Uint8Array(mergedSize);
  let off = 0;
  for (const c of chunks) {
    if (c && c.byteLength) { merged.set(new Uint8Array(c), off); off += c.byteLength; }
  }

  log('Merged: ' + fmtSize(mergedSize));

  let blob;
  let fname;

  if (direct) {
    // ── Direct file: save the bytes as-is, keeping the original container. ──
    fname = filename;
    blob = new Blob([merged], { type: mimeFromName(fname) });
    log('Saving direct ' + (fname.split('.').pop() || '').toUpperCase() + ' file: ' + fmtSize(blob.size));
  } else {
    // ── Convert to MP4 ──
    statusEl.textContent = 'Converting to MP4...';
    log('Starting mandatory MP4 conversion...');
    progress('converting', 100, segments.length, segments.length, mergedSize);
    await new Promise(r => setTimeout(r, 50));

    try {
      const out = await buildGuaranteedMp4(merged, filename);
      blob = out.blob;
      fname = out.fname;
      log('MP4 ready: ' + fmtSize(blob.size));
    } catch (e) {
      statusEl.textContent = 'Error: MP4 conversion failed';
      statusEl.classList.add('err');
      log('ERROR: ' + e.message);
      progress('error', 0, segments.length, segments.length, mergedSize);
      chrome.storage.local.remove(downloadId);
      return;
    }
  }

  // ── Save ──
  fillEl.style.width = '100%';
  fillEl.classList.add('done');
  statusEl.textContent = 'Saving: ' + fname + ' (' + fmtSize(blob.size) + ')';
  log('Triggering download: ' + fname);
  cancelEl.classList.add('hide');

  const blobUrl = URL.createObjectURL(blob);

  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: blobUrl,
        filename: fname,
        saveAs: true
      }, (dlId) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(dlId);
      });
    });
    log('Download started via Chrome downloads API');
  } catch (e) {
    log('chrome.downloads failed (' + e.message + '), using fallback...');
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    log('Fallback download triggered');
  }

  statusEl.innerHTML = '<span class="ok">Download complete!</span> ' + fname + ' (' + fmtSize(blob.size) + ')';
  log('Done! You can close this tab.');

  chrome.runtime.sendMessage({
    type: 'FETCH_COMPLETE', downloadId,
    size: blob.size, filename: fname,
    format: fname.endsWith('.mp4') ? 'mp4' : 'ts'
  }).catch(() => {});

  chrome.storage.local.remove(downloadId);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
}
