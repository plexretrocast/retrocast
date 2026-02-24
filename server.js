/**
 * RetroCast Server
 * Run: node server.js
 * Open: http://localhost:3000
 */

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { spawn, execSync } = require('child_process');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');
const DATA = process.env.DATA_FILE || '/data/retrocast-data.json';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.get('/favicon.ico', (req,res) => res.status(204).end());

// Ensure data directory exists on first run
const dataDir = path.dirname(DATA);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── Data persistence ──────────────────────────────────────────────────────────
function load() {
  try { if (fs.existsSync(DATA)) return JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch(e) { console.error('Read error:', e.message); }
  return { config:{}, channels:[], guide:{} };
}
function save(d) { fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); }

app.get   ('/api/state',    (req,res) => res.json(load()));
app.post  ('/api/config',   (req,res) => { const d=load(); d.config={...d.config,...req.body}; save(d); res.json({ok:true}); });
app.post  ('/api/channels', (req,res) => { const d=load(); d.channels=req.body.channels; save(d); res.json({ok:true}); });
app.post  ('/api/guide',    (req,res) => { const d=load(); d.guide=req.body.guide; d.guideBuiltAt=Date.now(); save(d); res.json({ok:true}); });
app.delete('/api/state',    (req,res) => { save({config:{},channels:[],guide:{}}); res.json({ok:true}); });

// ── FFmpeg check + GPU detection ─────────────────────────────────────────────
// Set ENCODER env var to choose encoder:
//   auto   → test in order: nvidia → amd → intel → cpu  (default)
//   nvidia → force NVIDIA NVENC  (skips test — needed for Docker/WSL2)
//   intel  → force Intel QSV
//   amd    → force AMD AMF
//   cpu    → force software x264

let ffmpegAvailable = false;
let videoEncoder = 'libx264'; // fallback
let encoderType  = 'CPU (software)';

const ENCODER_PREF = (process.env.ENCODER || 'auto').toLowerCase();

const ALL_ENCODERS = [
  { key: 'nvidia', enc: 'h264_nvenc', type: 'NVIDIA NVENC', test: '-f lavfi -i nullsrc=s=128x128 -t 0.1 -c:v h264_nvenc -f null -' },
  { key: 'amd',    enc: 'h264_amf',   type: 'AMD AMF',      test: '-f lavfi -i nullsrc=s=128x128 -t 0.1 -c:v h264_amf   -f null -' },
  { key: 'intel',  enc: 'h264_qsv',   type: 'Intel QSV',    test: '-f lavfi -i nullsrc=s=128x128 -t 0.1 -c:v h264_qsv   -f null -' },
  { key: 'cpu',    enc: 'libx264',     type: 'CPU (software)', test: '-f lavfi -i nullsrc=s=128x128 -t 0.1 -c:v libx264   -f null -' },
];

try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  ffmpegAvailable = true;

  if (ENCODER_PREF !== 'auto') {
    // Forced encoder — trust the env var and skip the startup test.
    // The test can fail in some container runtimes (e.g. NVIDIA on Windows/WSL2)
    // even when the encoder works perfectly fine at transcode time.
    const forced = ALL_ENCODERS.find(e => e.key === ENCODER_PREF);
    if (forced) {
      videoEncoder = forced.enc;
      encoderType  = forced.type;
    } else {
      console.warn(`Unknown ENCODER value "${ENCODER_PREF}" — falling back to CPU`);
    }
  } else {
    // Auto mode — test each encoder in order, use first that works
    for (const g of ALL_ENCODERS) {
      try {
        execSync(`ffmpeg -hide_banner -loglevel error ${g.test}`, { stdio: 'ignore' });
        videoEncoder = g.enc;
        encoderType  = g.type;
        break;
      } catch(e) {}
    }
  }
} catch(e) {}

if (!ffmpegAvailable) {
  console.log('Encoder: ffmpeg NOT FOUND — transcoding disabled');
} else {
  console.log(`Encoder: ${encoderType} (${videoEncoder})${ENCODER_PREF !== 'auto' ? ' — forced, skipping startup test' : ' — auto-detected'}`);
}
console.log(`Encoder mode: ${ENCODER_PREF === 'auto' ? 'auto-detect' : `forced → ${ENCODER_PREF}`}`);
app.get('/api/ffmpeg-available', (req,res) => res.json({available: ffmpegAvailable}));

// ── HLS Session Manager ───────────────────────────────────────────────────────
// Writes HLS segments to temp dir and serves them.
// HLS works universally: Chrome (via HLS.js), Safari native, WebOS native, iOS native.

const sessions = {};

function killSession(id) {
  const s = sessions[id];
  if (!s) return;
  clearTimeout(s.expiry);
  try { s.proc.kill('SIGKILL'); } catch(e) {}
  try { fs.rmSync(s.dir, { recursive:true, force:true }); } catch(e) {}
  delete sessions[id];
  console.log(`[HLS] killed session ${id}`);
}

