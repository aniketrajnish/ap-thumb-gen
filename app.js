const elements = {
  form: document.getElementById("thumbnailForm"),
  videoInput: document.getElementById("videoInput"),
  generateButton: document.getElementById("generateButton"),
  downloadButton: document.getElementById("downloadButton"),
  statusText: document.getElementById("statusText"),
  result: document.getElementById("result"),
  previewImage: document.getElementById("previewImage"),
  resultTitle: document.getElementById("resultTitle"),
  resultDetail: document.getElementById("resultDetail"),
};

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

let assetStatePromise = null;
let currentDownloadUrl = null;

function setBusy(isBusy) {
  elements.generateButton.disabled = isBusy;
  elements.downloadButton.disabled = isBusy || !currentDownloadUrl;
  elements.generateButton.textContent = isBusy ? "working..." : "generate";
}

function setStatus(message, tone) {
  elements.statusText.textContent = message;
  elements.statusText.className = tone === "error" ? "status error" : "status";
}

function clearResult() {
  if (currentDownloadUrl) {
    URL.revokeObjectURL(currentDownloadUrl);
    currentDownloadUrl = null;
  }

  elements.previewImage.removeAttribute("src");
  elements.resultTitle.textContent = "";
  elements.resultDetail.textContent = "";
  elements.result.hidden = true;
  elements.downloadButton.disabled = true;
}

function setResult(payload) {
  if (currentDownloadUrl) {
    URL.revokeObjectURL(currentDownloadUrl);
  }

  currentDownloadUrl = payload.downloadUrl;
  elements.result.hidden = false;
  elements.previewImage.src = payload.downloadUrl;
  elements.resultTitle.textContent = payload.video.title;
  elements.resultDetail.textContent = `${payload.video.courseName} | ${payload.template.courseName}${payload.template.usedFallback ? " fallback" : ""}`;
  elements.downloadButton.disabled = false;
}

function requireText(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required.`);
  }

  return value.trim();
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]+/g, "");
}

function transformText(text, transform) {
  if (transform === "uppercase") {
    return String(text || "").toUpperCase();
  }

  if (transform === "lowercase") {
    return String(text || "").toLowerCase();
  }

  return String(text || "");
}

function splitLongToken(context, fontSize, token, maxWidth, fontFamily) {
  const chunks = [];
  let current = "";

  for (const character of token) {
    const candidate = `${current}${character}`;

    if (!current || measureTextWidth(context, fontFamily, fontSize, candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    current = character;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function measureTextWidth(context, fontFamily, fontSize, text) {
  context.font = `${fontSize}px "${fontFamily}"`;
  return context.measureText(String(text || "")).width;
}

function wrapParagraph(context, fontFamily, fontSize, paragraph, maxWidth) {
  if (!paragraph) {
    return [""];
  }

  const words = paragraph.split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (!currentLine || measureTextWidth(context, fontFamily, fontSize, candidate) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    if (measureTextWidth(context, fontFamily, fontSize, word) <= maxWidth) {
      currentLine = word;
      continue;
    }

    const chunks = splitLongToken(context, fontSize, word, maxWidth, fontFamily);
    lines.push(...chunks.slice(0, -1));
    currentLine = chunks[chunks.length - 1] || "";
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length ? lines : [""];
}

function wrapText(context, fontFamily, fontSize, text, maxWidth) {
  const paragraphs = String(text || "")
    .replace(/\r/g, "")
    .split("\n");
  const lines = [];

  for (const paragraph of paragraphs) {
    lines.push(...wrapParagraph(context, fontFamily, fontSize, paragraph.trim(), maxWidth));
  }

  return lines.filter((line) => line.trim());
}

function fitTextBlock(context, fontFamily, options) {
  const {
    rawText,
    originalFontSize,
    originalLineHeight,
    minFontSize,
    maxWidth,
    maxHeight,
    maxLines,
    textTransform,
    preprocess,
  } = options;
  const preparedText = preprocess(rawText);

  for (let fontSize = originalFontSize; fontSize >= minFontSize; fontSize -= 2) {
    const transformedText = transformText(preparedText, textTransform);
    const lines = wrapText(context, fontFamily, fontSize, transformedText, maxWidth);
    const lineHeight = (originalLineHeight || originalFontSize * 1.22) * (fontSize / originalFontSize);
    const totalHeight = (Math.max(lines.length, 1) - 1) * lineHeight + fontSize;

    if (lines.length <= maxLines && totalHeight <= maxHeight) {
      return {
        fontSize,
        lineHeight,
        lines,
      };
    }
  }

  const fallbackFontSize = minFontSize;
  const transformedText = transformText(preprocess(rawText), textTransform);

  return {
    fontSize: fallbackFontSize,
    lineHeight:
      (originalLineHeight || originalFontSize * 1.22) * (fallbackFontSize / originalFontSize),
    lines: wrapText(context, fontFamily, fallbackFontSize, transformedText, maxWidth).slice(
      0,
      maxLines,
    ),
  };
}

function prepareSubtitleText(rawText) {
  return String(rawText || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[:|]\s*/g, "\n")
    .trim();
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function svgTextAnchor(align) {
  if (align === "center") {
    return "middle";
  }

  if (align === "right") {
    return "end";
  }

  return "start";
}

function createSvgTextNode(node, layout, fontFamily) {
  const anchor = svgTextAnchor(node.align);
  const lines = layout.lines
    .map(
      (line, index) =>
        `<tspan x="${node.x}" y="${node.y + index * layout.lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  return `<text fill="${node.color}" font-family="${escapeXml(
    fontFamily,
  )}" font-size="${layout.fontSize}" text-anchor="${anchor}" dominant-baseline="alphabetic">${lines}</text>`;
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
    throw new Error("Enter a YouTube video URL or a valid 11-character video ID.");
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
    throw new Error("Could not extract a YouTube video ID from that input.");
  }

  return candidateId;
}

