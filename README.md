<div align="center">

<img src="icons/icon128.png" width="96" height="96" alt="TexHub Video Downloader logo">

# TexHub Video Downloader

**Detect and download HLS (M3U8) streams and direct video files — right from your browser.**

[![Manifest](https://img.shields.io/badge/Manifest-V3-f09018)](manifest.json)
[![Version](https://img.shields.io/badge/version-1.0.0-f09018)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-f09018)](LICENSE)

</div>

---

## ✨ Features

- **🎯 Automatic detection** — finds HLS streams **and** direct video files via network
  requests, page scripts and `<video>` / `<source>` elements, including dynamically
  loaded players.
- **🎬 Many formats** — direct downloads for `.mp4`, `.m4v`, `.webm`, `.mkv`, `.mov`,
  `.ogv`, `.avi`, `.flv`, `.wmv`, `.mpg` / `.mpeg`, `.3gp`. Direct files download
  natively through the browser, so any size or session-protected file works.
- **👁️ Inline preview** — direct files show a thumbnail with detected resolution,
  duration and file size before you download.
- **🧩 Quality selection** — pick any variant from an HLS master playlist; estimated
  file sizes are shown when available.
- **🔄 MP4 conversion** — lossless MPEG-TS → MP4 remux (with a `mux.js` fallback);
  fMP4/MP4 and direct files keep their original container.
- **🔐 AES-128 support** — encrypted HLS segments are decrypted on the fly.
- **⏯️ Background downloads** — keep running after the popup closes; pause, resume and
  cancel are supported.
- **🖱️ In-page button** — a download button appears right on video elements.

## 🚀 Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder
4. Pin **TexHub Video Downloader** and browse to any page with video

> Works in Chrome, Edge, Brave and other Chromium browsers.

## 🧭 How to use

1. Open a page that plays a video.
2. Click the TexHub toolbar icon (the badge shows how many sources were found).
3. Choose a quality (for HLS) and hit **Download** — or click the button that appears
   over the video.
4. The file is saved to your Downloads folder.

## 🗂️ Project structure

```
texhub-video-downloader/
├── manifest.json            # MV3 manifest
├── icons/                   # 16 / 32 / 48 / 128 px icons
└── src/
    ├── background.js        # Service worker: detection, parsing, downloads, header rules
    ├── content/
    │   ├── interceptor.js   # MAIN world: hooks fetch / XHR to spot media URLs
    │   └── content.js       # ISOLATED world: page scan + on-video overlay
    ├── popup/               # Toolbar popup UI (html / css / js)
    ├── download/            # HLS download tab: fetch → decrypt → merge → MP4 → save
    ├── lib/                 # Remuxer + mux.js
    └── shared/
        └── utils.js         # Shared helpers used across every context
```

## 🔐 Permissions

| Permission | Why it's needed |
|---|---|
| `webRequest` | Detect media requests (`.m3u8`, `.mp4`, …) and read sizes |
| `declarativeNetRequest` | Set `Referer` / `Origin` on HLS segment fetches so protected streams load |
| `downloads` | Save the final video file |
| `tabs` | Open and manage the HLS download tab |
| `storage` | Persist detected sources and active-download state |
| `activeTab`, `<all_urls>` | Detect streams on the page you are viewing |

Your privacy matters: the extension **collects nothing** and sends nothing to any
server. See [PRIVACY.md](PRIVACY.md).

## ⚖️ Legal

Only download content you own or are authorised to download. Respect the terms of
service of the sites you use and applicable copyright law.

## 📄 License

[MIT](LICENSE) © 2026 **TexHub Pro**

## 📬 Contact

Maintained by **TexHub Pro** — texus.tj@gmail.com
