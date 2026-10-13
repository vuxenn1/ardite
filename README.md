<p align="center">
  <img src="public/icon.svg" width="76" alt="Ardite logo">
</p>

<h1 align="center">Ardite</h1>

<p align="center">
  A self-hosted video downloader that runs quietly on your Windows PC.<br>
  Open it from any device on the same Wi-Fi, paste a link, and the file downloads to that device.
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

- Supports 1000+ sites (YouTube, Instagram, TikTok, X, Reddit, Twitch and more) through [yt-dlp](https://github.com/yt-dlp/yt-dlp).
- Video up to 4K, or audio only as MP3, M4A, OPUS or WAV.
- YouTube playlists: pick the videos you want and download them as a ZIP or one by one.
- Works from your phone: scan the QR code on the PC, and files save straight to the phone.
- Runs in the background when Windows starts, and uses almost no resources while idle.
- Keeps yt-dlp up to date automatically.
- No npm packages, no build step, no Docker.

## Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org) 20.15 or newer

## Installation

1. Download this repository (**Code > Download ZIP**, or `git clone`) and put the folder somewhere permanent.
2. Double-click `Kur.bat`. It will:
   - download yt-dlp and ffmpeg into `bin\` (about 200 MB, one time only),
   - make Ardite start automatically in the background when you log in to Windows,
   - add a firewall rule so devices on your home network can connect (asks for admin permission),
   - start Ardite and open it in your browser.

Running `Kur.bat` again is safe and can be used to repair the installation.

## Usage

| Where | Address |
|---|---|
| On the PC | http://localhost:7878 |
| On a phone (same Wi-Fi) | `http://<pc-ip>:7878`, or scan the QR code shown on the PC |

1. Paste a link. A preview appears with the title, length and best available quality.
2. Choose **Video** or **Audio only**, then the quality or audio format.
3. Press the download button. When it finishes, the file saves automatically (or press **Save**).

The file always goes to the device you are using. Temporary copies on the PC are deleted after 30 minutes.

**Playlists:** paste a playlist link, untick the videos you don't want, and press **Download**. When it finishes, use **Download ZIP** to get everything in one file.

**Tip:** on a phone, use the browser's **Add to Home Screen** to open Ardite like an app. On Android you can then share links to it directly.

### Management scripts

The scripts print their messages in Turkish.

| File | What it does |
|---|---|
| `Kur.bat` | Install or repair |
| `Baslat.bat` | Start Ardite and open it in the browser |
| `Durdur.bat` | Stop Ardite (also stops running downloads) |
| `Durum.bat` | Show status, addresses, autostart and firewall state |
| `Kaldir.bat` | Stop Ardite and remove autostart and the firewall rule (delete the folder yourself afterwards) |

## Configuration

Optional. Create `data\config.json`; every setting is optional:

```json
{
  "port": 7878,
  "maxConcurrent": 2,
  "keepFilesMinutes": 30,
  "maxPlaylistItems": 500,
  "cookiesFromBrowser": "firefox"
}
```

| Setting | Meaning |
|---|---|
| `port` | Port number. If you change it, also update `localhost:7878` in the `.bat` files |
| `maxConcurrent` | Number of downloads that run at the same time |
| `keepFilesMinutes` | How long finished files are kept before deletion |
| `maxPlaylistItems` | Maximum number of videos listed from a playlist |
| `cookiesFromBrowser` | Browser to read cookies from (see below) |

Restart Ardite after changing settings (`Durdur.bat`, then `Baslat.bat`).

## Cookies

Some content requires login, such as age-restricted or private videos and some Instagram posts. There are two options:

- Put a `cookies.txt` file (Netscape format, exported with a browser extension) in `data\`. This is the most reliable option.
- Or set `"cookiesFromBrowser": "firefox"` in `config.json`. Chrome and Edge lock their cookies on Windows, so Firefox is recommended.

Treat `cookies.txt` like a password. Using a secondary account is safer.

## Troubleshooting

- **Phone can't connect:** make sure the phone is on the same Wi-Fi (not a guest network) and the PC is awake. Run `Kur.bat` again and set your network to Private when asked.
- **"Sign in to confirm" or "requires login" errors:** add cookies (see above).
- **A site suddenly stopped working:** restart Ardite; this triggers a yt-dlp update.
- **Logs:** `data\ardite.log`.

## Security

There is no login. Anyone on your local network can open Ardite and download videos, but nothing else on your PC is accessible. The firewall rule only allows Private networks. Do not expose port 7878 to the internet.

## Disclaimer

Only download content you own or have permission to download. You are responsible for how you use this tool.

## Credits

- [yt-dlp](https://github.com/yt-dlp/yt-dlp): download engine
- [FFmpeg](https://ffmpeg.org): merging and conversion
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator): QR codes

## License

[MIT](LICENSE)