function splitVideoTitle(title) {
  const normalizedTitle = requireText(title, "title");
  const dashMatch = normalizedTitle.match(/^(.+?)\s(?:-|–|—)\s(.+)$/);

  if (!dashMatch) {
    throw new Error("Video title must contain a course name before the dash.");
  }

  return {
    courseName: dashMatch[1].trim(),
    lessonTitle: dashMatch[2].trim(),
  };
}

function findTemplate(pack, courseName) {
  const desiredKey = normalizeKey(courseName);
  const fallbackKey = normalizeKey(pack.fallbackCourseName || "");
  const templates = pack.templates;

  let template = templates.find((entry) => entry.courseKey === desiredKey);

  if (template) {
    return { template };
  }

  template = templates.find(
    (entry) => desiredKey.includes(entry.courseKey) || entry.courseKey.includes(desiredKey),
  );

  if (template) {
    return { template };
  }

  template = templates.find((entry) => entry.courseKey === fallbackKey) || templates[0] || null;

  if (!template) {
    throw new Error("No usable templates were found in templates.json.");
  }

  return { template, usedFallback: true };
}

function toBase64(bytes) {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
}

function getMimeType(pathname) {
  if (pathname.endsWith(".png")) {
    return "image/png";
  }

  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (pathname.endsWith(".woff")) {
    return "font/woff";
  }

  return "application/octet-stream";
}

