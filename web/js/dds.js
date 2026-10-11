// DDS parsing and WebGL2 upload. Block-compressed data goes to the GPU as is (S3TC / RGTC / BPTC extensions),
// so the viewer samples exactly the bytes the game samples. *_SRGB formats use the sRGB internal formats, which the
// GPU decodes on sampling - the same thing D3D does for them.

const DXGI = {
  71: ['bc1', false], 72: ['bc1', true], 74: ['bc2', false], 75: ['bc2', true], 77: ['bc3', false], 78: ['bc3', true],
  80: ['bc4', false], 81: ['bc4s', false], 83: ['bc5', false], 84: ['bc5s', false], 95: ['bc6u', false],
  96: ['bc6s', false], 98: ['bc7', false], 99: ['bc7', true], 28: ['rgba8', false], 29: ['rgba8', true],
  87: ['bgra8', false], 91: ['bgra8', true], 88: ['bgrx8', false], 93: ['bgrx8', true], 61: ['r8', false],
  65: ['a8', false], 49: ['rg8', false], 2: ['rgba32f', false], 10: ['rgba16f', false], 85: ['b5g6r5', false],
};
const FOURCC = { DXT1: 'bc1', DXT2: 'bc2', DXT3: 'bc2', DXT4: 'bc3', DXT5: 'bc3', ATI1: 'bc4', BC4U: 'bc4',
  BC4S: 'bc4s', ATI2: 'bc5', BC5U: 'bc5', BC5S: 'bc5s' };
const BLOCK = { bc1: 8, bc4: 8, bc4s: 8, bc2: 16, bc3: 16, bc5: 16, bc5s: 16, bc6u: 16, bc6s: 16, bc7: 16 };

export function parseDDS(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x20534444) throw new Error('not a DDS file');
  const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
  const mips = Math.max(1, dv.getUint32(28, true));
  const pfFlags = dv.getUint32(80, true);
  const fourcc = String.fromCharCode(dv.getUint8(84), dv.getUint8(85), dv.getUint8(86), dv.getUint8(87));
  const caps2 = dv.getUint32(112, true);
  let fmt = null, srgb = false, offset = 128, cube = (caps2 & 0x200) !== 0, dxgi = null;
  if ((pfFlags & 4) && fourcc === 'DX10') {
    dxgi = dv.getUint32(128, true);
    const misc = dv.getUint32(136, true);
    cube = cube || (misc & 4) !== 0;
    offset = 148;
    const f = DXGI[dxgi];
    if (!f) throw new Error('unsupported DXGI format ' + dxgi);
    [fmt, srgb] = f;
  } else if (pfFlags & 4) {
    fmt = FOURCC[fourcc];
    if (!fmt) throw new Error('unsupported FourCC ' + fourcc);
  } else {
    const bits = dv.getUint32(88, true), rm = dv.getUint32(92, true), gm = dv.getUint32(96, true);
    const bm = dv.getUint32(100, true), am = dv.getUint32(104, true);
    if (bits === 32 && rm === 0xff0000) fmt = am ? 'bgra8' : 'bgrx8';
    else if (bits === 32 && rm === 0xff) fmt = 'rgba8';
    else if (bits === 24 && rm === 0xff0000) fmt = 'bgr8';
    else if (bits === 8 && (pfFlags & 2) && !(pfFlags & 0x20000)) fmt = 'a8';
    else if (bits === 8) fmt = 'r8';
    else if (bits === 16 && rm === 0xf800) fmt = 'b5g6r5';
    else throw new Error(`unsupported uncompressed DDS (${bits} bit, masks ${rm.toString(16)}/${gm.toString(16)}/${bm.toString(16)})`);
  }
  return { w, h, mips, fmt, srgb, cube, offset, buf, dxgi, fourcc };
}

function levelSize(fmt, w, h) {
  const b = BLOCK[fmt];
  if (b) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * b;
  const bpp = { rgba8: 4, bgra8: 4, bgrx8: 4, bgr8: 3, r8: 1, a8: 1, rg8: 2, rgba32f: 16, rgba16f: 8, b5g6r5: 2 }[fmt];
  return w * h * bpp;
}

const EXT = new WeakMap();                    // extensions are per context (the preview renderer has its own)
function exts(gl) {
  if (!EXT.has(gl)) EXT.set(gl, {
    s3tc: gl.getExtension('WEBGL_compressed_texture_s3tc'),
    s3tcSrgb: gl.getExtension('WEBGL_compressed_texture_s3tc_srgb'),
    rgtc: gl.getExtension('EXT_texture_compression_rgtc'),
    bptc: gl.getExtension('EXT_texture_compression_bptc'),
    aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
  });
  return EXT.get(gl);
}

