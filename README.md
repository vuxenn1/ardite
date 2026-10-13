<p align="center">
  <img src="public/icon.svg" width="76" alt="Ardite logo">
</p>

<h1 align="center">Ardite</h1>

<p align="center">
  A self-hosted video downloader for your Windows PC.<br>
  Open it from any device on the same Wi-Fi, paste a link and the file downloads to that device.
</p>

<p align="center">
  <img src="docs/desktop.png" width="640" alt="Desktop view">
</p>

<p align="center">
  <img src="docs/phone.png" width="260" alt="Phone view">
  &nbsp;&nbsp;
  <img src="docs/playlist-light.png" width="260" alt="Playlist selection">
</p>

## Features

- Works with YouTube, Instagram, TikTok, X and [1000+ other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
- Video up to 4K or audio only (MP3, M4A, OPUS, WAV)
- Playlists: pick the videos you want and download them as a ZIP
- Use it from your phone by scanning the QR code on the PC

## Installation

Requires Windows 10/11 and [Node.js](https://nodejs.org) 20.15 or newer.

1. Download this repository (**Code > Download ZIP**) and extract it somewhere permanent.
2. Double-click `install.bat`.

This downloads yt-dlp and ffmpeg, makes Ardite start in the background with Windows and opens the firewall for your home network.

## Usage

- On the PC: open **http://localhost:7878**
- On a phone (same Wi-Fi): scan the QR code shown on the PC

Paste a link, choose video or audio and press download.

| Script | What it does |
|---|---|
| `start.bat` | Start Ardite |
| `stop.bat` | Stop Ardite |
| `status.bat` | Show status and addresses |
| `uninstall.bat` | Remove autostart and the firewall rule |

Some videos (age-restricted or private) require login. For these, put a `cookies.txt` file (Netscape format, exported with a browser extension) in the `data` folder. Keep it private.

## Disclaimer

Only download content you own or have permission to download.

## License

[MIT](LICENSE). Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org).
