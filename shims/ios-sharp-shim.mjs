// sharp-compatible facade backed by the packaged ImageIO/CoreGraphics helper on iOS.
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);
const DEFAULT_HELPER = "/var/jb/usr/local/bin/dsh-image-tool";
const helperPath = process.env.DSH_IOS_IMAGE_TOOL ?? DEFAULT_HELPER;

function readU32BE(buffer, offset) {
  return (
    (buffer[offset] << 24) |
    (buffer[offset + 1] << 16) |
    (buffer[offset + 2] << 8) |
    buffer[offset + 3]
  ) >>> 0;
}

function readU16BE(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1];
}

function readU16LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8);
}

function readU32LE(buffer, offset) {
  return (
    buffer[offset] |
    (buffer[offset + 1] << 8) |
    (buffer[offset + 2] << 16) |
    (buffer[offset + 3] << 24)
  ) >>> 0;
}

function pngInfo(data) {
  if (data.length < 26) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => data[index] === byte)) return null;
  if (data.toString("latin1", 12, 16) !== "IHDR") return null;
  return {
    format: "png",
    width: readU32BE(data, 16),
    height: readU32BE(data, 20),
    bitDepth: data[24],
    colorType: data[25],
  };
}

function jpegInfo(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let index = 2;
  while (index + 4 <= data.length) {
    if (data[index] !== 0xff) {
      index += 1;
      continue;
    }
    const marker = data[index + 1];
    if (marker === 0xff) {
      index += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2;
      continue;
    }
    const length = readU16BE(data, index + 2);
    if (length < 2) break;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc &&
      index + 9 <= data.length
    ) {
      return {
        format: "jpeg",
        width: readU16BE(data, index + 7),
        height: readU16BE(data, index + 5),
      };
    }
    index += 2 + length;
  }
  return null;
}