async function loadBytes(pathname) {
  const response = await fetch(pathname, {
    cache: "force-cache",
  });

  if (!response.ok) {
    throw new Error(`Missing asset: ${pathname}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function ensureAssetsLoaded() {
  if (!assetStatePromise) {
    assetStatePromise = (async () => {
      const templatesResponse = await fetch("./assets/templates.json", {
        cache: "force-cache",
      });

      if (!templatesResponse.ok) {
        throw new Error("Could not load assets/templates.json.");
      }

      const pack = await templatesResponse.json();
      const fontPath = `./assets/${pack.font.assetPath}`;
      const fontBytes = await loadBytes(fontPath);
      const fontFamily = pack.font.family || "Englebert";
      const fontFace = new FontFace(fontFamily, fontBytes, {
        style: "normal",
        weight: "400",
      });

      await fontFace.load();
      document.fonts.add(fontFace);
      await document.fonts.ready;

      return {
        pack,
        fontFamily,
        fontBase64: toBase64(fontBytes),
        measureContext: document.createElement("canvas").getContext("2d"),
        resourceCache: new Map(),
      };
    })();
  }

  return assetStatePromise;
}

async function getResourceDataUrl(assetState, assetPath) {
  if (!assetState.resourceCache.has(assetPath)) {
    assetState.resourceCache.set(
      assetPath,
      (async () => {
        const bytes = await loadBytes(`./assets/${assetPath}`);
        return `data:${getMimeType(assetPath)};base64,${toBase64(bytes)}`;
      })(),
    );
  }

  return assetState.resourceCache.get(assetPath);
}

async function resolveVideo(videoInput) {
  const videoId = extractVideoId(videoInput);
  const oembedUrl = new URL("https://www.youtube.com/oembed");
  oembedUrl.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
  oembedUrl.searchParams.set("format", "json");

  const response = await fetch(oembedUrl, {
    mode: "cors",
  });

  if (!response.ok) {
    throw new Error(`Could not resolve video metadata for ${videoId}.`);
  }

  const payload = await response.json();
  const title = payload.title || "";
  const { courseName, lessonTitle } = splitVideoTitle(title);

  return {
    videoId,
    title,
    courseName,
    lessonTitle,
  };
}

async function createSvg(assetState, video) {
  const { pack, fontFamily, fontBase64, measureContext } = assetState;
  const { template, usedFallback } = findTemplate(pack, video.courseName);
  const courseLayout = fitTextBlock(measureContext, fontFamily, {
    rawText: video.courseName,
    originalFontSize: template.courseNode.fontSize,
    originalLineHeight: template.courseNode.lineHeight || template.courseNode.fontSize * 1.22,
    minFontSize: template.courseNode.minFontSize,
    maxWidth: template.courseNode.maxWidth,
    maxHeight: template.courseNode.maxHeight,
    maxLines: template.courseNode.maxLines,
    textTransform: template.courseNode.textTransform,
    preprocess: (value) => String(value || "").replace(/\s+/g, " ").trim(),
  });
  const subtitleLayout = fitTextBlock(measureContext, fontFamily, {
    rawText: video.lessonTitle,
    originalFontSize: template.subtitleNode.fontSize,
    originalLineHeight:
      template.subtitleNode.lineHeight || template.subtitleNode.fontSize * 1.22,
    minFontSize: template.subtitleNode.minFontSize,
    maxWidth: template.subtitleNode.maxWidth,
    maxHeight: template.subtitleNode.maxHeight,
    maxLines: template.subtitleNode.maxLines,
    textTransform: template.subtitleNode.textTransform,
    preprocess: prepareSubtitleText,
  });
  const shapeNodes = await Promise.all(
    template.shapes.map(async (shape) => {
      const href = await getResourceDataUrl(assetState, shape.resourcePath);
      return `<image href="${href}" x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" opacity="${shape.opacity}" />`;
    }),
  );
  const titleNode = template.titleNode
    ? createSvgTextNode(
        template.titleNode,
        {
          fontSize: template.titleNode.fontSize,
          lineHeight: template.titleNode.lineHeight || template.titleNode.fontSize * 1.2,
          lines: [template.titleNode.text],
        },
        fontFamily,
      )
    : "";
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pack.canvas.width}" height="${pack.canvas.height}" viewBox="0 0 ${pack.canvas.width} ${pack.canvas.height}">
  <defs>
    <style><![CDATA[
      @font-face {
        font-family: "${fontFamily}";
        src: url(data:${getMimeType(pack.font.assetPath)};base64,${fontBase64}) format("woff");
        font-style: normal;
        font-weight: 400;
      }
    ]]></style>
  </defs>
  <rect width="${pack.canvas.width}" height="${pack.canvas.height}" fill="#000000" />
  ${shapeNodes.join("")}
  ${titleNode}
  ${createSvgTextNode(template.courseNode, courseLayout, fontFamily)}
  ${createSvgTextNode(template.subtitleNode, subtitleLayout, fontFamily)}
</svg>`;

  return {
    svg,
    template: {
      artboardName: template.artboardName,
      courseName: template.courseName,
      usedFallback: Boolean(usedFallback),
    },
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not render the generated thumbnail."));
    image.src = url;
  });
}

async function svgToPngBlob(svgText) {
  const svgBlob = new Blob([svgText], {
    type: "image/svg+xml;charset=utf-8",
  });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const image = await loadImage(svgUrl);
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

    if (!blob) {
      throw new Error("Could not create PNG output.");
    }

    if (blob.size > MAX_THUMBNAIL_BYTES) {
      throw new Error("Generated PNG is larger than YouTube's 2 MB limit.");
    }

    return blob;
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function generateThumbnail(videoInput) {
  const trimmedVideo = videoInput.trim();

  if (!trimmedVideo) {
    throw new Error("Paste a YouTube video URL first.");
  }

  clearResult();
  setStatus("working...");

  const [assetState, video] = await Promise.all([
    ensureAssetsLoaded(),
    resolveVideo(trimmedVideo),
  ]);
  const { svg, template } = await createSvg(assetState, video);
  const pngBlob = await svgToPngBlob(svg);
  const downloadUrl = URL.createObjectURL(pngBlob);

  return {
    video,
    template,
    downloadUrl,
    fileName: `${slugify(video.title) || video.videoId}.png`,
  };
}

async function run(videoInput) {
  setBusy(true);

  try {
    const payload = await generateThumbnail(videoInput);
    setResult(payload);
    setStatus(`done. ready to download ${payload.fileName}`);
  } catch (error) {
    clearResult();
    setStatus(error.message || "Unknown error", "error");
  } finally {
    setBusy(false);
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await run(elements.videoInput.value);
});

elements.downloadButton.addEventListener("click", () => {
  if (!currentDownloadUrl) {
    return;
  }

  const title = elements.resultTitle.textContent || "advanced-physics-thumbnail";
  const link = document.createElement("a");
  link.href = currentDownloadUrl;
  link.download = `${slugify(title) || "advanced-physics-thumbnail"}.png`;
  link.click();
});
