"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");

const express = require("express");
const session = require("express-session");
const { google } = require("googleapis");

const { ThumbnailEngine } = require("./thumbnail-engine");

require("dotenv").config();

const app = express();
const engine = new ThumbnailEngine({
  xdPath: process.env.TEMPLATE_XD_PATH || path.join(__dirname, "ap.xd"),
  fallbackCourseName: process.env.FALLBACK_COURSE_NAME || "Modern physics",
});

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "4318", 10);
const EXPECTED_CHANNEL_TITLE =
  process.env.EXPECTED_CHANNEL_TITLE || "Advanced Physics";
const OUTPUT_DIRECTORY =
  process.env.OUTPUT_DIRECTORY || "C:\\Personal Projects\\ap";
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DATA_DIR = path.join(__dirname, ".data");
const TOKEN_FILE = path.join(DATA_DIR, "youtube-tokens.json");
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "lax",
    },
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});
app.use(
  "/outputs",
  express.static(OUTPUT_DIRECTORY, {
    etag: false,
    fallthrough: false,
    setHeaders(response) {
      response.setHeader("Cache-Control", "no-store");
    },
  }),
);

function getRedirectUri() {
  return process.env.YOUTUBE_REDIRECT_URI || `http://${HOST}:${PORT}/auth/callback`;
}

function hasOAuthConfig() {
  return Boolean(
    process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET,
  );
}

