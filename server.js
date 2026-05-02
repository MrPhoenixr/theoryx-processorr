const express = require('express');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const stream = require('stream');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '500mb' }));

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

app.get('/', (req, res) => res.json({ status: 'theoryx-processor running ✅' }));

// ✅ نقطة نهاية مرنة للبحث عن الفيديو في مسارات متعددة
app.get('/video/:episodeId/:format', (req, res) => {
  const { episodeId, format } = req.params;
  
  // تحويل format إلى صيغة اسم الملف (ممكن يكون shortform أو shortForm)
  const formatVariants = [format, format.charAt(0).toUpperCase() + format.slice(1)];
  
  const possiblePaths = [
    // المسارات السابقة
    `/tmp/theoryx/${episodeId}/final_${format}.mp4`,
    `/tmp/theory/${episodeId}/final_${format}.mp4`,
    // المسار الجديد مع مجلد video وأسماء ملفات مختلفة
    `/tmp/theory/video/${episodeId}/final${formatVariants[1]}.mp4`,
    `/tmp/theory/video/${episodeId}/final_${format}.mp4`,
    `/tmp/theory/video/${episodeId}/final_${formatVariants[1]}.mp4`,
    // محاولة عامة: البحث عن أي ملف mp4 داخل المجلد (أقل دقة لكن كحل أخير)
    `/tmp/theory/${episodeId}/*.mp4`,
    `/tmp/theory/video/${episodeId}/*.mp4`
  ];
  
  for (const filePath of possiblePaths) {
    if (filePath.includes('*')) {
      // إذا كان المسار يحتوي على wildcard، نبحث عن أول ملف mp4
      const dir = path.dirname(filePath);
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4'));
        if (files.length > 0) {
          return res.sendFile(path.join(dir, files[0]));
        }
      }
    } else if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
  }
  
  res.status(404).json({ error: 'Video not found', searchedPaths: possiblePaths });
});

// باقي endpoints كما هي (download-and-cache-assets, render-longform, render-shortform, upload-youtube, cleanup)
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

app.post('/render-longform', (req, res) => {
  const { episodeId, workDir, mood } = req.body;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const videoUrl = `${baseUrl}/video/${episodeId}/longform`;
  res.json({
    success: true, episodeId,
    outputPath: `${workDir}/final_longform.mp4`,
    videoUrl: videoUrl,
    format: '16:9', duration: 300, mood,
    renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

app.post('/render-shortform', (req, res) => {
  const { episodeId, workDir } = req.body;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const videoUrl = `${baseUrl}/video/${episodeId}/shortform`;
  res.json({
    success: true, episodeId,
    outputPath: `${workDir}/final_shortform.mp4`,
    videoUrl: videoUrl,
    format: '9:16', duration: 60,
    renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

app.post('/upload-youtube', async (req, res) => {
  try {
    const { title, description, tags, isShort, credentials } = req.body;

    let auth = oauth2Client;
    if (credentials?.refreshToken && credentials.refreshToken !== 'YOUR_YOUTUBE_REFRESH_TOKEN') {
      const customAuth = new google.auth.OAuth2(
        credentials.clientId,
        credentials.clientSecret,
        'urn:ietf:wg:oauth:2.0:oob'
      );
      customAuth.setCredentials({ refresh_token: credentials.refreshToken });
      auth = customAuth;
    }
    const yt = google.youtube({ version: 'v3', auth });

    const videoUrl = req.body.videoUrl || req.body.videoPath;
    const response_video = await fetch(videoUrl);
    if (!response_video.ok) throw new Error(`Failed to fetch video: ${response_video.status}`);
    const videoBuffer = await response_video.buffer();
    const videoStream = stream.Readable.from(videoBuffer);

    let tagsArray = Array.isArray(tags) ? tags : (tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const uploadTitle = title.length > 100 ? title.substring(0,97)+'...' : title;

    const result = await yt.videos.insert({
      part: ['snippet','status'],
      requestBody: {
        snippet: {
          title: uploadTitle,
          description: description || '',
          tags: tagsArray.slice(0,30),
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
    console.error('YouTube upload error:', error.message);
    res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
  }
});

app.post('/cleanup', (req, res) => {
  res.json({ success: true, deleted: req.body.workDir, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ TheoryX Server on port ${PORT}`));
