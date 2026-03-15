"use strict";

const fs = require("node:fs");
const path = require("node:path");

const AdmZip = require("adm-zip");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const TITLE_TEXT = "Advanced Physics";
const FONT_FAMILY = "Englebert";
const FONT_PATH = path.join(
  __dirname,
  "node_modules",
  "@fontsource",
  "englebert",
  "files",
  "englebert-latin-400-normal.woff",
);

let fontReady = false;

function ensureFontRegistered() {
  if (fontReady) {
    return;
  }

  GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
  fontReady = true;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function normalizeKey(value) {
  return (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]+/g, "");
}

function colorToCss(colorValue) {
  const color = colorValue || { r: 255, g: 255, b: 255 };
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function transformText(text, transform) {
  if (transform === "uppercase") {
    return text.toUpperCase();
  }

  if (transform === "lowercase") {
    return text.toLowerCase();
  }

  return text;
}

function getTextLines(rawText) {
  return String(rawText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getLineHeight(node) {
  const paragraphs = node.text?.paragraphs || [];
  const lineYs = [];

  for (const paragraph of paragraphs) {
    for (const line of paragraph.lines || []) {
      if (line[0] && typeof line[0].y === "number") {
        lineYs.push(line[0].y);
      }
    }
  }

  if (lineYs.length >= 2) {
    const deltas = [];

    for (let index = 1; index < lineYs.length; index += 1) {
      deltas.push(lineYs[index] - lineYs[index - 1]);
    }

    const average = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    return average > 0 ? average : null;
  }

  const explicitLineSpacing = node.style?.textAttributes?.lineSpacing;

  if (typeof explicitLineSpacing === "number" && explicitLineSpacing > 0) {
    return explicitLineSpacing;
  }

  return null;
}

function dedupeShapes(shapes) {
  const seen = new Set();
  const uniqueShapes = [];

  for (const shape of shapes) {
    const key = [
      shape.resourceKey,
      shape.x,
      shape.y,
      shape.width,
      shape.height,
      shape.opacity,
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueShapes.push(shape);
  }

  return uniqueShapes;
}

function createMeasureContext() {
  ensureFontRegistered();
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  return canvas.getContext("2d");
}

function setFont(ctx, fontSize) {
  ctx.font = `${fontSize}px "${FONT_FAMILY}"`;
}

function measureLines(ctx, lines, fontSize, textTransform) {
  setFont(ctx, fontSize);
  return lines.map((line) => ctx.measureText(transformText(line, textTransform)).width);
}

function splitLongToken(ctx, token, maxWidth) {
  const chunks = [];
  let current = "";

  for (const character of token) {
    const candidate = `${current}${character}`;

    if (!current || ctx.measureText(candidate).width <= maxWidth) {
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

function wrapParagraph(ctx, paragraph, maxWidth) {
  if (!paragraph) {
    return [""];
  }

  const words = paragraph.split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (!currentLine || ctx.measureText(candidate).width <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (!lines.length || currentLine) {
      lines.push(currentLine);
    }

    if (ctx.measureText(word).width <= maxWidth) {
      currentLine = word;
      continue;
    }

    const chunks = splitLongToken(ctx, word, maxWidth);
    currentLine = chunks.shift() || "";
    lines.push(...chunks.slice(0, -1));
    currentLine = chunks[chunks.length - 1] || currentLine;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length ? lines : [""];
}

function wrapText(ctx, text, maxWidth) {
  const paragraphs = String(text || "")
    .replace(/\r/g, "")
    .split("\n");
  const lines = [];

  for (const paragraph of paragraphs) {
    lines.push(...wrapParagraph(ctx, paragraph.trim(), maxWidth));
  }

  return lines.filter((line) => line.trim());
}

function fitTextBlock(ctx, options) {
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
    setFont(ctx, fontSize);
    const transformedText = transformText(preparedText, textTransform);
    const lines = wrapText(ctx, transformedText, maxWidth);
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
  setFont(ctx, fallbackFontSize);
  return {
    fontSize: fallbackFontSize,
    lineHeight: (originalLineHeight || originalFontSize * 1.22) * (fallbackFontSize / originalFontSize),
    lines: wrapText(ctx, transformText(preparedText, textTransform), maxWidth).slice(0, maxLines),
  };
}

function drawTextBlock(ctx, node, layout) {
  ctx.save();
  ctx.fillStyle = node.color;
  ctx.textAlign = node.align;
  ctx.textBaseline = "alphabetic";
  setFont(ctx, layout.fontSize);

  for (let index = 0; index < layout.lines.length; index += 1) {
    const lineY = node.y + index * layout.lineHeight;
    ctx.fillText(layout.lines[index], node.x, lineY);
  }

  ctx.restore();
}

function prepareSubtitleText(rawText) {
  return String(rawText || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[:|]\s*/g, "\n")
    .trim();
}

function parseTextNode(node) {
  const localTransform = node.meta?.ux?.localTransform || {};
  const rangedStyle = node.meta?.ux?.rangedStyles?.[0] || {};

  return {
    name: node.name || "",
    text: node.text?.rawText || "",
    x: typeof localTransform.tx === "number" ? localTransform.tx : 0,
    y: typeof localTransform.ty === "number" ? localTransform.ty : 0,
    fontSize: node.style?.font?.size || rangedStyle.fontSize || 80,
    lineHeight: getLineHeight(node),
    color: colorToCss(node.style?.fill?.color?.value),
    align: node.style?.textAttributes?.paragraphAlign || "left",
    textTransform: rangedStyle.textTransform || "none",
    lineCount: getTextLines(node.text?.rawText || "").length,
  };
}

function parseShapeNode(node, index) {
  const localTransform = node.meta?.ux?.localTransform || {};
  const patternMeta = node.style?.fill?.pattern?.meta?.ux || {};

  return {
    index,
    name: node.name || "",
    x: typeof localTransform.tx === "number" ? localTransform.tx : 0,
    y: typeof localTransform.ty === "number" ? localTransform.ty : 0,
    width: node.shape?.width || 0,
    height: node.shape?.height || 0,
    opacity: typeof node.style?.opacity === "number" ? node.style.opacity : 1,
    resourceKey: patternMeta.uid || null,
  };
}

function getTemplateWidth(node) {
  const centeredWidth = 2 * Math.min(node.x - 40, CANVAS_WIDTH - node.x - 40);
  return clamp(centeredWidth, 700, 1120);
}

function buildTemplate(ctx, zip, artboardEntry, manifestArtboard) {
  const contentPath = `artwork/${manifestArtboard.path}/graphics/graphicContent.agc`;
  const agc = JSON.parse(zip.readAsText(contentPath));
  const children = agc.children?.[0]?.artboard?.children || [];
  const textNodes = children
    .filter((node) => node.type === "text")
    .map((node) => parseTextNode(node));
  const contentNodes = textNodes.filter(
    (node) => normalizeKey(node.text) !== normalizeKey(TITLE_TEXT),
  );

  if (contentNodes.length < 2) {
    return null;
  }

  const sortedByY = [...contentNodes].sort((left, right) => left.y - right.y);
  const courseNode = sortedByY[0];
  const subtitleNode = sortedByY[sortedByY.length - 1];
  const titleNode =
    textNodes.find((node) => normalizeKey(node.text) === normalizeKey(TITLE_TEXT)) || null;

  const originalCourseLines = getTextLines(courseNode.text);
  const originalSubtitleLines = getTextLines(subtitleNode.text);
  const measuredCourseWidths = measureLines(
    ctx,
    originalCourseLines,
    courseNode.fontSize,
    courseNode.textTransform,
  );
  const measuredSubtitleWidths = measureLines(
    ctx,
    originalSubtitleLines,
    subtitleNode.fontSize,
    subtitleNode.textTransform,
  );
  const courseLineHeight = courseNode.lineHeight || courseNode.fontSize * 1.22;
  const subtitleLineHeight = subtitleNode.lineHeight || subtitleNode.fontSize * 1.22;
  const shapes = dedupeShapes(
    children
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.type === "shape" && node.style?.fill?.type === "pattern")
      .map(({ node, index }) => parseShapeNode(node, index)),
  );

  return {
    id: manifestArtboard.path,
    artboardName: manifestArtboard.name,
    courseName: courseNode.text.trim(),
    courseKey: normalizeKey(courseNode.text),
    courseNode: {
      ...courseNode,
      maxWidth: clamp(
        Math.max(Math.max(...measuredCourseWidths, 0) * 1.08, getTemplateWidth(courseNode)),
        700,
        1120,
      ),
      maxHeight: Math.max(
        220,
        (Math.max(originalCourseLines.length, 1) - 1) * courseLineHeight + courseNode.fontSize + 48,
      ),
      maxLines: Math.max(originalCourseLines.length, 2),
      minFontSize: Math.max(74, Math.round(courseNode.fontSize * 0.52)),
    },
    subtitleNode: {
      ...subtitleNode,
      maxWidth: clamp(
        Math.max(Math.max(...measuredSubtitleWidths, 0) * 1.08, getTemplateWidth(subtitleNode) - 60),
        820,
        1080,
      ),
      maxHeight: Math.max(
        320,
        (Math.max(originalSubtitleLines.length, 1) - 1) * subtitleLineHeight +
          subtitleNode.fontSize +
          44,
      ),
      maxLines: Math.max(originalSubtitleLines.length + 1, 3),
      minFontSize: Math.max(54, Math.round(subtitleNode.fontSize * 0.52)),
    },
    titleNode,
    shapes,
  };
}

class ThumbnailEngine {
  constructor(options = {}) {
    this.xdPath = options.xdPath || path.join(__dirname, "ap.xd");
    this.fallbackCourseKey = normalizeKey(options.fallbackCourseName || "Modern physics");
    this.cache = null;
    ensureFontRegistered();
  }

  ensureLoaded() {
    const stats = fs.statSync(this.xdPath);

    if (this.cache && this.cache.mtimeMs === stats.mtimeMs) {
      return;
    }

    const zip = new AdmZip(this.xdPath);
    const manifest = JSON.parse(zip.readAsText("manifest"));
    const artwork = manifest.children.find((entry) => entry.name === "artwork");
    const artboards = artwork.children.filter((entry) => entry.path.startsWith("artboard-"));
    const ctx = createMeasureContext();
    const templates = [];
    const resources = new Map();

    for (const artboard of artboards) {
      const template = buildTemplate(ctx, zip, artboard.path, artboard);

      if (template) {
        templates.push(template);
      }
    }

    for (const template of templates) {
      for (const shape of template.shapes) {
        if (!shape.resourceKey || resources.has(shape.resourceKey)) {
          continue;
        }

        const resourceEntry =
          zip.getEntry(`resources/${shape.resourceKey}`) || zip.getEntry(shape.resourceKey);

        if (resourceEntry) {
          resources.set(shape.resourceKey, resourceEntry.getData());
        }
      }
    }

    this.cache = {
      mtimeMs: stats.mtimeMs,
      templates,
      resources,
    };
  }

  getTemplates() {
    this.ensureLoaded();
    return this.cache.templates;
  }

  findTemplate(courseName) {
    const desiredKey = normalizeKey(courseName);
    const templates = this.getTemplates();

    let template = templates.find((entry) => entry.courseKey === desiredKey);

    if (template) {
      return { template, matchedExactly: true };
    }

    template = templates.find(
      (entry) =>
        desiredKey.includes(entry.courseKey) || entry.courseKey.includes(desiredKey),
    );

    if (template) {
      return { template, matchedExactly: false };
    }

    template =
      templates.find((entry) => entry.courseKey === this.fallbackCourseKey) || templates[0] || null;

    if (!template) {
      throw new Error("No usable templates were found in ap.xd.");
    }

    return { template, matchedExactly: false, usedFallback: true };
  }

  async drawShapes(ctx, shapes) {
    for (const shape of shapes) {
      if (!shape.resourceKey) {
        continue;
      }

      const buffer = this.cache.resources.get(shape.resourceKey);

      if (!buffer) {
        continue;
      }

      const image = await loadImage(buffer);
      ctx.save();
      ctx.globalAlpha = shape.opacity;
      ctx.drawImage(image, shape.x, shape.y, shape.width, shape.height);
      ctx.restore();
    }
  }

  async renderThumbnail(input) {
    const courseName = String(input.courseName || "").trim();
    const lessonTitle = String(input.lessonTitle || "").trim();

    if (!courseName || !lessonTitle) {
      throw new Error("Both courseName and lessonTitle are required to render a thumbnail.");
    }

    this.ensureLoaded();
    const { template, matchedExactly, usedFallback } = this.findTemplate(courseName);
    const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    await this.drawShapes(ctx, template.shapes);

    if (template.titleNode) {
      drawTextBlock(ctx, template.titleNode, {
        fontSize: template.titleNode.fontSize,
        lineHeight: template.titleNode.lineHeight || template.titleNode.fontSize * 1.2,
        lines: [template.titleNode.text],
      });
    }

    const courseLayout = fitTextBlock(ctx, {
      rawText: courseName,
      originalFontSize: template.courseNode.fontSize,
      originalLineHeight: template.courseNode.lineHeight || template.courseNode.fontSize * 1.22,
      minFontSize: template.courseNode.minFontSize,
      maxWidth: template.courseNode.maxWidth,
      maxHeight: template.courseNode.maxHeight,
      maxLines: template.courseNode.maxLines,
      textTransform: template.courseNode.textTransform,
      preprocess: (value) => String(value || "").replace(/\s+/g, " ").trim(),
    });

    const subtitleLayout = fitTextBlock(ctx, {
      rawText: lessonTitle,
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

    drawTextBlock(ctx, template.courseNode, courseLayout);
    drawTextBlock(ctx, template.subtitleNode, subtitleLayout);

    return {
      buffer: await canvas.encode("png"),
      template: {
        artboardName: template.artboardName,
        courseName: template.courseName,
        usedFallback: Boolean(usedFallback),
        matchedExactly,
      },
      layout: {
        courseFontSize: courseLayout.fontSize,
        subtitleFontSize: subtitleLayout.fontSize,
        subtitleLines: subtitleLayout.lines,
      },
    };
  }
}

module.exports = {
  ThumbnailEngine,
  normalizeKey,
};