function getOAuthConfig() {
  if (!hasOAuthConfig()) {
    const error = new Error(
      "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env before starting OAuth.",
    );
    error.status = 500;
    throw error;
  }

  return {
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri: getRedirectUri(),
  };
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readStoredTokens() {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function saveStoredTokens(tokens) {
  await ensureDataDir();
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function createOAuthClient() {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  const authClient = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri,
  );

  authClient.on("tokens", (tokens) => {
    if (!tokens || Object.keys(tokens).length === 0) {
      return;
    }

    void readStoredTokens()
      .then((existingTokens) =>
        saveStoredTokens({ ...(existingTokens || {}), ...tokens }),
      )
      .catch((error) => {
        console.error("Failed to persist refreshed tokens:", error);
      });
  });

  return authClient;
}

async function getAuthorizedClient() {
  const tokens = await readStoredTokens();

  if (!tokens) {
    const error = new Error(
      "No saved YouTube tokens found. Open /auth/start in your browser first.",
    );
    error.status = 401;
    throw error;
  }

  const authClient = createOAuthClient();
  authClient.setCredentials(tokens);
  return authClient;
}

async function getYouTubeClient() {
  return google.youtube({
    version: "v3",
    auth: await getAuthorizedClient(),
  });
}

function sanitizeFileName(value) {
  const baseName = (value || "thumbnail")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

  return baseName || "thumbnail";
}

function requireText(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${fieldName} is required.`);
    error.status = 400;
    throw error;
  }

  return value.trim();
}

function extractVideoId(videoInput) {
  const normalizedInput = requireText(videoInput, "videoInput");

  if (/^[A-Za-z0-9_-]{11}$/.test(normalizedInput)) {
    return normalizedInput;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(normalizedInput);
  } catch (_error) {
    const error = new Error("Enter a YouTube video URL or a valid 11-character video ID.");
    error.status = 400;
    throw error;
  }

  const hostname = parsedUrl.hostname.replace(/^www\./, "").toLowerCase();
  let candidateId = null;

  if (hostname === "youtu.be") {
    candidateId = parsedUrl.pathname.split("/").filter(Boolean)[0];
  } else if (
    hostname === "youtube.com" ||
    hostname === "m.youtube.com" ||
    hostname === "music.youtube.com"
  ) {
    if (parsedUrl.pathname === "/watch") {
      candidateId = parsedUrl.searchParams.get("v");
    } else {
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);

      if (
        pathParts.length >= 2 &&
        ["shorts", "live", "embed"].includes(pathParts[0].toLowerCase())
      ) {
        candidateId = pathParts[1];
      }
    }
  }

  if (!candidateId || !/^[A-Za-z0-9_-]{11}$/.test(candidateId)) {
    const error = new Error("Could not extract a YouTube video ID from that input.");
    error.status = 400;
    throw error;
  }

  return candidateId;
}

function splitVideoTitle(title) {
  const normalizedTitle = requireText(title, "title");
  const dashMatch = normalizedTitle.match(/^(.+?)\s[-–—]\s(.+)$/);

  if (!dashMatch) {
    const error = new Error(
      'Expected a title like "Course Name - Video Title". Update the YouTube title format or handle it manually.',
    );
    error.status = 400;
    throw error;
  }

  return {
    courseName: dashMatch[1].trim(),
    lessonTitle: dashMatch[2].trim(),
  };
}

async function saveOutputCopy(buffer, outputFileName) {
  await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });

  const outputName = `${sanitizeFileName(path.parse(outputFileName).name)}.png`;
  const outputPath = path.join(OUTPUT_DIRECTORY, outputName);
  await fs.writeFile(outputPath, buffer);

  return {
    outputName,
    outputPath,
    previewUrl: `/outputs/${encodeURIComponent(outputName)}?v=${Date.now()}`,
  };
}

async function uploadThumbnail(videoId, buffer) {
  const youtube = await getYouTubeClient();
  await youtube.thumbnails.set({
    videoId,
    media: {
      mimeType: "image/png",
      body: Readable.from(buffer),
    },
  });
}

async function resolveVideo(videoInput) {
  const videoId = extractVideoId(videoInput);
  const youtube = await getYouTubeClient();
  const response = await youtube.videos.list({
    part: ["snippet"],
    id: [videoId],
  });
  const item = response.data.items && response.data.items[0];

  if (!item || !item.snippet) {
    const error = new Error(`No YouTube video was found for ID "${videoId}".`);
    error.status = 404;
    throw error;
  }

  const { courseName, lessonTitle } = splitVideoTitle(item.snippet.title || "");
  const warnings = [];

  if (
    EXPECTED_CHANNEL_TITLE &&
    item.snippet.channelTitle &&
    item.snippet.channelTitle !== EXPECTED_CHANNEL_TITLE
  ) {
    warnings.push(
      `Expected channel "${EXPECTED_CHANNEL_TITLE}", but this video is from "${item.snippet.channelTitle}".`,
    );
  }

  return {
    videoId,
    videoInput,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: item.snippet.title || "",
    description: item.snippet.description || "",
    channelTitle: item.snippet.channelTitle || "",
    courseName,
    lessonTitle,
    warnings,
    outputFileName: sanitizeFileName(item.snippet.title || videoId),
  };
}

async function renderVideo(videoInput) {
  const video = await resolveVideo(videoInput);
  const renderResult = await engine.renderThumbnail({
    courseName: video.courseName,
    lessonTitle: video.lessonTitle,
  });

  if (renderResult.buffer.length > MAX_THUMBNAIL_BYTES) {
    const error = new Error(
      "The rendered thumbnail is larger than YouTube's 2 MB limit. Tighten the template or add a compression step.",
    );
    error.status = 400;
    throw error;
  }

  const saved = await saveOutputCopy(renderResult.buffer, video.outputFileName);

  return {
    video,
    renderResult,
    saved,
  };
}

function sendError(res, error) {
  res.status(error.status || 500).json({
    error: error.message || "Unknown error",
  });
}

function renderHomePage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Advanced Physics Thumbnailer</title>
    <style>
      :root {
        --bg-a: #07110e;
        --bg-b: #0f1d17;
        --panel: rgba(7, 15, 12, 0.82);
        --panel-2: rgba(19, 37, 29, 0.8);
        --ink: #edf7ef;
        --muted: rgba(237, 247, 239, 0.72);
        --line: rgba(173, 255, 140, 0.18);
        --accent: #b9ff73;
        --accent-2: #66d12d;
        --danger: #ff8fb1;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(185, 255, 115, 0.14), transparent 28%),
          radial-gradient(circle at bottom right, rgba(0, 0, 0, 0.48), transparent 30%),
          linear-gradient(160deg, var(--bg-a) 0%, var(--bg-b) 100%);
      }
      .shell {
        width: min(1120px, calc(100% - 32px));
        margin: 24px auto;
        display: grid;
        gap: 18px;
        grid-template-columns: 1.05fr 0.95fr;
      }
      .panel {
        border-radius: 24px;
        padding: 22px;
        background: var(--panel);
        border: 1px solid var(--line);
        box-shadow: 0 20px 80px rgba(0, 0, 0, 0.34);
        backdrop-filter: blur(14px);
      }
      .hero {
        background:
          linear-gradient(180deg, rgba(185, 255, 115, 0.08), transparent 26%),
          var(--panel);
      }
      h1 {
        margin: 0 0 8px;
        font-size: clamp(2rem, 3vw, 3rem);
        line-height: 0.95;
        letter-spacing: 0.02em;
      }
      .eyebrow {
        display: inline-block;
        margin-bottom: 12px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        color: var(--accent);
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .lede, .meta, .status {
        color: var(--muted);
        line-height: 1.55;
      }
      .form-grid {
        display: grid;
        gap: 12px;
      }
      label {
        display: block;
        margin-bottom: 6px;
        color: var(--accent);
        font-size: 0.82rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }
      input {
        width: 100%;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.09);
        background: rgba(255, 255, 255, 0.06);
        color: var(--ink);
        font: inherit;
      }
      .actions {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(3, 1fr);
        margin-top: 8px;
      }
      button {
        border: 0;
        border-radius: 14px;
        padding: 13px 15px;
        font: inherit;
        font-weight: 700;
        color: #061108;
        background: linear-gradient(180deg, var(--accent) 0%, var(--accent-2) 100%);
        cursor: pointer;
      }
      button.secondary {
        color: var(--ink);
        background: rgba(255, 255, 255, 0.08);
      }
      button:disabled {
        cursor: default;
        opacity: 0.55;
      }
      .card-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .card {
        padding: 14px 16px;
        border-radius: 16px;
        background: var(--panel-2);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .card strong {
        display: block;
        margin-bottom: 6px;
        color: var(--accent);
        font-size: 0.8rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .status {
        min-height: 110px;
        white-space: pre-wrap;
      }
      .status.error {
        color: var(--danger);
      }
      .preview {
        display: block;
        width: 100%;
        border-radius: 20px;
        background: #030806;
        border: 1px solid var(--line);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
      }
      .meta-list {
        display: grid;
        gap: 8px;
      }
      .meta-line {
        display: flex;
        gap: 10px;
        align-items: baseline;
      }
      .meta-line strong {
        color: var(--accent);
        min-width: 120px;
      }
      a {
        color: #d4ffb0;
      }
      @media (max-width: 900px) {
        .shell {
          grid-template-columns: 1fr;
        }
        .actions {
          grid-template-columns: 1fr;
        }
        .card-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="panel hero">
        <span class="eyebrow">Headless Flow</span>
        <h1>Advanced Physics Thumbnailer</h1>
        <p class="lede">Paste a YouTube video link. The server reads <code>ap.xd</code>, rebuilds the thumbnail layout headlessly, saves the PNG, and can push it straight to YouTube without opening Adobe XD.</p>

        <div class="form-grid">
          <div>
            <label for="videoInput">YouTube Video URL</label>
            <input id="videoInput" placeholder="https://www.youtube.com/watch?v=..." />
          </div>
        </div>

        <div class="actions">
          <button class="secondary" id="statusButton" type="button">Check Status</button>
          <button class="secondary" id="connectButton" type="button">Connect YouTube</button>
          <button id="renderButton" type="button">Preview Render</button>
          <button class="secondary" id="resolveButton" type="button">Resolve Title</button>
          <button id="uploadButton" type="button" style="grid-column: span 2;">Render + Upload</button>
        </div>

        <div class="card-grid" style="margin-top: 18px;">
          <div class="card">
            <strong>Course</strong>
            <div id="courseName">Not resolved yet.</div>
          </div>
          <div class="card">
            <strong>Lesson</strong>
            <div id="lessonTitle">Not resolved yet.</div>
          </div>
        </div>

        <div class="card" style="margin-top: 12px;">
          <strong>Status</strong>
          <div id="statusText" class="status">Start by checking status and connecting YouTube once.</div>
        </div>
      </section>

      <section class="panel">
        <img id="previewImage" class="preview" alt="Thumbnail preview" />

        <div class="card" style="margin-top: 14px;">
          <strong>Render Details</strong>
          <div id="metaBox" class="meta-list meta">
            <div class="meta-line"><strong>Template</strong><span>Not rendered yet.</span></div>
          </div>
        </div>
      </section>
    </main>

    <script>
      const statusText = document.getElementById("statusText");
      const courseName = document.getElementById("courseName");
      const lessonTitle = document.getElementById("lessonTitle");
      const previewImage = document.getElementById("previewImage");
      const metaBox = document.getElementById("metaBox");
      const videoInput = document.getElementById("videoInput");
      const buttons = Array.from(document.querySelectorAll("button"));

      function setBusy(isBusy) {
        buttons.forEach((button) => {
          button.disabled = isBusy;
        });
      }

      function setStatus(message, tone) {
        statusText.textContent = message;
        statusText.className = tone === "error" ? "status error" : "status";
      }

      function setResolved(video) {
        courseName.textContent = video ? video.courseName : "Not resolved yet.";
        lessonTitle.textContent = video ? video.lessonTitle : "Not resolved yet.";
      }

      function setMeta(lines) {
        metaBox.innerHTML = lines
          .map(([label, value]) => '<div class="meta-line"><strong>' + label + '</strong><span>' + value + '</span></div>')
          .join("");
      }

      async function api(path, options) {
        const response = await fetch(path, options);
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.error || ("Request failed with status " + response.status));
        }

        return data;
      }

      async function checkStatus() {
        const status = await api("/api/status");
        const authText = status.authenticated ? "connected" : "not connected";
        setStatus(
          "Renderer ready. Templates loaded: " +
            status.templateCount +
            "\\nYouTube OAuth: " +
            authText +
            "\\nOutput directory: " +
            status.outputDirectory,
        );
      }

      async function resolveVideo() {
        const payload = await api("/api/video/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoInput: videoInput.value.trim() })
        });
        setResolved(payload);
        const warningText = payload.warnings && payload.warnings.length ? "\\n" + payload.warnings.join("\\n") : "";
        setStatus(
          "Resolved " + payload.videoId + "\\nCourse: " + payload.courseName + "\\nLesson: " + payload.lessonTitle + warningText
        );
        return payload;
      }

      async function renderVideo(upload) {
        const route = upload ? "/api/render-and-upload" : "/api/render-video";
        const payload = await api(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoInput: videoInput.value.trim() })
        });
        setResolved(payload.video);
        previewImage.src = payload.previewUrl;
        setMeta([
          ["Template", payload.template.courseName + (payload.template.usedFallback ? " (fallback)" : "")],
          ["Artboard", payload.template.artboardName],
          ["Course Font", payload.layout.courseFontSize + "px"],
          ["Lesson Font", payload.layout.subtitleFontSize + "px"],
          ["Saved", payload.savedPath],
          ["Video", payload.video.videoId]
        ]);
        setStatus(
          (upload ? "Rendered and uploaded." : "Preview rendered.") +
            "\\nSaved: " +
            payload.savedPath +
            "\\nTemplate: " +
            payload.template.courseName
        );
      }

      document.getElementById("statusButton").addEventListener("click", async () => {
        setBusy(true);
        try {
          await checkStatus();
        } catch (error) {
          setStatus(error.message, "error");
        } finally {
          setBusy(false);
        }
      });

      document.getElementById("connectButton").addEventListener("click", () => {
        window.location.href = "/auth/start";
      });

      document.getElementById("resolveButton").addEventListener("click", async () => {
        setBusy(true);
        try {
          await resolveVideo();
        } catch (error) {
          setStatus(error.message, "error");
        } finally {
          setBusy(false);
        }
      });

      document.getElementById("renderButton").addEventListener("click", async () => {
        setBusy(true);
        try {
          await renderVideo(false);
        } catch (error) {
          setStatus(error.message, "error");
        } finally {
          setBusy(false);
        }
      });

      document.getElementById("uploadButton").addEventListener("click", async () => {
        setBusy(true);
        try {
          await renderVideo(true);
        } catch (error) {
          setStatus(error.message, "error");
        } finally {
          setBusy(false);
        }
      });

      checkStatus().catch((error) => {
        setStatus(error.message, "error");
      });
    </script>
  </body>
</html>`;
}

app.get("/", (_req, res) => {
  res.type("html").send(renderHomePage());
});

app.get("/api/status", async (_req, res) => {
  res.json({
    configured: hasOAuthConfig(),
    authenticated: Boolean(await readStoredTokens()),
    redirectUri: getRedirectUri(),
    outputDirectory: OUTPUT_DIRECTORY,
    expectedChannelTitle: EXPECTED_CHANNEL_TITLE,
    templateCount: engine.getTemplates().length,
  });
});

app.get("/auth/start", (req, res) => {
  try {
    const authClient = createOAuthClient();
    const state = crypto.randomBytes(24).toString("hex");
    req.session.oauthState = state;

    res.redirect(
      authClient.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: YOUTUBE_SCOPES,
        state,
      }),
    );
  } catch (error) {
    res.status(error.status || 500).type("html").send(`<pre>${error.message}</pre>`);
  }
});

