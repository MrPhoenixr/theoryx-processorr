const express = require('express');
const app = express();
app.use(express.json({ limit: '50mb' }));

// Health check — keep-alive ping
app.get('/', (req, res) => {
  res.json({ status: 'theoryx-processor running ✅', time: new Date().toISOString() });
});

// Endpoint 1 — download-and-cache-assets
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

// Endpoint 2 — render-longform
app.post('/render-longform', (req, res) => {
  const { episodeId, workDir, mood } = req.body;
  res.json({
    success: true, episodeId,
    outputPath: `${workDir}/final_video.mp4`,
    videoUrl: `https://theoryx-processor.onrender.com/videos/${episodeId}.mp4`,
    duration: 720, mood, renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

// Endpoint 3 — render-shortform (مطلوب للـ shorts)
app.post('/render-shortform', (req, res) => {
  const { episodeId, workDir } = req.body;
  res.json({
    success: true, episodeId,
    outputPath: `${workDir}/short_final.mp4`,
    videoUrl: `https://theoryx-processor.onrender.com/videos/${episodeId}_short.mp4`,
    duration: 50, renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

// Endpoint 4 — cleanup
app.post('/cleanup', (req, res) => {
  const { episodeId, workDir } = req.body;
  res.json({ success: true, episodeId, deleted: workDir, timestamp: new Date().toISOString() });
});

// Upload stubs — يستقبل الطلب ويرجع success
app.post('/upload-youtube', (req, res) => {
  res.json({ success: true, videoId: `yt_${req.body.episodeId || Date.now()}`, id: `yt_stub` });
});
app.post('/upload-tiktok', (req, res) => {
  res.json({ success: true, publishId: `tt_${Date.now()}` });
});
app.post('/upload-instagram', (req, res) => {
  res.json({ success: true, id: `ig_${Date.now()}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ TheoryX Server on port ${PORT}`));
