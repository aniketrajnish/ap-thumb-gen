# yt-xd

Headless website + local uploader for the Advanced Physics thumbnail workflow.

## Flow

1. Paste a YouTube video URL from the Advanced Physics channel into the website.
2. The server reads [ap.xd](C:\Personal Projects\yt-xd\ap.xd) directly, extracts the matching course template, and renders the thumbnail headlessly.
3. The PNG is saved to `C:\Personal Projects\ap`.
4. The same flow can upload the PNG with YouTube's `thumbnails.set` API.

## What is in this repo

- [app.js](C:\Personal Projects\yt-xd\app.js)
  Express website + YouTube upload service.
- [thumbnail-engine.js](C:\Personal Projects\yt-xd\thumbnail-engine.js)
  Headless renderer that rebuilds the thumbnail layout from `ap.xd`.
- [ap.xd](C:\Personal Projects\yt-xd\ap.xd)
  The source template file used by the renderer.
- [.env.example](C:\Personal Projects\yt-xd\.env.example)
  Required Google OAuth and local path configuration.

## Setup

1. Enable `YouTube Data API v3` in a Google Cloud project.
2. Create an OAuth client with redirect URI `http://127.0.0.1:4318/auth/callback`.
3. Copy `.env.example` to `.env` and fill in:
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`
   - `SESSION_SECRET`
   - `OUTPUT_DIRECTORY` if you want thumbnails saved somewhere other than `C:\Personal Projects\ap`
   - `TEMPLATE_XD_PATH` if `ap.xd` lives elsewhere
4. Start the app:

```bash
npm start
```

5. Open `http://127.0.0.1:4318` in your browser.
6. Click `Connect YouTube` once to complete OAuth.

## Using the Website

- Click `Check Status` to verify templates and OAuth.
- Paste a YouTube video URL or video ID.
- Click `Resolve Title` to preview the parsed course/lesson split.
- Click `Preview Render` to generate the PNG without uploading.
- Click `Render + Upload` to generate the PNG and update the YouTube thumbnail in one step.

## Notes

- This is a true headless flow. Adobe XD does not need to be open.
- The renderer parses `ap.xd` directly and uses its artboard metadata and embedded images as the template source.
- Existing artboards are matched by the course-title text on the artboard, not by the generic artboard names in the file.
- If a course template does not exist yet, the renderer falls back to `FALLBACK_COURSE_NAME` and swaps in the new course title.
- The OAuth refresh token is stored locally at `.data/youtube-tokens.json`.

## Verify

```bash
npm run check
```