app.get("/auth/callback", async (req, res) => {
  try {
    if (!req.session.oauthState || req.query.state !== req.session.oauthState) {
      const error = new Error("OAuth state did not match the original request.");
      error.status = 400;
      throw error;
    }

    if (typeof req.query.code !== "string" || !req.query.code) {
      const error = new Error("OAuth callback did not include an authorization code.");
      error.status = 400;
      throw error;
    }

    const authClient = createOAuthClient();
    const { tokens } = await authClient.getToken(req.query.code);

    if (!tokens) {
      const error = new Error("Google returned an empty token set.");
      error.status = 500;
      throw error;
    }

    await saveStoredTokens(tokens);
    req.session.oauthState = null;
    res.redirect("/");
  } catch (error) {
    res.status(error.status || 500).type("html").send(`<pre>${error.message}</pre>`);
  }
});

app.post("/api/video/resolve", async (req, res) => {
  try {
    res.json(await resolveVideo(req.body.videoInput));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/render-video", async (req, res) => {
  try {
    const result = await renderVideo(req.body.videoInput);
    res.json({
      video: result.video,
      savedPath: result.saved.outputPath,
      previewUrl: result.saved.previewUrl,
      template: result.renderResult.template,
      layout: result.renderResult.layout,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/render-and-upload", async (req, res) => {
  try {
    const result = await renderVideo(req.body.videoInput);
    await uploadThumbnail(result.video.videoId, result.renderResult.buffer);

    res.json({
      uploaded: true,
      video: result.video,
      savedPath: result.saved.outputPath,
      previewUrl: result.saved.previewUrl,
      template: result.renderResult.template,
      layout: result.renderResult.layout,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/logout", async (_req, res) => {
  try {
    await fs.rm(TOKEN_FILE, { force: true });
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Advanced Physics thumbnailer listening on http://${HOST}:${PORT}`);
  console.log(`OAuth redirect URI: ${getRedirectUri()}`);
});
