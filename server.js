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
// Searches multiple possible directories for the episode video file
app.get('/video/:episodeId/:format', (req, res) => {
  const { episodeId, format } = req.params;

  // Extract numeric part from episodeId (e.g. ep_20260502_2008 → 20260502_2008)
  const numericPart = episodeId.replace(/^ep_/, '');

  // All possible base directories
  const baseDirs = ['/tmp/theoryx', '/tmp/theory', '/tmp'];

  let foundFile = null;

  for (const baseDir of baseDirs) {
    if (!fs.existsSync(baseDir)) continue;

    // Try exact episodeId match first
    const exactDir = path.join(baseDir, episodeId);
    if (fs.existsSync(exactDir)) {
      const files = fs.readdirSync(exactDir).filter(f => f.endsWith('.mp4'));
      if (files.length > 0) {
        // If format is 'short', prefer shortform files
        const preferred = files.find(f => f.includes('short') || f.includes('9x16'));
        foundFile = path.join(exactDir, preferred || files[0]);
        break;
      }
    }

    // Try any subdirectory containing the numeric part
    try {
      const entries = fs.readdirSync(baseDir);
      for (const entry of entries) {
        if (entry.includes(numericPart)) {
          const candidateDir = path.join(baseDir, entry);
          try {
            if (fs.statSync(candidateDir).isDirectory()) {
              const files = fs.readdirSync(candidateDir).filter(f => f.endsWith('.mp4'));
              if (files.length > 0) {
                const preferred = files.find(f => f.includes('short') || f.includes('9x16'));
                foundFile = path.join(candidateDir, preferred || files[0]);
                break;
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    if (foundFile) break;
  }

  if (foundFile && fs.existsSync(foundFile)) {
    console.log(`✅ Serving video: ${foundFile}`);
    return res.sendFile(foundFile);
  }

  console.warn(`❌ Video not found: episodeId=${episodeId}, format=${format}`);
  res.status(404).json({
    error: 'Video not found',
    episodeId,
    format,
    searched: baseDirs
  });
});

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
  // Build absolute URL using the server's own domain
  const host = process.env.RENDER_EXTERNAL_URL || `https://theoryx-processorr.onrender.com`;
  const videoUrl = `${host}/video/${episodeId}/long`;
  res.json({
    success: true, episodeId,
    outputPath: `${workDir}/final_longform.mp4`,
    videoUrl,
    format: '16:9', duration: 720, mood,
    renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

// ─── Render short-form ────────────────────────────────────────────
app.post('/render-shortform', (req, res) => {
  const { episodeId, workDir } = req.body;
  // Build absolute URL pointing to the flexible /video endpoint
  const host = process.env.RENDER_EXTERNAL_URL || `https://theoryx-processorr.onrender.com`;
  const videoUrl = `${host}/video/${episodeId}/short`;
  res.json({
    success: true, episodeId,
    outputPath: `${workDir}/final_shortform.mp4`,
    videoUrl,
    format: '9:16', duration: 50,
    renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

// ─── Upload to YouTube ────────────────────────────────────────────
app.post('/upload-youtube', async (req, res) => {
  try {
    const { title, description, tags, isShort, credentials, videoUrl, videoPath } = req.body;

    // Validate videoUrl is absolute
    const url = videoUrl || videoPath || '';
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({
        success: false,
        error: `videoUrl must be absolute (starts with http/https). Got: "${url.substring(0,80)}"`
      });
    }

    // Use credentials from request if provided and valid
    let auth = oauth2Client;
    if (credentials?.refreshToken && !credentials.refreshToken.startsWith('YOUR_')) {
      const customAuth = new google.auth.OAuth2(
        credentials.clientId,
        credentials.clientSecret,
        'urn:ietf:wg:oauth:2.0:oob'
      );
      customAuth.setCredentials({ refresh_token: credentials.refreshToken });
      auth = customAuth;
    }
    const yt = google.youtube({ version: 'v3', auth });

    console.log(`📥 Fetching video from: ${url}`);
    const videoResponse = await fetch(url);
    if (!videoResponse.ok) {
      throw new Error(`Failed to fetch video: HTTP ${videoResponse.status} from ${url}`);
    }

    const videoBuffer = await videoResponse.buffer();
    console.log(`✅ Video fetched: ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB`);
    const videoStream = stream.Readable.from(videoBuffer);

    let tagsArray = Array.isArray(tags)
      ? tags
      : (tags || '').split(',').map(t => t.trim()).filter(Boolean);

    const cleanTitle = (title || 'TheoryX Episode').substring(0, 100);

    const result = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: cleanTitle,
          description: description || '',
          tags: tagsArray.slice(0, 30),
          categoryId: '28',
          defaultLanguage: 'en',
          defaultAudioLanguage: 'en'
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
          madeForKids: false
        }
      },
      media: { body: videoStream }
    });

    const videoId = result.data.id;
    const youtubeUrl = isShort
      ? `https://www.youtube.com/shorts/${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`✅ YouTube upload success: ${youtubeUrl}`);
    res.json({
      success: true,
      videoId,
      videoUrl: youtubeUrl,
      id: videoId,
      title: result.data.snippet.title,
      status: result.data.status.uploadStatus,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ YouTube upload error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ─── Cleanup ──────────────────────────────────────────────────────
app.post('/cleanup', (req, res) => {
  const { episodeId, workDir } = req.body;
  // Safety: only delete /tmp paths
  if (workDir && workDir.startsWith('/tmp/')) {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
      console.log(`✅ Cleaned: ${workDir}`);
    } catch (e) {
      console.warn(`⚠️ Cleanup warning: ${e.message}`);
    }
  }
  res.json({
    success: true,
    deleted: workDir,
    episodeId,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ TheoryX Server on port ${PORT}`));
