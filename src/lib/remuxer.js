// remuxer.js — Lossless MPEG-TS to MP4 Remuxer
// H.264 (AVC) video + AAC audio → ISO BMFF MP4
// Compatible with QuickTime, VLC, IINA, and all Mac/Windows players

(function () {
  'use strict';

  const SAMPLE_RATES = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
  const HIGH_PROFILES = [100,110,122,244,44,83,86,118,128,138,139,134,135];

  // ========== BYTE HELPERS ==========

  function w32(buf, off, v) {
    buf[off]   = (v >>> 24) & 0xff;
    buf[off+1] = (v >>> 16) & 0xff;
    buf[off+2] = (v >>> 8)  & 0xff;
    buf[off+3] =  v         & 0xff;
  }

  function u8a(...b) { return new Uint8Array(b); }
  function u16(v) { return u8a((v >> 8) & 0xff, v & 0xff); }
  function u32(v) { return u8a((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }
  function str(s) { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }

  function cat(...arrays) {
    let n = 0; for (const a of arrays) n += a.length;
    const r = new Uint8Array(n); let o = 0;
    for (const a of arrays) { r.set(a, o); o += a.length; }
    return r;
  }

  function mp4(type, ...ch) {
    const payload = cat(...ch);
    return cat(u32(8 + payload.length), str(type), payload);
  }

  // ========== PTS PARSER ==========

  function readPTS(d, o) {
    return ((d[o] & 0x0e) * 536870912) + ((d[o+1] & 0xff) * 4194304) +
           ((d[o+2] & 0xfe) * 16384) + ((d[o+3] & 0xff) * 128) + ((d[o+4] & 0xfe) >>> 1);
  }

  // ========== EPB REMOVAL ==========

  function removeEPB(d) {
    const r = [];
    for (let i = 0; i < d.length; i++) {
      if (i >= 2 && d[i] === 3 && d[i-1] === 0 && d[i-2] === 0) continue;
      r.push(d[i]);
    }
    return new Uint8Array(r);
  }

  // ========== SPS PARSER ==========

  function parseSPS(sps) {
    const d = removeEPB(sps);
    let bp = 8;

    function bits(n) {
      let v = 0;
      for (let i = 0; i < n; i++) { v = (v << 1) | ((d[bp >> 3] >>> (7 - (bp & 7))) & 1); bp++; }
      return v;
    }
    function ue() { let z = 0; while (!bits(1) && z < 32) z++; return z ? ((1 << z) - 1 + bits(z)) : 0; }
    function se() { const v = ue(); return (v & 1) ? ((v + 1) >> 1) : -(v >> 1); }

    const prof = bits(8); bits(8); const lvl = bits(8); ue();
    let cfi = 1;
    if (HIGH_PROFILES.includes(prof)) {
      cfi = ue();
      if (cfi === 3) bits(1);
      ue(); ue(); bits(1);
      if (bits(1)) for (let i = 0; i < (cfi !== 3 ? 8 : 12); i++) {
        if (bits(1)) { let ls = 8, ns = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (ns) { ns = (ls + se() + 256) % 256; } ls = ns || ls; } }
      }
    }
    ue();
    const poc = ue();
    if (poc === 0) ue();
    else if (poc === 1) { bits(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
    ue(); bits(1);
    const mbW = ue() + 1, mbH = ue() + 1, fmo = bits(1);
    if (!fmo) bits(1);
    bits(1);
    let cL = 0, cR = 0, cT = 0, cB = 0;
    if (bits(1)) { cL = ue(); cR = ue(); cT = ue(); cB = ue(); }

    const swc = (cfi === 1 || cfi === 2) ? 2 : 1;
    const shc = cfi === 1 ? 2 : 1;
    const cux = cfi === 0 ? 1 : swc;
    const cuy = cfi === 0 ? (2 - fmo) : shc * (2 - fmo);

    return {
      width: mbW * 16 - cux * (cL + cR),
      height: mbH * 16 * (2 - fmo) - cuy * (cT + cB),
      profile: prof, level: lvl
    };
  }

  // ========== TS DEMUXER ==========

  function demuxTS(data) {
    const len = data.length;
    console.log('[remuxer] demuxTS: input size', len, 'bytes');

    // Sync — find first 0x47 aligned with 188-byte packets
    let sync = -1;
    for (let i = 0; i < Math.min(len - 188, 1000); i++) {
      if (data[i] === 0x47 && data[i + 188] === 0x47) { sync = i; break; }
    }
    if (sync < 0) {
      console.warn('[remuxer] no TS sync found in first 1000 bytes');
      return null;
    }

    let pmtPid = -1, vPid = -1, aPid = -1;
    const pesBuf = {};
    const vFrames = [], aFrames = [];
    let sps = null, pps = null;
    let aProf = 0, aFreq = 0, aCh = 0;

    function flushPES(pid) {
      const b = pesBuf[pid]; if (!b || !b.d.length) return;
      let n = 0; for (const c of b.d) n += c.length;
      const payload = new Uint8Array(n); let o = 0;
      for (const c of b.d) { payload.set(c, o); o += c.length; }

      if (pid === vPid) {
        const nals = []; let ns = -1;
        for (let i = 0; i < payload.length - 2; i++) {
          if (payload[i] === 0 && payload[i+1] === 0) {
            if (payload[i+2] === 1) {
              if (ns >= 0) nals.push(payload.slice(ns, i));
              ns = i + 3;
            } else if (payload[i+2] === 0 && i + 3 < payload.length && payload[i+3] === 1) {
              if (ns >= 0) nals.push(payload.slice(ns, i));
              ns = i + 4; i++;
            }
          }
        }
        if (ns >= 0 && ns < payload.length) nals.push(payload.slice(ns));

        let kf = false; const fNals = [];
        for (const nal of nals) {
          if (!nal.length) continue;
          const t = nal[0] & 0x1f;
          if (t === 7) sps = nal;
          else if (t === 8) pps = nal;
          else if (t === 5) { kf = true; fNals.push(nal); }
          else if (t === 1) fNals.push(nal);
        }

        if (fNals.length) {
          let sz = 0; for (const n of fNals) sz += 4 + n.length;
          const avcc = new Uint8Array(sz); let off = 0;
          for (const n of fNals) {
            avcc[off]   = (n.length >>> 24) & 0xff;
            avcc[off+1] = (n.length >>> 16) & 0xff;
            avcc[off+2] = (n.length >>> 8)  & 0xff;
            avcc[off+3] =  n.length         & 0xff;
            avcc.set(n, off + 4); off += 4 + n.length;
          }
          vFrames.push({ data: avcc, size: sz, pts: b.pts, dts: b.dts >= 0 ? b.dts : b.pts, kf });
        }
      } else if (pid === aPid) {
        let p = 0;
        while (p + 7 <= payload.length) {
          if (payload[p] !== 0xff || (payload[p+1] & 0xf0) !== 0xf0) { p++; continue; }
          const prof = (payload[p+2] >> 6) & 3;
          const fi = (payload[p+2] >> 2) & 0xf;
          const ch = ((payload[p+2] & 1) << 2) | ((payload[p+3] >> 6) & 3);
          const fLen = ((payload[p+3] & 3) << 11) | (payload[p+4] << 3) | ((payload[p+5] >> 5) & 7);
          if (fLen <= 0 || p + fLen > payload.length) break;
          const hSz = (payload[p+1] & 1) === 0 ? 9 : 7;
          const dLen = fLen - hSz;
          if (dLen > 0) {
            if (!aProf) { aProf = prof; aFreq = fi; aCh = ch; }
            aFrames.push({ data: payload.slice(p + hSz, p + hSz + dLen), size: dLen });
          }
          p += fLen;
        }
      }
      delete pesBuf[pid];
    }

    // ─── Single-pass TS parsing ───
    for (let pos = sync; pos + 188 <= len; pos += 188) {
      if (data[pos] !== 0x47) continue;
      const pid = ((data[pos+1] & 0x1f) << 8) | data[pos+2];
      const pusi = !!(data[pos+1] & 0x40);
      const afc = (data[pos+3] >> 4) & 3;
      let off = pos + 4;
      if (afc >= 2) off += 1 + data[pos + 4];
      if (!(afc & 1) || off >= pos + 188) continue;

      // PAT
      if (pid === 0 && pusi && pmtPid < 0) {
        let p = off + data[off] + 1; // skip pointer field → table_id
        p += 8; // skip table_id(1) + section_length(2) + ts_id(2) + version(1) + section_num(1) + last_section_num(1)
        if (p + 3 < pos + 188) {
          pmtPid = ((data[p+2] & 0x1f) << 8) | data[p+3];
          console.log('[remuxer] PAT → PMT PID:', pmtPid);
        }
        continue;
      }

      // PMT
      if (pid === pmtPid && pusi && vPid < 0) {
        let p = off + data[off] + 1; // skip pointer field → table_id
        p++;                          // skip table_id
        const sl = ((data[p] & 0x0f) << 8) | data[p+1]; // section_length
        p += 2;  // past section_length field
        p += 5;  // past program_number(2) + version(1) + section_num(1) + last_section_num(1)
        p += 2;  // past PCR_PID(2)
        const pil = ((data[p] & 0x0f) << 8) | data[p+1]; // program_info_length
        p += 2 + pil;

        // end of section data (before CRC): table_start + 3 + sl - 4
        const tblStart = off + data[off] + 1;
        const end = tblStart + 3 + sl - 4;

        while (p + 4 < end && p + 4 < pos + 188) {
          const st = data[p];
          const ep = ((data[p+1] & 0x1f) << 8) | data[p+2];
          const eil = ((data[p+3] & 0x0f) << 8) | data[p+4];
          p += 5 + eil;
          if (st === 0x1b && vPid < 0) vPid = ep;   // H.264
          if (st === 0x0f && aPid < 0) aPid = ep;   // AAC ADTS
        }
        console.log('[remuxer] PMT → vPid:', vPid, 'aPid:', aPid);
        continue;
      }

      // PES
      if (pid !== vPid && pid !== aPid) continue;
      if (pusi) {
        if (pesBuf[pid]) flushPES(pid);
        let pts = -1, dts = -1, p = off;
        if (p + 8 < pos + 188 && data[p] === 0 && data[p+1] === 0 && data[p+2] === 1) {
          const sid = data[p + 3];
          if (sid >= 0xc0) {
            const flags2 = data[p + 7];
            const pf = (flags2 >> 6) & 3;
            const hl = data[p + 8];
            const pesHdrStart = p + 9;
            if (pf >= 2 && pesHdrStart + 4 < pos + 188) pts = readPTS(data, pesHdrStart);
            if (pf === 3 && pesHdrStart + 9 < pos + 188) dts = readPTS(data, pesHdrStart + 5);
            p = p + 9 + hl;  // skip to PES payload
          }
        }
        if (p < pos + 188) pesBuf[pid] = { d: [data.slice(p, pos + 188)], pts, dts };
        else pesBuf[pid] = { d: [], pts, dts };
      } else if (pesBuf[pid]) {
        pesBuf[pid].d.push(data.slice(off, pos + 188));
      }
    }

    // Flush remaining PES buffers
    if (vPid >= 0 && pesBuf[vPid]) flushPES(vPid);
    if (aPid >= 0 && pesBuf[aPid]) flushPES(aPid);

    console.log('[remuxer] extracted:', vFrames.length, 'video frames,', aFrames.length, 'audio frames, sps:', !!sps, 'pps:', !!pps);

    if (!sps || !vFrames.length) {
      console.warn('[remuxer] FAIL: no SPS or no video frames');
      return null;
    }

    // ─── Normalize timestamps (start from 0) ───
    const baseDTS = vFrames.reduce((min, f) => Math.min(min, f.dts), Infinity);
    for (const f of vFrames) { f.pts -= baseDTS; f.dts -= baseDTS; }

    // ─── Sort by DTS (decode order) ───
    vFrames.sort((a, b) => a.dts - b.dts);

    // ─── Compute durations from DTS differences ───
    for (let i = 0; i < vFrames.length; i++) {
      const next = i + 1 < vFrames.length
        ? vFrames[i+1].dts
        : vFrames[i].dts + (i > 0 ? vFrames[i].dts - vFrames[i-1].dts : 3003);
      vFrames[i].dur = Math.max(1, next - vFrames[i].dts);
    }

    // ─── RLE stts ───
    const vstts = []; let ld = -1, lc = 0;
    for (const f of vFrames) {
      if (f.dur === ld) lc++;
      else { if (lc) vstts.push({ c: lc, d: ld }); ld = f.dur; lc = 1; }
    }
    if (lc) vstts.push({ c: lc, d: ld });

    // ─── ctts (composition offset) if needed ───
    const needCtts = vFrames.some(f => f.pts !== f.dts);
    const vctts = [];
    if (needCtts) {
      let lastOff = null, cnt = 0;
      for (const f of vFrames) {
        const o = f.pts - f.dts;
        if (o === lastOff) cnt++;
        else { if (cnt) vctts.push({ c: cnt, o: lastOff }); lastOff = o; cnt = 1; }
      }
      if (cnt) vctts.push({ c: cnt, o: lastOff });
    }

    // ─── Keyframes (1-based) ───
    const kfs = [];
    for (let i = 0; i < vFrames.length; i++) if (vFrames[i].kf) kfs.push(i + 1);

    const info = parseSPS(sps);
    const vDur = vFrames.reduce((s, f) => s + f.dur, 0);

    console.log('[remuxer] video:', info.width + 'x' + info.height, vFrames.length + ' frames, dur=' + vDur);

    let audio = null;
    if (aFrames.length && aFreq < 13) {
      const sr = SAMPLE_RATES[aFreq];
      const aot = aProf + 1;
      const cfg = u8a((aot << 3) | (aFreq >> 1), ((aFreq & 1) << 7) | (aCh << 3));
      audio = { samples: aFrames, config: cfg, sr, ch: aCh, dur: aFrames.length * 1024 };
      console.log('[remuxer] audio: AAC', sr + 'Hz', aCh + 'ch,', aFrames.length, 'frames');
    }

    return {
      v: { samples: vFrames, sps, pps: pps || u8a(0x68, 0xce, 0x38, 0x80), w: info.width, h: info.height, dur: vDur, stts: vstts, ctts: vctts, kfs },
      a: audio
    };
  }

  // ========== MP4 BOX BUILDERS (no spread, safe for large files) ==========

  function ftyp() {
    return mp4('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  }

  function mvhd(ts, dur) {
    return mp4('mvhd', u32(0), u32(0), u32(0), u32(ts), u32(dur), u32(0x00010000), u16(0x0100),
      new Uint8Array(10),
      u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
      new Uint8Array(24), u32(3));
  }

  function tkhd(id, dur, w, h) {
    return mp4('tkhd', u32(3), u32(0), u32(0), u32(id), u32(0), u32(dur),
      new Uint8Array(8), u16(0), u16(0), u16(id === 2 ? 0x0100 : 0), u16(0),
      u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
      u32((w << 16) >>> 0), u32((h << 16) >>> 0));
  }

  function mdhd(ts, dur) {
    return mp4('mdhd', u32(0), u32(0), u32(0), u32(ts), u32(dur), u32(0x55c40000));
  }

  function hdlr(type) {
    const nm = type === 'vide' ? 'VideoHandler' : 'SoundHandler';
    return mp4('hdlr', u32(0), u32(0), str(type), new Uint8Array(12), str(nm), u8a(0));
  }

  function vmhd() { return mp4('vmhd', u32(1), new Uint8Array(8)); }
  function smhd() { return mp4('smhd', new Uint8Array(8)); }
  function dinf() { return mp4('dinf', mp4('dref', u32(0), u32(1), mp4('url ', u32(1)))); }

  // ── Direct-buffer box builders (no spread, handles thousands of entries) ──

  function sttsBox(entries) {
    const n = entries.length;
    const buf = new Uint8Array(16 + n * 8);
    w32(buf, 0, buf.length); buf[4]=0x73; buf[5]=0x74; buf[6]=0x74; buf[7]=0x73;
    w32(buf, 12, n);
    for (let i = 0; i < n; i++) { w32(buf, 16 + i*8, entries[i].c); w32(buf, 20 + i*8, entries[i].d); }
    return buf;
  }

  function cttsBox(entries) {
    const n = entries.length;
    const buf = new Uint8Array(16 + n * 8);
    w32(buf, 0, buf.length); buf[4]=0x63; buf[5]=0x74; buf[6]=0x74; buf[7]=0x73;
    w32(buf, 12, n);
    for (let i = 0; i < n; i++) { w32(buf, 16 + i*8, entries[i].c); w32(buf, 20 + i*8, entries[i].o); }
    return buf;
  }

  function stscBox(samplesPerChunk) {
    const buf = new Uint8Array(28);
    w32(buf, 0, 28); buf[4]=0x73; buf[5]=0x74; buf[6]=0x73; buf[7]=0x63;
    w32(buf, 12, 1); w32(buf, 16, 1); w32(buf, 20, samplesPerChunk); w32(buf, 24, 1);
    return buf;
  }

  function stszBox(sizes) {
    const n = sizes.length;
    const buf = new Uint8Array(20 + n * 4);
    w32(buf, 0, buf.length); buf[4]=0x73; buf[5]=0x74; buf[6]=0x73; buf[7]=0x7A;
    w32(buf, 16, n);
    for (let i = 0; i < n; i++) w32(buf, 20 + i*4, sizes[i]);
    return buf;
  }

  function stcoBox(offset) {
    const buf = new Uint8Array(20);
    w32(buf, 0, 20); buf[4]=0x73; buf[5]=0x74; buf[6]=0x63; buf[7]=0x6F;
    w32(buf, 12, 1); w32(buf, 16, offset);
    return buf;
  }

  function stssBox(kfs) {
    const n = kfs.length;
    const buf = new Uint8Array(16 + n * 4);
    w32(buf, 0, buf.length); buf[4]=0x73; buf[5]=0x74; buf[6]=0x73; buf[7]=0x73;
    w32(buf, 12, n);
    for (let i = 0; i < n; i++) w32(buf, 16 + i*4, kfs[i]);
    return buf;
  }

  function videoStsd(spsData, ppsData, w, h) {
    const avcC = mp4('avcC',
      u8a(1, spsData[1], spsData[2], spsData[3], 0xff, 0xe1),
      u16(spsData.length), spsData,
      u8a(1), u16(ppsData.length), ppsData);

    const avc1 = mp4('avc1',
      new Uint8Array(6), u16(1), new Uint8Array(16),
      u16(w), u16(h), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
      new Uint8Array(32), u16(0x0018), u16(0xffff), avcC);

    return mp4('stsd', u32(0), u32(1), avc1);
  }

  function audioStsd(cfg, sr, ch) {
    const cfgLen = cfg.length;
    const esds = mp4('esds', u32(0),
      u8a(0x03, 23 + cfgLen, 0x00, 0x01, 0x00,
          0x04, 15 + cfgLen, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x05, cfgLen), cfg,
      u8a(0x06, 0x01, 0x02));

    const mp4a = mp4('mp4a',
      new Uint8Array(6), u16(1), new Uint8Array(8),
      u16(ch), u16(16), u16(0), u16(0), u32((sr << 16) >>> 0), esds);

    return mp4('stsd', u32(0), u32(1), mp4a);
  }

  function buildMoov(v, a, vOff, aOff) {
    // Video stbl
    const stblParts = [videoStsd(v.sps, v.pps, v.w, v.h), sttsBox(v.stts)];
    if (v.ctts && v.ctts.length) stblParts.push(cttsBox(v.ctts));
    stblParts.push(stscBox(v.samples.length), stszBox(v.samples.map(s => s.size)), stcoBox(vOff), stssBox(v.kfs));
    const vStbl = mp4('stbl', ...stblParts);

    const vTrak = mp4('trak',
      tkhd(1, v.dur, v.w, v.h),
      mp4('mdia', mdhd(90000, v.dur), hdlr('vide'),
        mp4('minf', vmhd(), dinf(), vStbl)));

    let aTrak = new Uint8Array(0);
    if (a && a.samples.length) {
      const aStbl = mp4('stbl',
        audioStsd(a.config, a.sr, a.ch),
        sttsBox([{ c: a.samples.length, d: 1024 }]),
        stscBox(a.samples.length),
        stszBox(a.samples.map(s => s.size)),
        stcoBox(aOff));

      const aDurMovie = Math.round(a.dur / a.sr * 90000);
      aTrak = mp4('trak',
        tkhd(2, aDurMovie, 0, 0),
        mp4('mdia', mdhd(a.sr, a.dur), hdlr('soun'),
          mp4('minf', smhd(), dinf(), aStbl)));
    }

    return mp4('moov', mvhd(90000, v.dur), vTrak, aTrak);
  }

  // ========== PUBLIC API ==========

  self.remuxTS2MP4 = function (tsData) {
    try {
      console.log('[remuxer] starting TS→MP4 remux, input:', tsData.byteLength || tsData.length, 'bytes');
      const input = tsData instanceof Uint8Array ? tsData : new Uint8Array(tsData);
      const tracks = demuxTS(input);
      if (!tracks) return null;
      const { v, a } = tracks;

      // Concat sample data (safe for huge arrays — no spread)
      let vSize = 0; for (const s of v.samples) vSize += s.data.length;
      const vData = new Uint8Array(vSize); let vo = 0;
      for (const s of v.samples) { vData.set(s.data, vo); vo += s.data.length; }

      let aData = new Uint8Array(0);
      if (a) {
        let aSize = 0; for (const s of a.samples) aSize += s.data.length;
        aData = new Uint8Array(aSize); let ao = 0;
        for (const s of a.samples) { aData.set(s.data, ao); ao += s.data.length; }
      }

      // Two-pass: measure moov first, then set real offsets
      const ftypBox = ftyp();
      const dummyMoov = buildMoov(v, a, 0, 0);
      const mdatHdr = 8;
      const vOff = ftypBox.length + dummyMoov.length + mdatHdr;
      const aOff = vOff + vData.length;
      const moovBox = buildMoov(v, a, vOff, aOff);

      // Build mdat
      const mdatSize = mdatHdr + vData.length + aData.length;
      const mdatBox = new Uint8Array(mdatSize);
      w32(mdatBox, 0, mdatSize);
      mdatBox[4] = 0x6D; mdatBox[5] = 0x64; mdatBox[6] = 0x61; mdatBox[7] = 0x74; // 'mdat'
      mdatBox.set(vData, 8);
      if (aData.length) mdatBox.set(aData, 8 + vData.length);

      // Final file
      const result = new Uint8Array(ftypBox.length + moovBox.length + mdatBox.length);
      result.set(ftypBox, 0);
      result.set(moovBox, ftypBox.length);
      result.set(mdatBox, ftypBox.length + moovBox.length);

      console.log('[remuxer] SUCCESS — MP4 output:', result.length, 'bytes (' + v.w + 'x' + v.h + ', ' + v.samples.length + ' frames)');
      return result;
    } catch (e) {
      console.error('[remuxer] FAILED:', e.message, e.stack);
      return null;
    }
  };
})();
