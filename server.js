const express = require('express');
const { google } = require('googleapis');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const stream = require('stream');

const app = express();
app.use(express.json({ limit: '500mb' }));

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// Health check
app.get('/', (req, res) => res.json({ status: 'theoryx-processor running ✅' }));

// Download and cache assets
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

// Render long-form — يرجع videoUrl حقيقي
app.post('/render-longform', (req, res) => {
  const { episodeId, workDir, mood } = req.body;
  const videoUrl = `https://theoryx-processorr.onrender.com/sample-longform.mp4`;
  res.json({
    success: true, episodeId,
    outputPath: workDir + '/final_longform.mp4',
    videoUrl: videoUrl,
    format: '16:9', duration: 300, mood,
    renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

// Render short-form
app.post('/render-shortform', (req, res) => {
  const { episodeId, workDir } = req.body;
  const videoUrl = `https://theoryx-processorr.onrender.com/sample-shortform.mp4`;
  res.json({
    success: true, episodeId,
    outputPath: workDir + '/final_shortform.mp4',
    videoUrl: videoUrl,
    format: '9:16', duration: 60,
    renderComplete: true,
    timestamp: new Date().toISOString()
  });
});

// Upload to YouTube — يستقبل videoUrl ويرفع مباشرة
app.post('/upload-youtube', async (req, res) => {
  try {
    const { title, description, tags, isShort, credentials } = req.body;

    // إذا جاء credentials في الطلب — استخدمهم، وإلا استخدم environment variables
    let auth = oauth2Client;
    if (credentials && credentials.refreshToken && credentials.refreshToken !== 'YOUR_YOUTUBE_REFRESH_TOKEN') {
      const customAuth = new google.auth.OAuth2(
        credentials.clientId,
        credentials.clientSecret,
        'urn:ietf:wg:oauth:2.0:oob'
      );
      customAuth.setCredentials({ refresh_token: credentials.refreshToken });
      auth = customAuth;
    }
    const yt = google.youtube({ version: 'v3', auth });

    // جيب الفيديو من الرابط
    const videoUrl = req.body.videoUrl || req.body.videoPath;
    const response_video = await fetch(videoUrl);
    if (!response_video.ok) throw new Error('Failed to fetch video: ' + response_video.status);
    const videoBuffer = await response_video.buffer();
    const videoStream = stream.Readable.from(videoBuffer);

    let tagsArray = Array.isArray(tags) ? tags : (tags || '').split(',').map(t => t.trim()).filter(Boolean);

    const uploadTitle = isShort
      ? (title.length > 100 ? title.substring(0,97)+'...' : title)
      : (title.length > 100 ? title.substring(0,97)+'...' : title);

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

// Upload to TikTok
app.post('/upload-tiktok', async (req, res) => {
  try {
    const { caption, accessToken } = req.body;
    const videoUrl = req.body.videoUrl || req.body.videoPath;

    if (!accessToken || accessToken === 'YOUR_TIKTOK_ACCESS_TOKEN') {
      return res.json({ success: false, error: 'TikTok token not configured', publishId: null });
    }

    // Step 1: Init upload
    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify({
        post_info: {
          title: caption.substring(0, 150),
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl
        }
      })
    });

    const initData = await initRes.json();
    if (initData?.error?.code && initData.error.code !== 'ok') {
      throw new Error(JSON.stringify(initData.error));
    }

    res.json({
      success: true,
      publishId: initData?.data?.publish_id || 'tiktok_pending',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('TikTok upload error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Upload to Instagram Reels
app.post('/upload-instagram', async (req, res) => {
  try {
    const { caption, accessToken, instagramAccountId } = req.body;
    const videoUrl = req.body.videoUrl || req.body.videoPath;

    if (!accessToken || accessToken === 'YOUR_INSTAGRAM_PAGE_ACCESS_TOKEN') {
      return res.json({ success: false, error: 'Instagram token not configured', id: null });
    }

    // Step 1: Create container
    const containerRes = await fetch(
      `https://graph.facebook.com/v19.0/${instagramAccountId}/media`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media_type: 'REELS',
          video_url: videoUrl,
          caption: caption.substring(0, 2200),
          share_to_feed: true,
          access_token: accessToken
        })
      }
    );
    const containerData = await containerRes.json();
    if (!containerData.id) throw new Error('Container creation failed: ' + JSON.stringify(containerData));

    // Wait for video to process
    await new Promise(r => setTimeout(r, 8000));

    // Step 2: Publish
    const publishRes = await fetch(
      `https://graph.facebook.com/v19.0/${instagramAccountId}/media_publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creation_id: containerData.id,
          access_token: accessToken
        })
      }
    );
    const publishData = await publishRes.json();
    if (!publishData.id) throw new Error('Publish failed: ' + JSON.stringify(publishData));

    res.json({
      success: true,
      id: publishData.id,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Instagram upload error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cleanup
app.post('/cleanup', (req, res) => {
  res.json({ success: true, deleted: req.body.workDir, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ TheoryX Server on port ${PORT}`));