function glFormat(gl, fmt, srgb) {
  const e = exts(gl);
  const need = (x, n) => { if (!x) throw new Error(`this browser/GPU lacks ${n}`); return x; };
  switch (fmt) {
    case 'bc1': return srgb ? need(e.s3tcSrgb, 'sRGB S3TC').COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT : need(e.s3tc, 'S3TC').COMPRESSED_RGBA_S3TC_DXT1_EXT;
    case 'bc2': return srgb ? need(e.s3tcSrgb, 'sRGB S3TC').COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT : need(e.s3tc, 'S3TC').COMPRESSED_RGBA_S3TC_DXT3_EXT;
    case 'bc3': return srgb ? need(e.s3tcSrgb, 'sRGB S3TC').COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT : need(e.s3tc, 'S3TC').COMPRESSED_RGBA_S3TC_DXT5_EXT;
    case 'bc4': return need(e.rgtc, 'RGTC').COMPRESSED_RED_RGTC1_EXT;
    case 'bc4s': return need(e.rgtc, 'RGTC').COMPRESSED_SIGNED_RED_RGTC1_EXT;
    case 'bc5': return need(e.rgtc, 'RGTC').COMPRESSED_RED_GREEN_RGTC2_EXT;
    case 'bc5s': return need(e.rgtc, 'RGTC').COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT;
    case 'bc6u': return need(e.bptc, 'BPTC').COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT;
    case 'bc6s': return need(e.bptc, 'BPTC').COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT;
    case 'bc7': return srgb ? need(e.bptc, 'BPTC').COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT : need(e.bptc, 'BPTC').COMPRESSED_RGBA_BPTC_UNORM_EXT;
  }
  return null;
}

// Expand uncompressed formats to RGBA8 (or keep float) for upload.
function expand(fmt, data, w, h) {
  const n = w * h, out = new Uint8Array(n * 4);
  if (fmt === 'rgba8') return data;
  for (let i = 0; i < n; i++) {
    switch (fmt) {
      case 'bgra8': out[i * 4] = data[i * 4 + 2]; out[i * 4 + 1] = data[i * 4 + 1]; out[i * 4 + 2] = data[i * 4]; out[i * 4 + 3] = data[i * 4 + 3]; break;
      case 'bgrx8': out[i * 4] = data[i * 4 + 2]; out[i * 4 + 1] = data[i * 4 + 1]; out[i * 4 + 2] = data[i * 4]; out[i * 4 + 3] = 255; break;
      case 'bgr8': out[i * 4] = data[i * 3 + 2]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3]; out[i * 4 + 3] = 255; break;
      case 'r8': out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i]; out[i * 4 + 3] = 255; break;
      case 'a8': out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255; out[i * 4 + 3] = data[i]; break;
      case 'rg8': out[i * 4] = data[i * 2]; out[i * 4 + 1] = data[i * 2 + 1]; out[i * 4 + 2] = 0; out[i * 4 + 3] = 255; break;
      case 'b5g6r5': {
        const v = data[i * 2] | (data[i * 2 + 1] << 8);
        out[i * 4] = ((v >> 11) & 31) * 255 / 31; out[i * 4 + 1] = ((v >> 5) & 63) * 255 / 63; out[i * 4 + 2] = (v & 31) * 255 / 31; out[i * 4 + 3] = 255; break;
      }
    }
  }
  return out;
}

// Upload; returns {tex, info}. opts: {wrapS, wrapT}
export function uploadDDS(gl, buf, opts = {}) {
  const d = parseDDS(buf);
  const target = d.cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
  const tex = gl.createTexture();
  gl.bindTexture(target, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  // colour slots are read through an sRGB view like the game does (engine-notes §2), whatever the file's format says
  const srgb = d.srgb || (!!opts.srgb && !['bc4', 'bc4s', 'bc5', 'bc5s', 'bc6u', 'bc6s'].includes(d.fmt));
  const cfmt = glFormat(gl, d.fmt, srgb);
  const faces = d.cube ? 6 : 1;
  // opts.maxSize (the quality tier's texture cap): the levels larger than it are skipped, the next one is level 0
  let skip = 0;
  if (opts.maxSize && !d.cube) while (skip < d.mips - 1 && Math.max(d.w >> skip, d.h >> skip) > opts.maxSize) skip++;
  let off = d.offset, levels = 0, bytes = 0;
  const u8 = new Uint8Array(buf);
  for (let f = 0; f < faces; f++) {
    let w = d.w, h = d.h;
    for (let m = 0; m < d.mips; m++) {
      const size = levelSize(d.fmt, w, h);
      if (off + size > u8.length) break;
      if (m < skip) { off += size; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); continue; }
      const face = d.cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + f : gl.TEXTURE_2D, lv = m - skip;
      const data = u8.subarray(off, off + size);
      if (cfmt) gl.compressedTexImage2D(face, lv, cfmt, w, h, 0, data);
      else if (d.fmt === 'rgba16f') gl.texImage2D(face, lv, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(buf, off, w * h * 4));
      else if (d.fmt === 'rgba32f') gl.texImage2D(face, lv, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, new Float32Array(buf.slice(off, off + size)));
      else gl.texImage2D(face, lv, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, expand(d.fmt, data, w, h));
      bytes += cfmt || d.fmt === 'rgba32f' ? size : w * h * (d.fmt === 'rgba16f' ? 8 : 4);     // GPU storage
      off += size;
      if (f === 0) levels = lv + 1;
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
  }
  gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, Math.max(0, levels - 1));
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (d.cube) {
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  } else {
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, opts.wrapS ?? gl.REPEAT);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, opts.wrapT ?? gl.REPEAT);
    const e = exts(gl);
    if (e.aniso && !opts.lookup) gl.texParameterf(target, e.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  }
  return { tex, info: { w: d.w, h: d.h, capped: skip, mips: levels, fmt: d.fmt, srgb: d.srgb, srgbView: srgb, cube: d.cube, dxgi: d.dxgi, fourcc: d.fourcc, bytes } };
}

export function solidTexture(gl, rgba, cube = false) {
  const tex = gl.createTexture();
  const target = cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
  gl.bindTexture(target, tex);
  const px = new Uint8Array(rgba);
  for (let f = 0; f < (cube ? 6 : 1); f++)
    gl.texImage2D(cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + f : gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return tex;
}
