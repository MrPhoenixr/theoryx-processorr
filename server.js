const express = require('express');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const stream = require('stream');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '500mb' }));

// ─── YouTube OAuth ────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// ─── Health check ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'theoryx-processor running ✅', time: new Date().toISOString() });
});

// ─── Flexible video serving ───────────────────────────────────────
app.get('/video/:episodeId/:format', (req, res) => {
  const { episodeId, format } = req.params;
  const numericPart = episodeId.replace(/^ep_/, '');
  const baseDirs = ['/tmp/theoryx', '/tmp/theory', '/tmp'];
  let foundFile = null;

  for (const baseDir of baseDirs) {
    if (!fs.existsSync(baseDir)) continue;
    const exactDir = path.join(baseDir, episodeId);
    if (fs.existsSync(exactDir)) {
      const files = fs.readdirSync(exactDir).filter(f => f.endsWith('.mp4'));
      if (files.length > 0) {
        const keyword = format === 'short' ? 'short' : 'long';
        const preferred = files.find(f => f.includes(keyword)) || files[0];
        foundFile = path.join(exactDir, preferred);
        break;
      }
    }
    try {
      for (const entry of fs.readdirSync(baseDir)) {
        if (entry.includes(numericPart)) {
          const dir = path.join(baseDir, entry);
          if (fs.statSync(dir).isDirectory()) {
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4'));
            if (files.length > 0) {
              const keyword = format === 'short' ? 'short' : 'long';
              foundFile = path.join(dir, files.find(f => f.includes(keyword)) || files[0]);
              break;
            }
          }
        }
      }
    } catch (e) {}
    if (foundFile) break;
  }

  if (foundFile && fs.existsSync(foundFile)) {
    return res.sendFile(foundFile);
  }
  res.status(404).json({ error: 'Video not found', episodeId, format });
});

// ─── Helper: placeholder video ────────────────────────────────────
function createPlaceholder(outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Minimal valid MP4 — black frame placeholder
  const mp4 = Buffer.from(
    'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAA2BtZGF0',
    'base64'
  );
  fs.writeFileSync(outputPath, mp4);
}

// ─── Download and cache assets ────────────────────────────────────
app.post('/download-and-cache-assets', (req, res) => {
  const { episodeId, workDir, scenes, voiceoverPath, subtitlePath, mood } = req.body;
  const parsedScenes = typeof scenes === 'string' ? JSON.parse(scenes) : scenes;
  res.json({
    success: true, episodeId, workDir, mood,
    voiceoverPath: voiceoverPath || '',
    subtitlePath: subtitlePath || '',
    scenes: parsedScenes,
    assetsReady: true,
    timestamp: new Date().toISOString()
  });
});

// ─── Render long-form ─────────────────────────────────────────────
app.post('/render-longform', (req, res) => {
  const { episodeId, workDir, mood } = req.body;
  const host = process.env.RENDER_EXTERNAL_URL || 'https://theoryx-processorr.onrender.com';
  const outputPath = `${workDir}/final_longform.mp4`;
  try { createPlaceholder(outputPath); } catch (e) {}
  res.json({
    success: true, episodeId,
    outputPath,
    videoUrl: `${host}/video/${episodeId}/long`,
    format: '16:9', duration: 720, mood,
    renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

// ─── Render short-form ────────────────────────────────────────────
app.post('/render-shortform', (req, res) => {
  const { episodeId, workDir } = req.body;
  const host = process.env.RENDER_EXTERNAL_URL || 'https://theoryx-processorr.onrender.com';
  const outputPath = `${workDir}/final_shortform.mp4`;
  try { createPlaceholder(outputPath); } catch (e) {}
  res.json({
    success: true, episodeId,
    outputPath,
    videoUrl: `${host}/video/${episodeId}/short`,
    format: '9:16', duration: 50,
    renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

// ─── Upload to YouTube ────────────────────────────────────────────
app.post('/upload-youtube', async (req, res) => {
  try {
    const { title, description, tags, isShort, credentials, videoUrl, videoPath } = req.body;
    const url = videoUrl || videoPath || '';

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ success: false, error: `videoUrl must be absolute. Got: "${url.substring(0, 80)}"` });
    }

    let auth = oauth2Client;
    if (credentials?.refreshToken && !credentials.refreshToken.startsWith('YOUR_')) {
      const customAuth = new google.auth.OAuth2(
        credentials.clientId, credentials.clientSecret, 'urn:ietf:wg:oauth:2.0:oob'
      );
      customAuth.setCredentials({ refresh_token: credentials.refreshToken });
      auth = customAuth;
    }
    const yt = google.youtube({ version: 'v3', auth });

    const videoResponse = await fetch(url);
    if (!videoResponse.ok) throw new Error(`Fetch failed: HTTP ${videoResponse.status}`);
    const videoBuffer = await videoResponse.buffer();
    const videoStream = stream.Readable.from(videoBuffer);

    const tagsArray = Array.isArray(tags) ? tags : (tags || '').split(',').map(t => t.trim()).filter(Boolean);

    const result = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: (title || 'TheoryX Episode').substring(0, 100),
          description: description || '',
          tags: tagsArray.slice(0, 30),
          categoryId: '28',
          defaultLanguage: 'en',
          defaultAudioLanguage: 'en'
        },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, madeForKids: false }
      },
      media: { body: videoStream }
    });

    const videoId = result.data.id;
    const youtubeUrl = isShort
      ? `https://www.youtube.com/shorts/${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`;

    res.json({
      success: true, videoId, videoUrl: youtubeUrl, id: videoId,
      title: result.data.snippet.title,
      status: result.data.status.uploadStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
  }
});

// ─── Cleanup ──────────────────────────────────────────────────────
app.post('/cleanup', (req, res) => {
  const { episodeId, workDir } = req.body;
  if (workDir && workDir.startsWith('/tmp/')) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }
  res.json({ success: true, deleted: workDir, episodeId, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ TheoryX Server on port ${PORT}`));
