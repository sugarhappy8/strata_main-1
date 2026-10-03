"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const IMAGES = join(ROOT, "public", "images");
const css = readFileSync(join(ROOT, "public", "styles", "styles.css"), "utf8");
const FORMATS = [
  ["avif", "image/avif"],
  ["webp", "image/webp"],
  ["jpg", "image/jpeg"],
];
// The phone frame is a full-height crop; the wide frame is the whole photo.
const FRAMES = {
  phone: { name: "hero-training-960", width: 960, height: 1467, maxBytes: 100_000 },
  wide: { name: "hero-training-1600", width: 1600, height: 1067, maxBytes: 120_000 },
};

/** Blocks at one nesting level of a stylesheet, without comments: [{ prelude, body }]. */
function blocks(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, ""),
    found = [];
  let depth = 0,
    start = 0,
    open = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") {
      if (depth === 0) open = index;
      depth += 1;
    } else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        found.push({
          prelude: text.slice(start, open).trim(),
          body: text.slice(open + 1, index),
        });
        start = index + 1;
      }
    }
  }
  return found;
}
function heroImages(list) {
  return list
    .filter((block) => block.prelude === ".hero-media")
    .flatMap((block) =>
      [...block.body.matchAll(/background-image:\s*([^;]+);/g)].map((match) =>
        match[1].replace(/\s+/g, " ").trim(),
      ),
    );
}
function expectedImages(frame) {
  const sources = FORMATS.map(
    ([extension, type]) => `url("/images/${frame}.${extension}") type("${type}")`,
  );
  return [`url("/images/${frame}.jpg")`, `image-set( ${sources.join(", ")} )`];
}

function dimensions(body, extension) {
  if (extension === "jpg") {
    for (let offset = 2; offset < body.length;) {
      const marker = body[offset + 1],
        length = body.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc2)
        return { width: body.readUInt16BE(offset + 7), height: body.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  if (extension === "webp" && body.toString("ascii", 12, 16) === "VP8 ")
    return { width: body.readUInt16LE(26) & 0x3fff, height: body.readUInt16LE(28) & 0x3fff };
  if (extension === "avif") {
    const ispe = body.indexOf("ispe");
    if (ispe > 0)
      return { width: body.readUInt32BE(ispe + 8), height: body.readUInt32BE(ispe + 12) };
  }
  return null;
}

test("the hero names the wide frame as AVIF, WebP, then JPEG after a plain JPEG fallback", () => {
  const top = blocks(css);
  assert.deepEqual(heroImages(top), expectedImages(FRAMES.wide.name));
  const phoneQueries = top.filter((block) => block.prelude === "@media (max-width: 560px)");
  assert.deepEqual(
    phoneQueries.flatMap((block) => heroImages(blocks(block.body))),
    expectedImages(FRAMES.phone.name),
    "the phone media query must name the phone frame in every format, with its type",
  );
  for (const block of top.filter((item) => item.prelude.startsWith("@media")))
    if (block.prelude !== "@media (max-width: 560px)")
      assert.deepEqual(
        heroImages(blocks(block.body)),
        [],
        `${block.prelude} must not swap the photo`,
      );
  const tablet = top.find((block) => block.prelude === "@media (max-width: 800px)");
  assert.match(
    blocks(tablet.body).find((block) => block.prelude === ".hero-media")?.body || "",
    /background-position:\s*65% center;/,
    "the phone crop is taken 65% across, matching the position phones use",
  );
});

test("each hero frame ships the same picture as a small AVIF, WebP and JPEG", () => {
  const signatures = {
    avif: (body) => body.toString("ascii", 4, 12) === "ftypavif",
    webp: (body) =>
      body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP",
    jpg: (body) => body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff,
  };
  for (const frame of Object.values(FRAMES))
    for (const [extension] of FORMATS) {
      const file = `${frame.name}.${extension}`,
        body = readFileSync(join(IMAGES, file));
      assert.ok(signatures[extension](body), `${file} must be a real ${extension} file`);
      assert.deepEqual(
        dimensions(body, extension),
        { width: frame.width, height: frame.height },
        `${file} must keep the frame's crop`,
      );
      assert.ok(body.length > 15_000, `${file} must contain the photograph`);
      assert.ok(
        body.length <= frame.maxBytes,
        `${file} is ${body.length} bytes; its budget is ${frame.maxBytes}`,
      );
    }
});