function webpInfo(data) {
  if (data.length < 16) return null;
  if (
    data.toString("latin1", 0, 4) !== "RIFF" ||
    data.toString("latin1", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunk = data.toString("latin1", 12, 16);
  if (chunk === "VP8 " && data.length >= 30) {
    return {
      format: "webp",
      width: readU16LE(data, 26) & 0x3fff,
      height: readU16LE(data, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && data.length >= 25) {
    const bits = readU32LE(data, 21);
    return {
      format: "webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X" && data.length >= 30) {
    return {
      format: "webp",
      width: (data[24] | (data[25] << 8) | (data[26] << 16)) + 1,
      height: (data[27] | (data[28] << 8) | (data[29] << 16)) + 1,
    };
  }
  return null;
}

function gifInfo(data) {
  if (data.length < 13) return null;
  const signature = data.toString("latin1", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return {
    format: "gif",
    width: readU16LE(data, 6),
    height: readU16LE(data, 8),
  };
}

function inspect(data) {
  return pngInfo(data) ?? jpegInfo(data) ?? webpInfo(data) ?? gifInfo(data);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function validatePng(data, metadata) {
  let offset = 8;
  const idat = [];
  let sawEnd = false;
  while (offset + 8 <= data.length) {
    const length = readU32BE(data, offset);
    if (offset + 12 + length > data.length) throw new Error("PNG chunk overruns file");
    const type = data.toString("latin1", offset + 4, offset + 8);
    const payload = data.subarray(offset + 8, offset + 8 + length);
    const actualCrc = crc32(data.subarray(offset + 4, offset + 8 + length));
    const expectedCrc = readU32BE(data, offset + 8 + length);
    if (actualCrc !== expectedCrc) throw new Error(`PNG chunk ${type} CRC mismatch`);
    if (type === "IDAT") idat.push(Buffer.from(payload));
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset += 12 + length;
  }
  if (!sawEnd) throw new Error("PNG missing IEND");
  if (idat.length === 0) throw new Error("PNG missing IDAT");
  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    throw new Error("PNG IDAT inflate failed");
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[metadata.colorType];
  if (channels === undefined) throw new Error("PNG unsupported color type");
  if (metadata.bitDepth < 8) return inflated;
  const bytesPerPixel = channels * (metadata.bitDepth / 8);
  const expectedLength = metadata.height * (1 + metadata.width * bytesPerPixel);
  if (inflated.length !== expectedLength) {
    throw new Error(`PNG raster size mismatch (${inflated.length} != ${expectedLength})`);
  }
  return inflated;
}

function validateJpeg(data) {
  let index = 2;
  let sawScan = false;
  while (index < data.length) {
    if (data[index] !== 0xff) throw new Error("JPEG lost marker sync");
    let marker = data[index + 1];
    while (marker === 0xff) {
      index += 1;
      marker = data[index + 1];
    }
    if (marker === 0xd9) return Buffer.from(data);
    if (marker === 0xda) {
      sawScan = true;
      index += 2;
      while (index + 1 < data.length) {
        if (data[index] === 0xff) {
          if (data[index + 1] !== 0x00 && data[index + 1] !== 0xff) break;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2;
      continue;
    }
    const length = readU16BE(data, index + 2);
    if (length < 2) throw new Error("JPEG bogus segment length");
    index += 2 + length;
  }
  if (!sawScan) throw new Error("JPEG missing SOS");
  throw new Error("JPEG missing EOI");
}

function validateWebp(data) {
  const riffSize = readU32LE(data, 4);
  if (riffSize + 8 > data.length + 1) throw new Error("WebP RIFF size mismatch");
  let offset = 12;
  while (offset + 8 <= data.length) {
    const chunk = data.toString("latin1", offset, offset + 4);
    const size = readU32LE(data, offset + 4);
    if (offset + 8 + size > data.length) throw new Error(`WebP chunk ${chunk} overruns file`);
    if (chunk === "VP8 " || chunk === "VP8L" || chunk === "VP8X") return Buffer.from(data);
    offset += 8 + size + (size & 1);
  }
  throw new Error("WebP missing image chunk");
}

function skipGifSubBlocks(data, initialOffset) {
  let offset = initialOffset;
  while (offset < data.length && data[offset] !== 0) {
    offset += 1 + data[offset];
    if (offset > data.length) throw new Error("GIF sub-block overruns file");
  }
  return offset + 1;
}

function validateGif(data) {
  let offset = 13;
  if (data[10] & 0x80) offset += 3 * (1 << ((data[10] & 7) + 1));
  while (offset < data.length) {
    const code = data[offset];
    if (code === 0x3b) return Buffer.from(data);
    if (code === 0x21) {
      offset = skipGifSubBlocks(data, offset + 2);
      continue;
    }
    if (code === 0x2c) {
      offset += 9;
      if (offset >= data.length) throw new Error("GIF descriptor overruns file");
      const packed = data[offset];
      offset += 1;
      if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
      offset = skipGifSubBlocks(data, offset + 1);
      continue;
    }
    throw new Error("GIF unknown block");
  }
  throw new Error("GIF missing trailer");
}

function validate(data, metadata) {
  switch (metadata.format) {
    case "png":
      return validatePng(data, metadata);
    case "jpeg":
      return validateJpeg(data);
    case "webp":
      return validateWebp(data);
    case "gif":
      return validateGif(data);
    default:
      throw new Error("unsupported image format");
  }
}

function fallbackMetadata(buffer) {
  const metadata = inspect(buffer);
  if (metadata === null) throw new Error("Input buffer contains unsupported image format");
  const hasAlpha = metadata.format === "png"
    ? metadata.colorType === 4 || metadata.colorType === 6
    : false;
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    pages: 1,
    depth: "uchar",
    space: "srgb",
    hasAlpha,
  };
}

async function hasNativeHelper() {
  try {
    await access(helperPath);
    return true;
  } catch (error) {
    if (process.platform === "ios") {
      throw new Error(`required iOS image helper is missing at ${helperPath}`, { cause: error });
    }
    return false;
  }
}

function transformationArguments(state) {
  const args = [];
  if (state.rotate) args.push("--rotate", "1");
  if (state.resize !== undefined) {
    if (state.resize.width !== undefined) args.push("--width", String(state.resize.width));
    if (state.resize.height !== undefined) args.push("--height", String(state.resize.height));
    if (state.resize.withoutEnlargement) args.push("--without-enlargement", "1");
    if (state.resize.kernel !== undefined) args.push("--kernel", String(state.resize.kernel));
  }
  return args;
}

async function runNative(buffer, operation, state = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-image-"));
  const input = join(directory, "input");
  const output = join(directory, "output");
  try {
    await writeFile(input, buffer, { mode: 0o600 });
    const args = [operation, "--input", input];
    if (operation !== "metadata") args.push("--output", output, ...transformationArguments(state));
    if (operation === "encode") {
      args.push("--format", state.format);
      if (state.encoding?.quality !== undefined) {
        args.push("--quality", String(state.encoding.quality));
      }
    }
    const { stdout } = await execFileAsync(helperPath, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const info = JSON.parse(stdout);
    return operation === "metadata" ? { info } : { data: await readFile(output), info };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

class IOSSharpPipeline {
  constructor(data, options = {}, state = {}) {
    this.buffer = Buffer.from(data);
    this.options = { ...options };
    this.state = { ...state };
  }

  clone() {
    return new IOSSharpPipeline(this.buffer, this.options, {
      ...this.state,
      resize: this.state.resize === undefined ? undefined : { ...this.state.resize },
      encoding: this.state.encoding === undefined ? undefined : { ...this.state.encoding },
    });
  }

  rotate() {
    this.state.rotate = true;
    return this;
  }

  toColourspace(colourspace) {
    if (colourspace !== "srgb") throw new Error(`unsupported iOS output colourspace: ${colourspace}`);
    this.state.colourspace = colourspace;
    return this;
  }

  resize(options) {
    this.state.resize = { ...options };
    return this;
  }

  raw() {
    this.state.format = "raw";
    this.state.encoding = undefined;
    return this;
  }

  png(options = {}) {
    this.state.format = "png";
    this.state.encoding = { ...options };
    return this;
  }

  jpeg(options = {}) {
    this.state.format = "jpeg";
    this.state.encoding = { ...options };
    return this;
  }

  webp(options = {}) {
    this.state.format = "webp";
    this.state.encoding = { ...options };
    return this;
  }

  async metadata() {
    if (await hasNativeHelper()) return (await runNative(this.buffer, "metadata")).info;
    return fallbackMetadata(this.buffer);
  }

  async toBuffer(options = {}) {
    const fallback = inspect(this.buffer);
    if (!(await hasNativeHelper())) {
      if (fallback === null) throw new Error("Input buffer contains unsupported image format");
      const data = validate(this.buffer, fallback);
      if (options.resolveWithObject) {
        return {
          data,
          info: { width: fallback.width, height: fallback.height, channels: 4 },
        };
      }
      return data;
    }

    if (this.state.format === "webp") {
      throw new Error("WebP output is unavailable in the iOS ImageIO backend");
    }
    const operation = this.state.format === "raw" || this.state.format === undefined
      ? "raw"
      : "encode";
    const result = await runNative(this.buffer, operation, this.state);
    return options.resolveWithObject ? result : result.data;
  }
}

function sharp(data, options) {
  return new IOSSharpPipeline(data, options);
}

sharp.kernel = Object.freeze({ nearest: "nearest" });

export default sharp;
