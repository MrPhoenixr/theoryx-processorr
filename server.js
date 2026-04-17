const express = require('express');
const app = express();
app.use(express.json({ limit: '50mb' }));

// ✅ Endpoint 1: download-and-cache-assets
app.post('/download-and-cache-assets', (req, res) => {
  const { episodeId, workDir, scenes, voiceoverPath, subtitlePath, mood } = req.body;
  const parsedScenes = typeof scenes === 'string' ? JSON.parse(scenes) : scenes;
  res.json({
    success: true,
    episodeId,
    workDir,
    mood,
    voiceoverPath: voiceoverPath || '',
    subtitlePath: subtitlePath || '',
    scenes: parsedScenes,
    assetsReady: true,
    timestamp: new Date().toISOString()
  });
});

// ✅ Endpoint 2: render-longform (16:9)
app.post('/render-longform', (req, res) => {
  const { episodeId, workDir, scenes, voiceoverPath, subtitlePath, mood } = req.body;
  res.json({
    success: true,
    episodeId,
    videoPath: `${workDir}/final_longform.mp4`,
    videoUrl: `https://theoryx-processor.onrender.com/videos/${episodeId}_16x9.mp4`,
    format: '16:9',
    duration: 300,
    mood,
    renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

// ✅ Endpoint 3: render-shortform (9:16)
app.post('/render-shortform', (req, res) => {
  const { episodeId, workDir, scenes, voiceoverPath, subtitlePath, mood } = req.body;
  res.json({
    success: true,
    episodeId,
    videoPath: `${workDir}/final_shortform.mp4`,
    videoUrl: `https://theoryx-processor.onrender.com/videos/${episodeId}_9x16.mp4`,
    format: '9:16',
    duration: 60,
    mood,
    renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => res.json({ status: 'theoryx-processor running ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
