# Prolink Stream Overlay

Real-time **Now Playing** overlay and **waveform visualization** for Pioneer DJ gear. Built for livestreamers, content creators, and DJs who want to show what's playing on screen.

Works with any Pioneer/AlphaTheta gear that supports the Pro DJ Link protocol: CDJ-2000NXS2, CDJ-3000, XDJ-XZ, XDJ-RX3, and more.

## Features

- 🎵 **Now Playing overlay** — track title, artist, artwork, BPM, key, genre
- 🌊 **Dual-deck waveform display** — HD color waveforms with moving playhead
- 🎨 **Customizable** — themes, colors, fonts, positioning via settings page
- 📝 **Set recording** — auto-records your tracklist with timestamps
- 📤 **Export** — text, CSV, JSON, 1001tracklists, DJ Studio (.DJS)
- 🔌 **OBS-ready** — add as a Browser Source and go

## Quick Start

```bash
# Clone and install
git clone https://github.com/sj-unit72/prolink-stream-overlay.git
cd prolink-stream-overlay
npm install

# Run (make sure your CDJs are on the same network)
node server.js
```

Open in your browser:

| Page | URL | Description |
|------|-----|-------------|
| **Overlay** | `http://localhost:4455/overlay` | Now Playing — add as OBS Browser Source |
| **Waveform** | `http://localhost:4455/waveform` | Dual-deck waveform display |
| **Settings** | `http://localhost:4455/settings` | Customize appearance |

### OBS Setup

1. Add a **Browser Source** in OBS
2. Set URL to `http://localhost:4455/overlay` (or `/waveform`)
3. Set width/height to match your stream layout
4. Done — it updates automatically

## Dev Mode

Test without hardware:

```bash
node server.js --dev
```

Simulates two decks with fake track data and waveforms.

## Options

```bash
node server.js [--port 4455] [--dev]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `4455` | Server port |
| `--dev` | off | Simulated deck mode |

## Network Requirements

- Your computer and DJ gear must be on the **same network**
- The server connects as a virtual CDJ (ID 5) on the Pro DJ Link network
- Uses UDP ports 50000-50002 — make sure your firewall allows them

## Set Recording & Export

1. Open the Settings page (`/settings`)
2. Click **Start Recording** — tracks are logged as they play
3. Click **Stop Recording** — export in multiple formats:
   - **Text** — clean tracklist with timestamps
   - **CSV** — spreadsheet-friendly
   - **JSON** — full metadata
   - **1001tracklists** — ready to submit
   - **DJ Studio (.DJS)** — import into DJ Studio

## Compatibility

Tested with:
- Pioneer XDJ-XZ
- Should work with any Pro DJ Link device (CDJ-2000NXS2, CDJ-3000, XDJ-RX3, DJM-900NXS2, etc.)

Uses [prolink-connect](https://github.com/EvanPurkhiser/prolink-connect) under the hood.

## License

MIT

## Contributing

Issues and PRs welcome. If you test with different hardware, let us know!