// Start a new HLS transcode session
app.get('/api/stream', (req, res) => {
  const { url, seek } = req.query;
  if (!url) return res.status(400).json({error:'Missing url'});
  if (!ffmpegAvailable) return res.status(503).json({error:'ffmpeg not available'});

  const seekSec = parseFloat(seek) || 0;
  const src     = decodeURIComponent(url);
  const id      = Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  const dir     = path.join(os.tmpdir(), `rc_${id}`);

  fs.mkdirSync(dir, { recursive: true });
  console.log(`[HLS] start id=${id} seek=${seekSec}s src=${path.basename(src.split('?')[0])}`);

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt', '-ignore_unknown',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
  ];

  if (seekSec > 0) args.push('-ss', String(seekSec));
  args.push('-i', src);
  args.push('-avoid_negative_ts', 'make_zero');
  // Map only first video and audio, ignore subtitles/data/attachments
  args.push('-map', '0:v:0', '-map', '0:a:0');

  // Normalize VFR to CFR — prevents freezes with AVI/older containers
  args.push('-vf', 'fps=fps=24000/1001');

  // Build encoder args based on selected GPU/CPU
  const encArgs = videoEncoder === 'h264_nvenc' ? [
    '-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr',
    '-cq', '23', '-profile:v', 'high', '-level', '5.1',
    '-pix_fmt', 'yuv420p',
  ] : videoEncoder === 'h264_amf' ? [
    '-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'vbr_peak',
    '-qp_i', '23', '-qp_p', '23', '-profile:v', 'high', '-level', '5.1',
    '-pix_fmt', 'yuv420p',
  ] : videoEncoder === 'h264_qsv' ? [
    '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23',
    '-profile:v', 'high', '-level', '5.1',
    '-pix_fmt', 'nv12',  // QSV native format — avoids auto-conversion stall
  ] : [
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-profile:v', 'high', '-level', '5.1', '-pix_fmt', 'yuv420p',
  ];

  args.push(
    ...encArgs,
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-dn', '-sn',
    '-f', 'hls',
    '-hls_time', '3',
    '-hls_list_size', '0',       // keep ALL segments — prevents 404 if client lags
    '-hls_flags', 'append_list+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'stream.m3u8')
  );

  const proc = spawn('ffmpeg', args);

  proc.stderr.on('data', d => {
    const m = d.toString().trim();
    if (m && !m.includes('pgssub') && !m.includes('Could not find codec') &&
        !m.includes('non monotonous') && !m.includes('out of order') &&
        !m.includes('auto-selecting format') && !m.includes('Incompatible pixel format')) {
      console.error(`[ffmpeg:${id}]`, m.slice(0,120));
    }
  });

  proc.on('close', code => {
    if (code && code !== 255) console.log(`[HLS] ffmpeg exit ${code} session ${id}`);
  });

  const expiry = setTimeout(() => killSession(id), 6 * 3600 * 1000);
  sessions[id] = { proc, dir, expiry };

  // Poll for playlist (up to 12s)
  const playlist = path.join(dir, 'stream.m3u8');
  let waited = 0;
  const poll = setInterval(() => {
    waited += 200;
    if (fs.existsSync(playlist) && fs.statSync(playlist).size > 0) {
      clearInterval(poll);
      res.json({ id, m3u8: `/api/hls/${id}/stream.m3u8` });
    } else if (waited > 12000) {
      clearInterval(poll);
      killSession(id);
      res.status(504).json({ error: 'Timeout waiting for stream' });
    }
  }, 200);
});

// Stop a session
app.post('/api/stream/stop', (req, res) => {
  killSession(req.body?.id);
  res.json({ ok: true });
});

// Serve HLS playlist + segments
app.get('/api/hls/:id/:file', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).send('Session gone');

  // Reset expiry on activity
  clearTimeout(s.expiry);
  s.expiry = setTimeout(() => killSession(req.params.id), 6 * 3600 * 1000);

  const file = path.basename(req.params.file);
  const fp   = path.join(s.dir, file);

  if (file.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store');
  } else {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=60');
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Retry up to 3s for segments still being written
  let tries = 0;
  const serve = () => {
    if (fs.existsSync(fp)) return res.sendFile(fp);
    if (++tries < 15) return setTimeout(serve, 200);
    res.status(404).send('Segment not ready');
  };
  serve();
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  let ip = 'localhost';
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family==='IPv4' && !i.internal) { ip=i.address; break; }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         RETROCAST SERVER RUNNING         ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}           ║`);
  console.log(`║  Network: http://${ip}:${PORT}        ║`);
  console.log('╚══════════════════════════════════════════╝\n');
  console.log('Data file:', DATA);
  console.log('FFmpeg:', ffmpegAvailable ? '✓ found — HLS transcoding enabled' : '✗ NOT FOUND');
  console.log('\nPress Ctrl+C to stop.\n');
});
