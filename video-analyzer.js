/**
 * Video Analyzer — Server-side pipeline for YouTube video analysis.
 * Uses yt-dlp + ffmpeg + OpenAI to extract metadata, transcript, frames, and AI analysis.
 * Results stored locally as temp files, then uploaded to R2 + Dropbox for persistence.
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cloud = require('./cloud-storage');

const VIDEO_DATA_DIR = path.join(__dirname, 'video_data');

// Base yt-dlp args: use node JS runtime + EJS challenge solver
const YTDLP_BASE = ['--js-runtimes', 'node', '--remote-components', 'ejs:github'];

// In-memory job tracking
const jobs = new Map(); // videoId → {status, progress, error, startedAt, title, openaiModel}

// Debounce R2 job state saves (batch every 5s)
const pendingJobSaves = new Map(); // videoId → timeout
function debouncedSaveJob(videoId) {
    if (!cloud.isR2Ready()) return;
    if (pendingJobSaves.has(videoId)) clearTimeout(pendingJobSaves.get(videoId));
    pendingJobSaves.set(videoId, setTimeout(async () => {
        pendingJobSaves.delete(videoId);
        const job = jobs.get(videoId);
        if (job) {
            try { await cloud.saveJobState(videoId, { videoId, ...job }); }
            catch (e) { console.warn(`R2: Failed to save job state for ${videoId}:`, e.message); }
        }
    }, 5000));
}

// Force-flush a job state to R2 (no debounce)
async function flushJobState(videoId) {
    if (!cloud.isR2Ready()) return;
    if (pendingJobSaves.has(videoId)) {
        clearTimeout(pendingJobSaves.get(videoId));
        pendingJobSaves.delete(videoId);
    }
    const job = jobs.get(videoId);
    if (job) {
        try { await cloud.saveJobState(videoId, { videoId, ...job }); }
        catch (e) { console.warn(`R2: Failed to flush job state for ${videoId}:`, e.message); }
    }
}

// Parse YouTube video ID from various URL formats
function parseVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

function updateJob(videoId, updates) {
    const job = jobs.get(videoId) || { status: 'queued', progress: 0, error: null, startedAt: Date.now() };
    Object.assign(job, updates);
    jobs.set(videoId, job);
    debouncedSaveJob(videoId);
}

// Run a command and return stdout
function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, timeout: 300000, ...opts }, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                reject(err);
            } else {
                resolve(stdout);
            }
        });
    });
}

// Parse json3 subtitle format into {fullText, words}
function parseJson3Captions(json3Data) {
    try {
        const data = JSON.parse(json3Data);
        const events = data.events || [];
        const words = [];
        const textParts = [];

        for (const event of events) {
            if (!event.segs) continue;
            const startMs = event.tStartMs || 0;
            for (const seg of event.segs) {
                const word = (seg.utf8 || '').replace(/\n/g, ' ').trim();
                if (!word) continue;
                const offsetMs = seg.tOffsetMs || 0;
                words.push({
                    word,
                    timestamp: Math.round((startMs + offsetMs) / 1000 * 10) / 10
                });
                textParts.push(word);
            }
        }

        return { fullText: textParts.join(' '), words };
    } catch (e) {
        return { fullText: '', words: [] };
    }
}

// OpenAI chat completion (direct fetch, server-side)
async function openaiChat(apiKey, messages, maxTokens, model) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model || 'gpt-4o',
            messages,
            max_tokens: maxTokens,
            temperature: 0.3
        })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.choices[0].message.content;
}

// OpenAI vision analysis for a frame
async function analyzeFrame(apiKey, model, framePath, timestamp, duration, segmentTranscript, fullTranscript) {
    const imageBuffer = fs.readFileSync(framePath);
    const base64 = imageBuffer.toString('base64');
    const prompt = `Analyze this video frame at ${timestamp}s of a ${duration}s video.

What's being said right now: "${segmentTranscript}"
Full transcript: "${fullTranscript.slice(0, 2000)}"

Return JSON only:
{
  "sceneDescription": "What's happening, subjects, composition",
  "visualTechniques": "Colors, lighting, text overlays, movement, effects",
  "cinematography": "Camera angle, shot type, focus, depth of field",
  "engagementAnalysis": "Attention hooks, psychological triggers, emotional impact",
  "keyInsights": ["What makes this effective", "Replicable patterns"],
  "accessibilityNotes": "Text readability, visual clarity",
  "retentionAnalysis": "Why viewers stay or leave at this point"
}`;

    const content = await openaiChat(apiKey, [
        { role: 'system', content: 'You are an expert video analyst. Return valid JSON only, no markdown fences.' },
        { role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' } }
        ]}
    ], 500, model);

    try {
        const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        return { sceneDescription: content, visualTechniques: '', cinematography: '', engagementAnalysis: '', keyInsights: [], accessibilityNotes: '', retentionAnalysis: '' };
    }
}

// Get transcript segment around a timestamp
function getTranscriptSegment(words, timestamp, windowSec = 3) {
    return words
        .filter(w => Math.abs(w.timestamp - timestamp) <= windowSec)
        .map(w => w.word)
        .join(' ');
}

// Upload all frames from local dir to R2
async function uploadFramesToR2(videoId, framesDir) {
    if (!cloud.isR2Ready()) return;
    const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
    console.log(`R2: Uploading ${files.length} frames for ${videoId}...`);
    for (const file of files) {
        const buf = fs.readFileSync(path.join(framesDir, file));
        await cloud.uploadToR2(`videos/${videoId}/frames/${file}`, buf, 'image/jpeg');
    }
    console.log(`R2: Frames uploaded for ${videoId}`);
}

// Upload video to Dropbox
async function uploadVideoToDropbox(videoPath, title) {
    const sanitized = cloud.sanitizeTitle(title);
    const folderPath = `/Final Videos/${sanitized}`;
    const dropboxPath = `${folderPath}/video.mp4`;
    console.log(`Dropbox: Uploading video to ${dropboxPath}...`);

    // Create folder first
    await cloud.createDropboxFolder(folderPath);

    // Use large upload for safety (handles any file size)
    await cloud.uploadLargeToDropbox(dropboxPath, videoPath);
    console.log(`Dropbox: Video uploaded to ${dropboxPath}`);
}

// Main analysis pipeline
async function startAnalysis(url, openaiKey, chatModel) {
    const videoId = parseVideoId(url);
    if (!videoId) throw new Error('Invalid YouTube URL');

    // Check if already running
    const existing = jobs.get(videoId);
    if (existing && ['queued', 'downloading', 'extracting_frames', 'transcribing', 'summarizing', 'analyzing_frames'].includes(existing.status)) {
        return { jobId: videoId, status: existing.status };
    }

    updateJob(videoId, { status: 'queued', progress: 0, error: null, startedAt: Date.now(), url, openaiModel: chatModel });

    // Run pipeline async
    (async () => {
        const dir = path.join(VIDEO_DATA_DIR, videoId);
        const framesDir = path.join(dir, 'frames');
        const videoPath = path.join(dir, 'video.mp4');

        try {
            // Step 1: Create directories
            fs.mkdirSync(framesDir, { recursive: true });

            // Step 2: Download metadata
            updateJob(videoId, { status: 'downloading', progress: 5 });
            const metaJson = await run('yt-dlp', [...YTDLP_BASE, '--dump-json', '--no-download', `https://www.youtube.com/watch?v=${videoId}`]);
            const meta = JSON.parse(metaJson);
            const isVertical = (meta.height || 0) > (meta.width || 1);
            const metadata = {
                title: meta.title || '',
                duration: meta.duration || 0,
                viewCount: meta.view_count || 0,
                likeCount: meta.like_count || 0,
                commentCount: meta.comment_count || 0,
                uploadDate: meta.upload_date || '',
                description: (meta.description || '').slice(0, 2000),
                isVertical,
                width: meta.width || 0,
                height: meta.height || 0
            };

            // Step 3: Save job state with title
            updateJob(videoId, { progress: 15, title: metadata.title });
            await flushJobState(videoId);

            // Step 4: Download captions
            updateJob(videoId, { status: 'transcribing', progress: 20 });
            let transcript = { fullText: '', words: [] };
            try {
                const subDir = path.join(dir, 'subs');
                fs.mkdirSync(subDir, { recursive: true });
                await run('yt-dlp', [
                    ...YTDLP_BASE,
                    '--write-auto-sub', '--sub-lang', 'en', '--sub-format', 'json3',
                    '--skip-download', '-o', path.join(subDir, '%(id)s'),
                    `https://www.youtube.com/watch?v=${videoId}`
                ]);
                const subFiles = fs.readdirSync(subDir).filter(f => f.endsWith('.json3'));
                if (subFiles.length > 0) {
                    const subContent = fs.readFileSync(path.join(subDir, subFiles[0]), 'utf8');
                    transcript = parseJson3Captions(subContent);
                }
                fs.rmSync(subDir, { recursive: true, force: true });
            } catch (e) {
                console.warn('Caption download failed (video may not have captions):', e.message);
            }

            // Step 5: Download video
            updateJob(videoId, { status: 'downloading', progress: 30 });
            await run('yt-dlp', [
                ...YTDLP_BASE,
                '-f', 'best[height<=720]/best',
                '-o', videoPath,
                `https://www.youtube.com/watch?v=${videoId}`
            ], { timeout: 600000 });

            // Step 6: Extract frames — 1 per second
            updateJob(videoId, { status: 'extracting_frames', progress: 50 });
            await run('ffmpeg', [
                '-i', videoPath, '-vf', 'fps=1', '-q:v', '2',
                path.join(framesDir, 'frame_%04d.jpg')
            ], { timeout: 600000 });

            // Step 6b: Upload frames to R2
            try {
                await uploadFramesToR2(videoId, framesDir);
            } catch (e) {
                console.warn(`R2 frame upload failed (frames still on local disk): ${e.message}`);
            }

            // Get frame list
            const frameFiles = fs.readdirSync(framesDir)
                .filter(f => f.endsWith('.jpg'))
                .sort();

            const frames = frameFiles.map((f, i) => ({
                index: i,
                timestamp: i, // 1 frame per second
                filename: f,
                analysis: null
            }));

            // Step 8: AI Summary
            updateJob(videoId, { status: 'summarizing', progress: 60 });

            let summary = '';
            let videoIdea = '';
            let segments = [];

            if (openaiKey && transcript.fullText) {
                try {
                    summary = await openaiChat(openaiKey, [
                        { role: 'system', content: 'You are an expert video content analyst.' },
                        { role: 'user', content: `Summarize this video transcript in 2-3 paragraphs. Focus on the key message, structure, and techniques used:\n\n${transcript.fullText.slice(0, 4000)}` }
                    ], 300, chatModel);
                } catch (e) { console.warn('Summary failed:', e.message); }

                try {
                    videoIdea = await openaiChat(openaiKey, [
                        { role: 'system', content: 'You are an expert at distilling video concepts into concise ideas.' },
                        { role: 'user', content: `Based on this transcript, write a single 5-10 word sentence that captures the core video idea/concept. Return ONLY the sentence, nothing else.\n\n${transcript.fullText.slice(0, 3000)}` }
                    ], 50, chatModel);
                } catch (e) { console.warn('Video idea failed:', e.message); }

                try {
                    const segJson = await openaiChat(openaiKey, [
                        { role: 'system', content: 'You are an expert video content analyst. Return valid JSON only.' },
                        { role: 'user', content: `Analyze this transcript and break it into 3-7 logical segments. For each segment, identify the label (e.g. "Hook", "Setup", "Main Point", "Call to Action"), description, approximate start/end times, and the transcript portion.

Video duration: ${metadata.duration}s
Transcript: ${transcript.fullText.slice(0, 4000)}

Return JSON array:
[{"label":"...","description":"...","startTime":0,"endTime":10,"transcript":"..."}]` }
                    ], 900, chatModel);
                    const cleaned = segJson.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                    segments = JSON.parse(cleaned);
                    if (!Array.isArray(segments)) segments = [];
                } catch (e) { console.warn('Segments failed:', e.message); }
            }

            // Step 8b: Upload video to Dropbox (after AI summary so we can use videoIdea for folder name)
            let dropboxPath = null;
            let dropboxUploadOk = false;
            try {
                const folderName = videoIdea.trim() || metadata.title;
                await uploadVideoToDropbox(videoPath, folderName);
                const sanitized = cloud.sanitizeTitle(folderName);
                dropboxPath = `/Final Videos/${sanitized}/video.mp4`;
                dropboxUploadOk = true;
                console.log(`Dropbox: SUCCESS — video uploaded to ${dropboxPath}`);
            } catch (e) {
                console.error(`Dropbox: FAILED — video NOT uploaded, keeping local file. Error: ${e.message}`);
            }

            // Step 8c: Delete local video to save disk — ONLY if Dropbox upload succeeded
            if (dropboxUploadOk) {
                try { fs.unlinkSync(videoPath); console.log('Local video deleted (safe in Dropbox)'); } catch (e) {}
            } else {
                console.warn('Local video kept on disk — Dropbox upload did not succeed');
            }

            // Step 9: Frame analysis
            updateJob(videoId, { status: 'analyzing_frames', progress: 70 });

            if (openaiKey && frames.length > 0) {
                for (let i = 0; i < frames.length; i++) {
                    const frame = frames[i];
                    const framePath = path.join(framesDir, frame.filename);
                    const segTranscript = getTranscriptSegment(transcript.words, frame.timestamp);

                    try {
                        frame.analysis = await analyzeFrame(
                            openaiKey, chatModel, framePath,
                            frame.timestamp, metadata.duration,
                            segTranscript, transcript.fullText
                        );
                    } catch (e) {
                        console.warn(`Frame ${frame.filename} analysis failed:`, e.message);
                        frame.analysis = { sceneDescription: 'Analysis failed', error: e.message };
                    }

                    updateJob(videoId, { progress: 70 + Math.round((i / frames.length) * 25) });
                }
            }

            // Step 10: Write analysis.json
            const analysis = {
                videoId,
                url: `https://www.youtube.com/watch?v=${videoId}`,
                analyzedAt: new Date().toISOString(),
                dropboxPath,
                metadata,
                transcript,
                aiAnalysis: { videoIdea: videoIdea.trim(), summary, segments },
                frames,
                analytics: {
                    avgRetention: null,
                    retentionVariation: null,
                    avgPercentViewed: null,
                    swipeRatio: null,
                    retentionCurve: []
                }
            };

            fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(analysis, null, 2));

            // Step 10b: Upload analysis.json to R2
            try {
                await cloud.uploadToR2(
                    `videos/${videoId}/analysis.json`,
                    Buffer.from(JSON.stringify(analysis)),
                    'application/json'
                );
                console.log(`R2: analysis.json uploaded for ${videoId}`);
            } catch (e) {
                console.warn(`R2: Failed to upload analysis.json for ${videoId}:`, e.message);
            }

            updateJob(videoId, { status: 'complete', progress: 100 });
            await flushJobState(videoId);

        } catch (e) {
            console.error('Video analysis failed:', e);
            updateJob(videoId, { status: 'error', error: e.message });
            await flushJobState(videoId);
        }
    })();

    return { jobId: videoId, status: 'queued' };
}

function getStatus(videoId) {
    return jobs.get(videoId) || null;
}

async function getAnalysis(videoId) {
    // Try local first
    const filePath = path.join(VIDEO_DATA_DIR, videoId, 'analysis.json');
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    // Fall back to R2
    if (cloud.isR2Ready()) {
        try {
            const buf = await cloud.downloadFromR2(`videos/${videoId}/analysis.json`);
            if (buf) {
                // Cache locally for this session
                const dir = path.join(VIDEO_DATA_DIR, videoId);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(filePath, buf);
                return JSON.parse(buf.toString('utf8'));
            }
        } catch (e) {
            console.warn(`R2: Failed to download analysis for ${videoId}:`, e.message);
        }
    }

    return null;
}

function getFramePath(videoId, filename) {
    const safe = path.basename(filename);
    const filePath = path.join(VIDEO_DATA_DIR, videoId, 'frames', safe);
    if (fs.existsSync(filePath)) return filePath;
    return null; // server.js will proxy from R2
}

// Get R2 signed URL for a frame (used by server.js when local file doesn't exist)
async function getFrameR2Url(videoId, filename) {
    if (!cloud.isR2Ready()) return null;
    const safe = path.basename(filename);
    const key = `videos/${videoId}/frames/${safe}`;
    if (await cloud.existsInR2(key)) {
        return cloud.getR2SignedUrl(key);
    }
    return null;
}

// Transcribe audio using OpenAI Whisper API
async function whisperTranscribe(audioPath, openaiKey) {
    const { Blob } = require('buffer');
    const audioBuffer = fs.readFileSync(audioPath);
    const ext = path.extname(audioPath).slice(1) || 'm4a';
    const blob = new Blob([audioBuffer], { type: `audio/${ext}` });

    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        body: form
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Whisper API error: ${res.status} ${err}`);
    }
    const data = await res.json();

    const words = (data.words || []).map(w => ({
        word: w.word.trim(),
        timestamp: Math.round(w.start * 10) / 10
    }));
    const fullText = data.text || words.map(w => w.word).join(' ');
    return { fullText, words };
}

// Re-fetch transcript only (tries YouTube captions first, falls back to Whisper)
async function refetchTranscript(videoId, openaiKey) {
    const analysis = await getAnalysis(videoId);
    if (!analysis) throw new Error('No analysis found for this video');

    const dir = path.join(VIDEO_DATA_DIR, videoId);
    fs.mkdirSync(dir, { recursive: true });

    let transcript = { fullText: '', words: [] };
    let method = 'captions';

    // Try YouTube captions first
    const subDir = path.join(dir, 'subs');
    fs.mkdirSync(subDir, { recursive: true });
    try {
        await run('yt-dlp', [
            ...YTDLP_BASE,
            '--write-auto-sub', '--sub-lang', 'en', '--sub-format', 'json3',
            '--skip-download', '-o', path.join(subDir, '%(id)s'),
            `https://www.youtube.com/watch?v=${videoId}`
        ]);
        const subFiles = fs.readdirSync(subDir).filter(f => f.endsWith('.json3'));
        if (subFiles.length > 0) {
            const subContent = fs.readFileSync(path.join(subDir, subFiles[0]), 'utf8');
            transcript = parseJson3Captions(subContent);
        }
    } catch (e) {
        console.warn(`Captions download failed for ${videoId}:`, e.message);
    } finally {
        fs.rmSync(subDir, { recursive: true, force: true });
    }

    // Fall back to Whisper if no captions
    if (!transcript.fullText && openaiKey) {
        method = 'whisper';
        const audioPath = path.join(dir, 'audio.m4a');
        try {
            // Download audio only (try m4a first, then any audio, then worst quality as last resort)
            const fmtAttempts = ['bestaudio[ext=m4a]/bestaudio', 'worstaudio', 'worst'];
            let downloaded = false;
            for (const fmt of fmtAttempts) {
                if (downloaded) break;
                try {
                    await run('yt-dlp', [
                        ...YTDLP_BASE,
                        '-f', fmt,
                        '--no-playlist',
                        '-x', '--audio-format', 'm4a',
                        '-o', audioPath,
                        `https://www.youtube.com/watch?v=${videoId}`
                    ]);
                    // yt-dlp with -x may output with different extension
                    if (!fs.existsSync(audioPath)) {
                        const files = fs.readdirSync(dir).filter(f => f.startsWith('audio.'));
                        if (files.length > 0) {
                            fs.renameSync(path.join(dir, files[0]), audioPath);
                        }
                    }
                    if (fs.existsSync(audioPath)) downloaded = true;
                } catch (e) {
                    console.warn(`yt-dlp format "${fmt}" failed for ${videoId}:`, e.message);
                }
            }
            if (!downloaded) throw new Error('Could not download audio in any format');
            transcript = await whisperTranscribe(audioPath, openaiKey);
        } finally {
            // Clean up audio file
            try { fs.unlinkSync(audioPath); } catch (e) {}
        }
    }

    if (!transcript.fullText) {
        throw new Error('No captions and Whisper transcription failed');
    }

    analysis.transcript = transcript;
    const analysisPath = path.join(dir, 'analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));

    // Upload updated analysis to R2
    try {
        await cloud.uploadToR2(
            `videos/${videoId}/analysis.json`,
            Buffer.from(JSON.stringify(analysis)),
            'application/json'
        );
    } catch (e) {
        console.warn(`R2: Failed to upload updated analysis for ${videoId}:`, e.message);
    }

    return { success: true, method, wordCount: transcript.words.length };
}

// Re-analyze frames only (uses existing frames + analysis.json)
async function reanalyzeFrames(videoId, openaiKey, chatModel) {
    const analysis = await getAnalysis(videoId);
    if (!analysis) throw new Error('No analysis found for this video');

    const existing = jobs.get(videoId);
    if (existing && ['analyzing_frames'].includes(existing.status)) {
        return { jobId: videoId, status: existing.status };
    }

    updateJob(videoId, { status: 'analyzing_frames', progress: 0, error: null, startedAt: Date.now(), title: analysis.metadata.title });

    (async () => {
        try {
            const framesDir = path.join(VIDEO_DATA_DIR, videoId, 'frames');

            // If frames dir doesn't exist locally, download from R2
            if (!fs.existsSync(framesDir) || fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).length === 0) {
                if (cloud.isR2Ready()) {
                    console.log(`R2: Downloading frames for ${videoId} (local not found)...`);
                    fs.mkdirSync(framesDir, { recursive: true });
                    const keys = await cloud.listR2Keys(`videos/${videoId}/frames/`);
                    for (const key of keys) {
                        const filename = path.basename(key);
                        const buf = await cloud.downloadFromR2(key);
                        if (buf) fs.writeFileSync(path.join(framesDir, filename), buf);
                    }
                    console.log(`R2: Downloaded ${keys.length} frames for ${videoId}`);
                }
            }

            const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
            const transcript = analysis.transcript || { fullText: '', words: [] };
            const duration = analysis.metadata.duration || 0;

            const frames = frameFiles.map((f, i) => ({
                index: i,
                timestamp: i,
                filename: f,
                analysis: null
            }));

            // Carry over existing analyses where available
            const oldFrames = analysis.frames || [];
            for (const frame of frames) {
                const old = oldFrames.find(of => of.filename === frame.filename);
                if (old && old.analysis && !old.analysis.error) {
                    frame.analysis = old.analysis;
                }
            }

            // Analyze any frames missing analysis
            if (openaiKey) {
                const toAnalyze = frames.filter(f => !f.analysis);
                for (let i = 0; i < toAnalyze.length; i++) {
                    const frame = toAnalyze[i];
                    const framePath = path.join(framesDir, frame.filename);
                    const segTranscript = getTranscriptSegment(transcript.words || [], frame.timestamp);

                    try {
                        frame.analysis = await analyzeFrame(
                            openaiKey, chatModel, framePath,
                            frame.timestamp, duration,
                            segTranscript, transcript.fullText || ''
                        );
                    } catch (e) {
                        console.warn(`Frame ${frame.filename} analysis failed:`, e.message);
                        frame.analysis = { sceneDescription: 'Analysis failed', error: e.message };
                    }

                    updateJob(videoId, { progress: Math.round((i / toAnalyze.length) * 95) });
                }
            }

            // Update analysis.json
            analysis.frames = frames;
            if (analysis.metadata.isVertical === undefined && frameFiles.length > 0) {
                try {
                    const probe = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', path.join(framesDir, frameFiles[0])]);
                    const probeData = JSON.parse(probe);
                    const stream = (probeData.streams || [])[0] || {};
                    analysis.metadata.isVertical = (stream.height || 0) > (stream.width || 1);
                    analysis.metadata.width = stream.width || 0;
                    analysis.metadata.height = stream.height || 0;
                } catch (e) {}
            }

            const analysisJson = JSON.stringify(analysis, null, 2);
            fs.writeFileSync(path.join(VIDEO_DATA_DIR, videoId, 'analysis.json'), analysisJson);

            // Upload updated analysis to R2
            try {
                await cloud.uploadToR2(
                    `videos/${videoId}/analysis.json`,
                    Buffer.from(JSON.stringify(analysis)),
                    'application/json'
                );
            } catch (e) {
                console.warn(`R2: Failed to upload analysis.json for ${videoId}:`, e.message);
            }

            updateJob(videoId, { status: 'complete', progress: 100 });
            await flushJobState(videoId);
        } catch (e) {
            console.error('Frame re-analysis failed:', e);
            updateJob(videoId, { status: 'error', error: e.message });
            await flushJobState(videoId);
        }
    })();

    return { jobId: videoId, status: 'analyzing_frames' };
}

async function deleteAnalysis(videoId) {
    // Delete local
    const dir = path.join(VIDEO_DATA_DIR, videoId);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    jobs.delete(videoId);

    // Delete from R2
    if (cloud.isR2Ready()) {
        try {
            const keys = await cloud.listR2Keys(`videos/${videoId}/`);
            for (const key of keys) {
                await cloud.deleteFromR2(key);
            }
            console.log(`R2: Deleted ${keys.length} objects for ${videoId}`);
        } catch (e) {
            console.warn(`R2: Failed to delete objects for ${videoId}:`, e.message);
        }
    }
}

// Resume interrupted jobs from R2 on server startup
async function resumeJobs(openaiKey, chatModel) {
    if (!cloud.isR2Ready()) {
        console.log('R2: Not configured — skipping job resume');
        return;
    }

    try {
        const activeJobs = await cloud.loadAllActiveJobs();
        if (activeJobs.length === 0) {
            console.log('R2: No interrupted jobs to resume');
            return;
        }

        console.log(`R2: Found ${activeJobs.length} interrupted job(s), resuming...`);
        for (const job of activeJobs) {
            const videoId = job.videoId;
            if (!videoId) continue;

            // Check if analysis already exists in R2 (job is actually done)
            const analysisExists = await cloud.existsInR2(`videos/${videoId}/analysis.json`);
            if (analysisExists) {
                console.log(`R2: Job ${videoId} already has analysis — marking complete`);
                jobs.set(videoId, { status: 'complete', progress: 100, error: null, startedAt: job.startedAt, title: job.title });
                await cloud.saveJobState(videoId, { videoId, status: 'complete', progress: 100 });
                continue;
            }

            // Check if frames exist but no analysis — resume from summarizing
            const frameKeys = await cloud.listR2Keys(`videos/${videoId}/frames/`);
            if (frameKeys.length > 0) {
                console.log(`R2: Job ${videoId} has ${frameKeys.length} frames — resuming from analysis`);
                // Re-start the full analysis (will re-download video if needed)
                try {
                    await startAnalysis(job.url || `https://www.youtube.com/watch?v=${videoId}`, openaiKey, chatModel);
                } catch (e) {
                    console.warn(`R2: Failed to resume job ${videoId}:`, e.message);
                }
                continue;
            }

            // No frames, no analysis — restart from scratch
            console.log(`R2: Job ${videoId} has no frames — restarting`);
            try {
                await startAnalysis(job.url || `https://www.youtube.com/watch?v=${videoId}`, openaiKey, chatModel);
            } catch (e) {
                console.warn(`R2: Failed to restart job ${videoId}:`, e.message);
            }
        }
    } catch (e) {
        console.error('R2: Job resume failed:', e);
    }
}

// Upload analysis.json to R2 (called by server.js after analytics merge)
async function uploadAnalysisToR2(videoId, analysis) {
    if (!cloud.isR2Ready()) return;
    try {
        await cloud.uploadToR2(
            `videos/${videoId}/analysis.json`,
            Buffer.from(JSON.stringify(analysis)),
            'application/json'
        );
    } catch (e) {
        console.warn(`R2: Failed to upload analysis.json for ${videoId}:`, e.message);
    }
}

// Parse a YouTube channel URL into a canonical form
function parseChannelUrl(text) {
    const m = text.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/((?:@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+))/i);
    return m ? `https://www.youtube.com/${m[1]}` : null;
}

// Discover all Shorts video IDs from a channel using yt-dlp flat playlist
async function discoverChannelShorts(channelUrl) {
    const stdout = await run('yt-dlp', [
        ...YTDLP_BASE,
        '--flat-playlist', '--print', '%(id)s',
        channelUrl + '/shorts'
    ], { timeout: 120000 });
    const ids = stdout.trim().split('\n')
        .map(id => id.trim())
        .filter(id => /^[\w-]{11}$/.test(id));
    return [...new Set(ids)];
}

// Re-upload a video to Dropbox (for videos that failed initial upload)
async function reuploadToDropbox(videoId) {
    const analysis = await getAnalysis(videoId);
    if (!analysis) throw new Error(`No analysis found for ${videoId}`);

    const folderName = (analysis.aiAnalysis?.videoIdea || analysis.metadata?.title || videoId).trim();
    const sanitized = cloud.sanitizeTitle(folderName);
    const folderPath = `/Final Videos/${sanitized}`;
    const dropboxDest = `${folderPath}/video.mp4`;

    // Download video at 720p
    const dir = path.join(VIDEO_DATA_DIR, videoId);
    fs.mkdirSync(dir, { recursive: true });
    const videoPath = path.join(dir, `video_reupload.mp4`);

    try {
        console.log(`Reupload: Downloading ${videoId} at 720p...`);
        await run('yt-dlp', [
            ...YTDLP_BASE,
            '-f', 'best[height<=720]/best',
            '-o', videoPath,
            `https://www.youtube.com/watch?v=${videoId}`
        ], { timeout: 600000 });

        // Upload to Dropbox
        console.log(`Reupload: Uploading to ${dropboxDest}...`);
        await cloud.createDropboxFolder(folderPath);
        await cloud.uploadLargeToDropbox(dropboxDest, videoPath);
        console.log(`Reupload: SUCCESS — ${dropboxDest}`);

        // Update analysis.json with dropboxPath
        analysis.dropboxPath = dropboxDest;
        const analysisPath = path.join(dir, 'analysis.json');
        fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
        // Also update R2
        try {
            await cloud.uploadToR2(`videos/${videoId}/analysis.json`, Buffer.from(JSON.stringify(analysis)), 'application/json');
        } catch (e) { console.warn(`R2 update failed: ${e.message}`); }

        return { success: true, dropboxPath: dropboxDest };
    } finally {
        // Clean up local file
        try { fs.unlinkSync(videoPath); } catch (e) {}
    }
}

// Download HD version of a video and upload to Dropbox
async function downloadHD(videoId) {
    const analysis = await getAnalysis(videoId);
    if (!analysis) throw new Error(`No analysis found for ${videoId}`);

    const folderName = (analysis.aiAnalysis?.videoIdea || analysis.metadata?.title || videoId).trim();
    const sanitized = cloud.sanitizeTitle(folderName);
    const folderPath = `/Final Videos/${sanitized}`;
    const dropboxDest = `${folderPath}/video_hd.mp4`;

    // Download video at best quality
    const dir = path.join(VIDEO_DATA_DIR, videoId);
    fs.mkdirSync(dir, { recursive: true });
    const videoPath = path.join(dir, `video_hd.mp4`);

    try {
        console.log(`HD Download: Downloading ${videoId} at best quality...`);
        await run('yt-dlp', [
            ...YTDLP_BASE,
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '-o', videoPath,
            `https://www.youtube.com/watch?v=${videoId}`
        ], { timeout: 600000 });

        // Upload to Dropbox
        console.log(`HD Download: Uploading to ${dropboxDest}...`);
        await cloud.createDropboxFolder(folderPath);
        await cloud.uploadLargeToDropbox(dropboxDest, videoPath);
        console.log(`HD Download: SUCCESS — ${dropboxDest}`);

        // Update analysis.json with dropboxHDPath
        analysis.dropboxHDPath = dropboxDest;
        const analysisPath = path.join(dir, 'analysis.json');
        fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
        // Also update R2
        try {
            await cloud.uploadToR2(`videos/${videoId}/analysis.json`, Buffer.from(JSON.stringify(analysis)), 'application/json');
        } catch (e) { console.warn(`R2 update failed: ${e.message}`); }

        return { success: true, dropboxHDPath: dropboxDest };
    } finally {
        // Clean up local file
        try { fs.unlinkSync(videoPath); } catch (e) {}
    }
}

module.exports = {
    startAnalysis, getStatus, getAnalysis, getFramePath, getFrameR2Url,
    deleteAnalysis, reanalyzeFrames, refetchTranscript, parseVideoId, resumeJobs, uploadAnalysisToR2,
    parseChannelUrl, discoverChannelShorts, reuploadToDropbox, downloadHD
};
