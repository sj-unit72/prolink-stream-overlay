#!/usr/bin/env node
/**
 * Prolink Overlay Server
 * 
 * Connects to Pioneer CDJs via Prolink protocol and provides:
 * - Now Playing overlay for OBS (Browser Source)
 * - Real-time waveform visualization
 * - Set recording with tracklist generation
 * - Export: text, CSV, JSON, DJ Studio (.DJS)
 * 
 * Usage:
 *   node server.js [--port 4455] [--dev]
 * 
 * OBS Setup:
 *   Browser Source → http://localhost:4455/overlay
 *   Waveform:     → http://localhost:4455/waveform
 *   Settings:     → http://localhost:4455/settings
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// === Args ===
const args = process.argv.slice(2);
const PORT = parseInt(args.find((_, i) => args[i - 1] === '--port') || '4455');
const DEV_MODE = args.includes('--dev');

// === State ===
let prolink = null;
let network = null;
let connected = false;
let connectionError = null;
const deckState = {};
const artworkCache = {};
const waveformCache = {};  // `${deviceId}-${trackId}` → { preview, detailed, hd, beatgrid }
const metadataCache = {};
const metadataFetching = new Set();

// Set Recording State
let recording = false;
let currentSet = null; // { startTime, tracks: [{ deckId, title, artist, key, bpm, startTime, endTime, artwork }] }
const setHistory = []; // completed sets

let settings = loadSettings();

// === Settings ===
function loadSettings() {
  const settingsFile = path.join(__dirname, 'settings.json');
  const defaults = {
    activeDeck: 'auto',
    theme: 'default',
    position: 'bottom-left',
    showArtwork: true,
    showBpm: true,
    showKey: true,
    showGenre: false,
    animateTransitions: true,
    backgroundColor: 'rgba(0,0,0,0.75)',
    textColor: '#ffffff',
    accentColor: '#1db954',
    fontFamily: "'Inter', 'Helvetica Neue', sans-serif",
    fontSize: 16,
    artworkSize: 120,
    borderRadius: 12,
    padding: 16,
    backgroundImage: '',
    customCSS: '',
    overlayWidth: 500,
    overlayHeight: 160,
    // Waveform settings
    waveformHeight: 80,
    waveformColor: '#1db954',
    waveformPlayedColor: '#1db954',
    waveformUnplayedColor: 'rgba(255,255,255,0.3)',
    waveformBeatMarkers: true,
    waveformStyle: 'pointed', // 'pointed', 'bars', 'smooth'
  };
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

function saveSettings(s) {
  settings = { ...settings, ...s };
  fs.writeFileSync(path.join(__dirname, 'settings.json'), JSON.stringify(settings, null, 2));
}

// === Prolink Connection ===
async function connectProlink() {
  try {
    prolink = require('prolink-connect');
    console.log('🎧 Connecting to Prolink network...');
    
    network = await prolink.bringOnline();
    await new Promise(r => setTimeout(r, 4000));
    
    const devices = [...network.deviceManager.devices.values()];
    if (devices.length === 0) throw new Error('No Pioneer devices found');
    
    console.log(`📡 Found ${devices.length} device(s):`);
    devices.forEach(d => console.log(`   ${d.name} (ID: ${d.id}, IP: ${d.ip.address})`));
    
    const deviceIp = devices[0].ip.address;
    let matchedIface = null;
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const d = deviceIp.split('.').map(Number);
          const i = addr.address.split('.').map(Number);
          const m = addr.netmask.split('.').map(Number);
          if (d.every((p, x) => (p & m[x]) === (i[x] & m[x]))) matchedIface = addr;
        }
      }
    }
    
    network.configure({ vcdjId: 5, iface: matchedIface });
    network.connect();
    connected = true;
    connectionError = null;
    console.log('✅ Connected as virtual CDJ #5\n');
    
    network.statusEmitter.on('status', handleStatus);
    
  } catch (e) {
    connected = false;
    connectionError = e.message;
    console.error('❌ Prolink connection failed:', e.message);
    // Clean up network before retrying to release bound ports
    if (network) try { network.disconnect(); } catch {}
    network = null;
    setTimeout(connectProlink, 10000);
  }
}

async function handleStatus(status) {
  const deckId = status.deviceId;
  if (deckId > 4) return; // Skip mixer
  
  const prev = deckState[deckId] || {};
  const trackChanged = status.trackId > 0 && status.trackId !== prev.trackId;
  const stateChanged = status.playState !== prev.playState;
  
  const states = { 0: 'empty', 1: 'paused', 2: 'cueing', 3: 'playing', 4: 'loading', 5: 'searching', 6: 'cued', 7: 'unknown' };
  
  deckState[deckId] = {
    ...deckState[deckId],
    deckId,
    playState: states[status.playState] || 'unknown',
    bpm: status.trackBPM ? status.trackBPM.toFixed(1) : null,
    effectiveBpm: status.effectivePitch ? (status.trackBPM * status.effectivePitch / 100).toFixed(1) : null,
    beat: status.beat,
    beatInMeasure: status.beatInMeasure,
    isOnAir: status.isOnAir,
    isMaster: status.isMaster,
    trackId: status.trackId,
    trackSlot: status.trackSlot,
    trackDeviceId: status.trackDeviceId,
    trackType: status.trackType,
    // Beat position for waveform playback head
    playbackPosition: status.beat,
  };
  
  // Fetch all data on track change
  if (trackChanged && !metadataFetching.has(`${deckId}-${status.trackId}`) && status.trackId > 0) {
    fetchTrackData(deckId, status);
  }
  
  // Record set tracking
  if (recording && trackChanged && deckState[deckId].isOnAir) {
    recordTrackChange(deckId);
  }
  
  // Broadcast state changes (throttled)
  if (stateChanged || trackChanged || prev.isOnAir !== status.isOnAir) {
    broadcastState();
  }
  
  // Always broadcast beat position for waveform animation
  if (deckState[deckId].playState === 'playing') {
    broadcastBeat(deckId);
  }
}

async function fetchTrackData(deckId, status) {
  const cacheKey = `${deckId}-${status.trackId}`;
  metadataFetching.add(cacheKey);
  
  const query = {
    deviceId: status.trackDeviceId,
    trackSlot: status.trackSlot,
    trackType: status.trackType,
    trackId: status.trackId,
  };
  
  try {
    // Fetch metadata
    const meta = await Promise.race([
      network.db.getMetadata(query),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    ]);
    
    if (meta) {
      metadataCache[cacheKey] = meta;
      deckState[deckId].title = meta.title || 'Unknown';
      deckState[deckId].artist = meta.artist?.name || 'Unknown';
      deckState[deckId].album = meta.album?.name || '';
      deckState[deckId].key = meta.key?.name || '';
      deckState[deckId].genre = meta.genre?.name || '';
      deckState[deckId].duration = meta.duration || 0;
      deckState[deckId].label = meta.label?.name || '';
      deckState[deckId].comment = meta.comment || '';
      deckState[deckId].tempo = meta.tempo ? (meta.tempo / 100).toFixed(1) : null;
      
      console.log(`🎵 Deck ${deckId}: ${meta.artist?.name} - ${meta.title} [${meta.key?.name || '?'}]`);
      
      // Fetch artwork — API expects { ...query, track: meta }
      if (meta.artwork?.id) {
        try {
          const art = await Promise.race([
            network.db.getArtwork({ ...query, track: meta }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('art timeout')), 5000))
          ]);
          if (art && art.length > 0) {
            const b64 = Buffer.from(art).toString('base64');
            const mime = art[0] === 0xFF ? 'image/jpeg' : 'image/png';
            artworkCache[cacheKey] = `data:${mime};base64,${b64}`;
            deckState[deckId].artwork = artworkCache[cacheKey];
            console.log(`   🖼 Artwork: ${(art.length / 1024).toFixed(1)}KB`);
          }
        } catch (e) {
          console.log(`   ⚠️ Artwork: ${e.message}`);
        }
      }
      
      // Fetch waveforms — API expects { ...query, track: meta }
      try {
        const waveforms = await Promise.race([
          network.db.getWaveforms({ ...query, track: meta }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('wf timeout')), 8000))
        ]);
        if (waveforms) {
          // HD waveforms from prolink-connect are arrays of { height, color: [r,g,b] }
          // Downsample to ~400 points for the client and send as JSON
          let hdData = null;
          if (waveforms.waveformHd && Array.isArray(waveforms.waveformHd)) {
            const src = waveforms.waveformHd;
            const targetLen = 400;
            const step = Math.max(1, Math.floor(src.length / targetLen));
            hdData = [];
            for (let i = 0; i < src.length; i += step) {
              // Average heights over the step window
              let maxH = 0;
              let rSum = 0, gSum = 0, bSum = 0, count = 0;
              for (let j = i; j < Math.min(i + step, src.length); j++) {
                const s = src[j];
                if (s && typeof s === 'object') {
                  if (s.height > maxH) maxH = s.height;
                  rSum += s.color?.[0] || 0;
                  gSum += s.color?.[1] || 0;
                  bSum += s.color?.[2] || 0;
                  count++;
                }
              }
              hdData.push({
                h: maxH,
                r: count ? rSum / count : 0,
                g: count ? gSum / count : 0,
                b: count ? bSum / count : 0,
              });
            }
          }
          waveformCache[cacheKey] = {
            preview: waveforms.preview ? Buffer.from(waveforms.preview).toString('base64') : null,
            detailed: waveforms.detailed ? Buffer.from(waveforms.detailed).toString('base64') : null,
            hd: hdData,
          };
          deckState[deckId].hasWaveform = true;
          console.log(`   🌊 Waveform: preview=${!!waveforms.preview} detailed=${!!waveforms.detailed} hd=${hdData ? hdData.length + ' points' : 'null'}`);
        }
      } catch (e) {
        console.log(`   ⚠️ Waveform: ${e.message}`);
      }
      
      // Fetch beatgrid
      try {
        const beatgrid = await Promise.race([
          network.db.getBeatgrid ? network.db.getBeatgrid(query) : Promise.resolve(null),
          new Promise((_, rej) => setTimeout(() => rej(new Error('bg timeout')), 5000))
        ]);
        if (beatgrid) {
          if (!waveformCache[cacheKey]) waveformCache[cacheKey] = {};
          waveformCache[cacheKey].beatgrid = Buffer.from(beatgrid).toString('base64');
          console.log(`   📐 Beatgrid: ${(beatgrid.length / 1024).toFixed(1)}KB`);
        }
      } catch (e) {
        console.log(`   ⚠️ Beatgrid: ${e.message}`);
      }
      
      broadcastState();
    }
  } catch (e) {
    console.log(`   ⚠️ Metadata timeout for Deck ${deckId}`);
  } finally {
    metadataFetching.delete(cacheKey);
  }
}

// === Set Recording ===
function startRecording() {
  recording = true;
  currentSet = {
    id: crypto.randomUUID(),
    startTime: new Date().toISOString(),
    startTimestamp: Date.now(),
    tracks: [],
    transitions: [],
  };
  console.log('🔴 Recording started');
  broadcastState();
  return currentSet.id;
}

function stopRecording() {
  if (!currentSet) return null;
  recording = false;
  
  // Close last track
  if (currentSet.tracks.length > 0) {
    const last = currentSet.tracks[currentSet.tracks.length - 1];
    if (!last.endTime) last.endTime = new Date().toISOString();
    if (!last.endTimestamp) last.endTimestamp = Date.now();
  }
  
  currentSet.endTime = new Date().toISOString();
  currentSet.endTimestamp = Date.now();
  currentSet.duration = currentSet.endTimestamp - currentSet.startTimestamp;
  
  const completedSet = { ...currentSet };
  setHistory.push(completedSet);
  
  // Save to disk
  const setsDir = path.join(__dirname, 'sets');
  fs.mkdirSync(setsDir, { recursive: true });
  fs.writeFileSync(
    path.join(setsDir, `${completedSet.id}.json`),
    JSON.stringify(completedSet, null, 2)
  );
  
  console.log(`⏹ Recording stopped: ${completedSet.tracks.length} tracks, ${formatDuration(completedSet.duration)}`);
  currentSet = null;
  broadcastState();
  return completedSet;
}

function recordTrackChange(deckId) {
  if (!currentSet) return;
  const deck = deckState[deckId];
  if (!deck.title) return;
  
  // Close previous track
  if (currentSet.tracks.length > 0) {
    const prev = currentSet.tracks[currentSet.tracks.length - 1];
    if (!prev.endTime) {
      prev.endTime = new Date().toISOString();
      prev.endTimestamp = Date.now();
    }
  }
  
  const cacheKey = `${deckId}-${deck.trackId}`;
  
  currentSet.tracks.push({
    deckId,
    trackId: deck.trackId,
    title: deck.title,
    artist: deck.artist,
    album: deck.album || '',
    key: deck.key || '',
    bpm: deck.bpm || '',
    genre: deck.genre || '',
    label: deck.label || '',
    duration: deck.duration || 0,
    artwork: artworkCache[cacheKey] || null,
    startTime: new Date().toISOString(),
    startTimestamp: Date.now(),
    endTime: null,
    endTimestamp: null,
  });
  
  console.log(`   📝 Recorded: #${currentSet.tracks.length} ${deck.artist} - ${deck.title}`);
}

// === Export Functions ===
function exportTracklist(set, format) {
  switch (format) {
    case 'text':
      return set.tracks.map((t, i) => 
        `${String(i + 1).padStart(2)}. ${t.artist} - ${t.title}${t.key ? ` [${t.key}]` : ''}`
      ).join('\n');
    
    case 'csv':
      const header = 'Track,Artist,Title,Key,BPM,Genre,Label,Start Time,Duration';
      const rows = set.tracks.map((t, i) => 
        `${i+1},"${t.artist}","${t.title}","${t.key}","${t.bpm}","${t.genre}","${t.label}","${t.startTime}","${t.duration}"`
      );
      return [header, ...rows].join('\n');
    
    case 'json':
      return JSON.stringify({
        setId: set.id,
        date: set.startTime,
        duration: set.duration,
        trackCount: set.tracks.length,
        tracks: set.tracks.map((t, i) => ({
          position: i + 1,
          artist: t.artist,
          title: t.title,
          key: t.key,
          bpm: t.bpm,
          genre: t.genre,
          label: t.label,
          startTime: t.startTime,
          endTime: t.endTime,
        }))
      }, null, 2);
    
    case 'djstudio':
      return generateDJStudioProject(set);
    
    case '1001tracklists':
      return set.tracks.map((t, i) => 
        `${String(i + 1).padStart(2)}. ${t.artist} - ${t.title} [${t.label || 'Unknown'}]`
      ).join('\n');
    
    default:
      return exportTracklist(set, 'text');
  }
}

function generateDJStudioProject(set) {
  // DJ Studio project format (as reverse-engineered)
  const projectId = crypto.randomUUID();
  
  const project = {
    name: `Live Set ${new Date(set.startTime).toLocaleDateString()}`,
    artist: '',
    bpmRange: {
      min: Math.min(...set.tracks.map(t => parseFloat(t.bpm) || 120)),
      max: Math.max(...set.tracks.map(t => parseFloat(t.bpm) || 128)),
    },
    channelCount: 2,
    duration: set.duration / 1000,
    trackCount: set.tracks.length,
    mixList: set.tracks.map((t, i) => ({
      key: `track_${i}`,
      libraryKey: `prolink_${t.trackId || i}`,
      channel: t.deckId === 1 ? 0 : 1,
    })),
    automations: [],
    effects: [],
    jingles: [],
    videoSettings: {},
    controlDefaults: {},
    masterEffects: [],
    recording: {
      source: 'prolink-overlay',
      capturedAt: set.startTime,
    },
  };
  
  // Track library entries
  const tracks = set.tracks.map((t, i) => ({
    id: `prolink_${t.trackId || i}`,
    title: t.title,
    artist: t.artist,
    album: t.album || '',
    bpm: parseFloat(t.bpm) || 0,
    key: t.key,
    duration: t.duration || 0,
    genre: t.genre || '',
    label: t.label || '',
  }));
  
  // Mix data per track
  const mixData = set.tracks.map((t, i) => {
    const startOffset = (t.startTimestamp - set.startTimestamp) / 1000;
    return {
      trackKey: `track_${i}`,
      loadTime: startOffset,
      channel: t.deckId === 1 ? 0 : 1,
      cueData: { systemCuePoints: [], hotCuePoints: [], memCuePoints: [] },
      mixMap: [],  // Would need beat-by-beat data for full reconstruction
      automations: [],
    };
  });
  
  return JSON.stringify({ project, tracks, mixData }, null, 2);
}

// === Active Deck Logic ===
function getActiveDeck() {
  if (settings.activeDeck === '1') return deckState[1] || null;
  if (settings.activeDeck === '2') return deckState[2] || null;
  
  const decks = Object.values(deckState).filter(d => d.title);
  const playing = decks.filter(d => d.playState === 'playing');
  const onAir = playing.filter(d => d.isOnAir);
  if (onAir.length > 0) return onAir[0];
  if (playing.length > 0) return playing[0];
  // Show any deck with a loaded track (cued, unknown play state, etc.)
  const active = decks.filter(d => d.playState !== 'empty' && d.playState !== 'ended');
  if (active.length > 0) return active[0];
  return null;
}

// === WebSocket ===
const wsClients = new Set();
let lastBeatBroadcast = 0;

function broadcastState() {
  const active = getActiveDeck();
  const activeCacheKey = active ? `${active.deckId}-${active.trackId}` : null;
  
  const msg = JSON.stringify({
    type: 'now_playing',
    connected,
    recording,
    setTrackCount: currentSet?.tracks?.length || 0,
    deck: active ? {
      id: active.deckId,
      title: active.title || '',
      artist: active.artist || '',
      album: active.album || '',
      bpm: active.bpm || '',
      effectiveBpm: active.effectiveBpm || '',
      key: active.key || '',
      genre: active.genre || '',
      label: active.label || '',
      artwork: active.artwork || null,
      playState: active.playState,
      isOnAir: active.isOnAir,
      duration: active.duration || 0,
      hasWaveform: !!waveformCache[activeCacheKey],
    } : null,
    decks: Object.values(deckState).map(d => ({
      id: d.deckId,
      title: d.title || '',
      artist: d.artist || '',
      bpm: d.bpm || '',
      key: d.key || '',
      duration: d.duration || 0,
      playState: d.playState,
      isOnAir: d.isOnAir,
    })),
    settings,
  });
  
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function broadcastBeat(deckId) {
  const now = Date.now();
  if (now - lastBeatBroadcast < 50) return; // Cap at 20fps
  lastBeatBroadcast = now;
  
  const deck = deckState[deckId];
  const msg = JSON.stringify({
    type: 'beat',
    deckId,
    beat: deck.beat,
    beatInMeasure: deck.beatInMeasure,
    bpm: deck.bpm,
  });
  
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// === Express Server ===
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Pages
app.get('/overlay', (_, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/waveform', (_, res) => res.sendFile(path.join(__dirname, 'public', 'waveform.html')));
app.get('/settings', (_, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));

// API — State
app.get('/api/state', (_, res) => {
  res.json({ connected, connectionError, recording, decks: deckState, active: getActiveDeck(), settings });
});

// API — Waveform data
app.get('/api/waveform/:deckId', (req, res) => {
  const deck = deckState[parseInt(req.params.deckId)];
  if (!deck) return res.json({ error: 'deck not found' });
  const cacheKey = `${deck.deckId}-${deck.trackId}`;
  res.json({
    deckId: deck.deckId,
    title: deck.title,
    artist: deck.artist,
    waveform: waveformCache[cacheKey] || null,
  });
});

// API — Settings
app.get('/api/settings', (_, res) => res.json(settings));
app.post('/api/settings', (req, res) => {
  saveSettings(req.body);
  broadcastState();
  res.json({ ok: true, settings });
});

// API — Recording
app.post('/api/recording/start', (_, res) => {
  const id = startRecording();
  res.json({ ok: true, setId: id });
});

app.post('/api/recording/stop', (_, res) => {
  const set = stopRecording();
  res.json({ ok: true, set });
});

app.get('/api/recording/status', (_, res) => {
  res.json({
    recording,
    set: currentSet ? {
      id: currentSet.id,
      startTime: currentSet.startTime,
      trackCount: currentSet.tracks.length,
      tracks: currentSet.tracks.map(t => ({ artist: t.artist, title: t.title, startTime: t.startTime })),
      duration: Date.now() - currentSet.startTimestamp,
    } : null,
  });
});

// API — Export
app.get('/api/sets', (_, res) => {
  const setsDir = path.join(__dirname, 'sets');
  if (!fs.existsSync(setsDir)) return res.json([]);
  const files = fs.readdirSync(setsDir).filter(f => f.endsWith('.json'));
  const sets = files.map(f => {
    const s = JSON.parse(fs.readFileSync(path.join(setsDir, f), 'utf8'));
    return { id: s.id, date: s.startTime, trackCount: s.tracks?.length || 0, duration: s.duration };
  });
  res.json(sets);
});

app.get('/api/sets/:id', (req, res) => {
  const file = path.join(__dirname, 'sets', `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
});

app.get('/api/sets/:id/export/:format', (req, res) => {
  const file = path.join(__dirname, 'sets', `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  const format = req.params.format;
  const exported = exportTracklist(set, format);
  
  const contentTypes = {
    text: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    djstudio: 'application/json',
    '1001tracklists': 'text/plain',
  };
  
  const extensions = {
    text: 'txt',
    csv: 'csv',
    json: 'json',
    djstudio: 'djs.json',
    '1001tracklists': 'txt',
  };
  
  const dateStr = new Date(set.startTime).toISOString().split('T')[0];
  res.setHeader('Content-Type', contentTypes[format] || 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="set-${dateStr}.${extensions[format] || 'txt'}"`);
  res.send(exported);
});

// API — Reconnect
app.post('/api/reconnect', (_, res) => {
  if (network) try { network.disconnect(); } catch {}
  connected = false;
  connectProlink();
  res.json({ ok: true });
});

// WebSocket
wss.on('connection', (ws) => {
  wsClients.add(ws);
  
  // Send current state immediately (full state, same as broadcastState)
  broadcastState();
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      // Handle waveform requests from client
      if (msg.type === 'get_waveform') {
        const deck = deckState[msg.deckId];
        if (deck) {
          const cacheKey = `${deck.deckId}-${deck.trackId}`;
          ws.send(JSON.stringify({
            type: 'waveform_data',
            deckId: msg.deckId,
            waveform: waveformCache[cacheKey] || null,
          }));
        }
      }
    } catch {}
  });
  
  ws.on('close', () => wsClients.delete(ws));
});

// === Start ===
server.listen(PORT, () => {
  console.log(`
┌──────────────────────────────────────────────────┐
│   🎧 Prolink Overlay                            │
├──────────────────────────────────────────────────┤
│   Now Playing:  http://localhost:${PORT}/overlay     │
│   Waveform:     http://localhost:${PORT}/waveform    │
│   Settings:     http://localhost:${PORT}/settings    │
│   API:          http://localhost:${PORT}/api/state   │
└──────────────────────────────────────────────────┘
`);
  
  if (DEV_MODE) {
    console.log('🔧 Dev mode: simulated deck state (starts blank, track loads in 3s)');
    connected = true;
    connectionError = null;
    
    // Generate fake waveform data for dev mode
    const fakeWaveform = Buffer.alloc(400);
    for (let i = 0; i < 400; i++) {
      fakeWaveform[i] = Math.floor(Math.sin(i * 0.1) * 60 + Math.random() * 40 + 70);
    }
    
    broadcastState(); // initial blank state
    
    // Simulate track loading after 3s
    setTimeout(() => {
      console.log('🎵 Dev: Track loaded on Deck 1');
      deckState[1] = {
        deckId: 1, title: 'Saltwater', artist: 'Claptone, Chicane, Moya Brennan',
        album: 'Saltwater', bpm: '122.0', effectiveBpm: '122.3', key: '4A',
        genre: 'Melodic House & Techno', label: 'Different Recordings',
        playState: 'playing', isOnAir: true, artwork: null,
        duration: 385, trackId: 1001, beat: 0, beatInMeasure: 1,
        hasWaveform: true,
      };
      deckState[2] = {
        deckId: 2, title: 'Polar Lights', artist: 'Nora En Pure',
        album: 'Polar Lights', bpm: '124.0', effectiveBpm: '122.0', key: '9B',
        genre: 'House', label: 'Enormous Tunes',
        playState: 'cued', isOnAir: false, artwork: null,
        duration: 412, trackId: 1002, beat: 0, beatInMeasure: 1,
        hasWaveform: true,
      };
      waveformCache['1-1001'] = { preview: fakeWaveform.toString('base64') };
      waveformCache['2-1002'] = { preview: fakeWaveform.toString('base64') };
      
      // Simulate beat progression
      let beatCount = 0;
      setInterval(() => {
        beatCount++;
        deckState[1].beat = beatCount;
        deckState[1].beatInMeasure = (beatCount % 4) + 1;
        broadcastBeat(1);
      }, 500); // ~120 BPM
      
      broadcastState();
    }, 3000);
  } else {
    connectProlink();
  }
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  if (recording) stopRecording();
  if (network) try { network.disconnect(); } catch {}
  server.close();
  process.exit(0);
});
