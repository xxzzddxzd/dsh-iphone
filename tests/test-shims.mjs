#!/usr/bin/env node

import assert from "node:assert/strict";
import zlib from "node:zlib";
import sharp from "../shims/ios-sharp-shim.mjs";
import koffi from "../shims/ios-koffi-stub.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + payload.length);
  output.writeUInt32BE(payload.length, 0);
  typeBytes.copy(output, 4);
  payload.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 8 + payload.length);
  return output;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk("IHDR", header),
  pngChunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
  pngChunk("IEND", Buffer.alloc(0)),
]);
const image = sharp(png, { failOn: "error", limitInputPixels: 1 });
assert.deepEqual(await image.metadata(), {
  format: "png",
  width: 1,
  height: 1,
  pages: 1,
  depth: "uchar",
  space: "srgb",
  hasAlpha: true,
});
await assert.doesNotReject(() => image.raw().toBuffer());
assert.deepEqual(sharp.kernel, { nearest: "nearest" });
await assert.doesNotReject(() => image.clone()
  .rotate()
  .toColourspace("srgb")
  .resize({ width: 1, height: 1, kernel: sharp.kernel.nearest })
  .raw()
  .toBuffer({ resolveWithObject: true }));
await assert.rejects(() => sharp(Buffer.from("not an image")).metadata());

const pointer = koffi.pointer("void");
const structure = koffi.struct("TEST", { value: "uint32" });
assert.equal(pointer.size, undefined);
assert.equal(structure.size, undefined);
assert.throws(() => koffi.load("kernel32.dll"), /unavailable on iOS/);

console.log("iOS sharp and koffi shim checks passed");
