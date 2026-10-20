// GLSL ES 3.00 sources for FO4 Lightbox.
//
// Written fresh from docs/engine-notes.md (our own description of how Fallout 4 shades: formulas, constants, pass
// order). No game shader code, bytecode or decompiled output is used here. Section numbers (§) refer to those notes.
//
// Plumbing (performance, no effect on the shading): per-frame values live in the Frame uniform block, per-material
// values in a Material block (one slot per shape, uploaded only when a value changes), skinning palettes in a Bones
// block, and each draw's model matrix arrives as an instanced attribute (locations 8-11), so one draw call places
// every copy of a cell object. The renderer compiles variants: SKINNED (bone palette) and CLIP (alpha test / blend
// discard; opaque shaders without discard keep the GPU's early depth rejection).

export const COMMON = /* glsl */`#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp samplerCube;
precision highp sampler2DShadow;
`;

// Per-frame values (std140; the float offsets are mirrored in renderer.js FR)
const FRAME = `
layout(std140) uniform Frame {
  mat4 uView;
  mat4 uProj;
  mat4 uShadowMat;       // world -> clip of the cell shadow map (static objects, cached)
  mat4 uShadowMat2;      // world -> clip of the character shadow map (drawn each frame it moves)
  vec4 uCamPos;
  vec4 uSunDir;          // unit vector towards the sun (world, Z up)
  vec4 uSunColor;        // linear: linear(WTHR Sunlight) x IMGS Sunlight Scale
  vec4 uAmbRow[3];       // directional ambient as 3 rows (R, G, B) of (ax, ay, az, b), GAMMA space (§5)
  vec4 uFogA;            // near, far, power, max
  vec4 uFogH;            // near height mid, near height range, far height mid, far height range
  vec4 uFogNear;         // rgb; w: high density scale
  vec4 uFogFar;
  vec4 uFogNearHigh;
  vec4 uFogFarHigh;
  vec4 uFlags;           // x: cell shadows, y: character shadows, z: fog, w: placed lights in use
  vec4 uShadowTexel;     // xy: cell map texel, zw: character map texel (uv units)
  vec4 uShadowBias;      // x, y: bias scale of the two maps, z: cell map edge fade (uv)
  vec4 uScreen;          // xy: render target size, z: near, w: far
  vec4 uTint;            // skin tint: gamma rgb + amount (§14)
  vec4 uRes;             // xy: share of the targets the scene covers (1 = all; less while the camera moves on a slow GPU)
  vec4 uCluster;         // placed lights (cell viewer), clustered (uLightGrid): tiles across, tiles down, depth slices,
                         // first cluster texel
  vec4 uClusterZ;        // x: slices per ln(depth / near), y: near, zw: tile size in pixels
  vec4 uClusterI;        // x: first light-index texel, y: specular anti-aliasing on (1)
  mat4 uPrevViewProj;    // TAA: last frame's view-projection without the sub-pixel jitter (motion vectors)
  mat4 uCurViewProj;     // TAA: this frame's, without the jitter
};
`;

const BONES = `
#if SKINNED
layout(std140) uniform Bones { mat4 uBones[MAX_BONES]; };   // bone world (bind or animated) x skin-to-bone
#endif
`;

// ---------------------------------------------------------------------------------------------------------------
// TAA motion vectors: last frame's bone palette of a skinned shape (the current one when TAA is off)
const BONES_PREV = `
#if SKINNED
layout(std140) uniform BonesPrev { mat4 uBonesPrev[MAX_BONES]; };
#endif
`;

export const MESH_VS = COMMON + FRAME + BONES + BONES_PREV + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;    // normal, bitangent, tangent: unsigned 0..1 as the NIF stores them (bytes)
layout(location=2) in vec3 aBitan;     // NIF "bitangent" (X/Y/Z in the 4th components): normal-map red axis
layout(location=3) in vec3 aTan;       // NIF "tangent": normal-map green axis
layout(location=4) in vec2 aUV;
layout(location=5) in vec4 aColor;
layout(location=6) in vec4 aWeights;
layout(location=7) in vec4 aBoneIdx;
layout(location=8) in vec4 iM0;        // model matrix columns, one per instance
layout(location=9) in vec4 iM1;
layout(location=10) in vec4 iM2;
layout(location=11) in vec4 iM3;
out vec3 vWorld; out vec3 vN; out vec3 vBt; out vec3 vT; out vec2 vUV; out vec4 vColor; out vec4 vShadow; out vec4 vShadow2;
out float vViewZ;
out vec4 vCurClip; out vec4 vPrevClip;
uniform mat4 uPrevDelta;      // last frame's placement from this one's (the player group moved / turned; else identity)
void main() {
  mat4 M = mat4(iM0, iM1, iM2, iM3);
  vec4 p = vec4(aPos, 1.0), pp = p; vec3 n = aNormal * 2.0 - 1.0, bt = aBitan * 2.0 - 1.0, ta = aTan * 2.0 - 1.0;
#if SKINNED
  mat4 S = aWeights.x * uBones[int(aBoneIdx.x)] + aWeights.y * uBones[int(aBoneIdx.y)]
         + aWeights.z * uBones[int(aBoneIdx.z)] + aWeights.w * uBones[int(aBoneIdx.w)];
  p = S * p; n = mat3(S) * n; bt = mat3(S) * bt; ta = mat3(S) * ta;
  pp = (aWeights.x * uBonesPrev[int(aBoneIdx.x)] + aWeights.y * uBonesPrev[int(aBoneIdx.y)]
      + aWeights.z * uBonesPrev[int(aBoneIdx.z)] + aWeights.w * uBonesPrev[int(aBoneIdx.w)]) * pp;
#endif
  vec4 w = M * p;
  // NIF transforms scale uniformly, so the upper 3x3 turns normals the right way (the length is normalised later)
  mat3 R = mat3(M);
  vWorld = w.xyz;
  vN = R * n; vBt = R * bt; vT = R * ta;
  vUV = aUV; vColor = aColor;
  // shadow lookups at the surface itself (a lookup moved along the vertex normal put black blotches on the sunlit side
  // of the Vault suit wherever its normals do not follow the surface; the casters' slope-scaled offset keeps the acne away)
  vShadow = uShadowMat * w; vShadow2 = uShadowMat2 * w;
  vec4 vp = uView * w;
  vViewZ = -vp.z;
  gl_Position = uProj * vp;
  // where this vertex is now and was last frame, both without the jitter: the TAA's motion vectors
  vCurClip = uCurViewProj * w; vPrevClip = uPrevViewProj * (uPrevDelta * (M * pp));
}`;

const COMMON_FNS = `
const float PI = 3.14159265;
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 gammaToLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 linearToGamma(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

// §5: rows evaluated on (d, 1) in gamma space, clamped, then ^2.2
vec3 dirAmbient(vec3 d) {
  vec4 h = vec4(d, 1.0);
  return gammaToLinear(vec3(dot(uAmbRow[0], h), dot(uAmbRow[1], h), dot(uAmbRow[2], h)));
}

uniform sampler2DShadow uShadowMap, uShadowMap2;
// 3 x 3 hardware-filtered depth comparisons 5/3 texel apart: about the footprint of a 5 x 5 texel box, smooth
float pcf(sampler2DShadow m, vec3 p, vec2 texel) {
  float s = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++)
    s += texture(m, vec3(p.xy + vec2(float(x), float(y)) * texel * 1.6667, p.z));
  return s * (1.0 / 9.0);
}
float shadowAt(vec4 sc, vec4 sc2, float ndl) {
  float bias = 0.0008 + 0.002 * (1.0 - ndl);
  float v = 1.0;
  if (uFlags.x > 0.5) {
    vec3 p = sc.xyz / sc.w * 0.5 + 0.5;
    if (p.x > 0.0 && p.x < 1.0 && p.y > 0.0 && p.y < 1.0 && p.z <= 1.0) {
      float e = min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y));     // fade out towards the edge of the map
      v = mix(1.0, pcf(uShadowMap, vec3(p.xy, p.z - bias * uShadowBias.x), uShadowTexel.xy), sat(e / uShadowBias.z));
    }
  }
  if (uFlags.y > 0.5) {
    vec3 p = sc2.xyz / sc2.w * 0.5 + 0.5;
    if (p.x > 0.0 && p.x < 1.0 && p.y > 0.0 && p.y < 1.0 && p.z <= 1.0)
      v *= pcf(uShadowMap2, vec3(p.xy, p.z - bias * uShadowBias.y), uShadowTexel.zw);
  }
  return v;
}

// §10 distance/height fog
vec3 applyFog(vec3 c, vec3 world) {
  if (uFlags.z < 0.5) return c;
  float d = length(world - uCamPos.xyz);
  float f = (d - uFogA.x) / max(uFogA.y - uFogA.x, 1.0);
  float fd = sat(f);
  float maxTerm = f <= 0.75 ? uFogA.w : min(1.0, uFogA.w + (1.0 - uFogA.w) * 4.0 * (fd - 0.75));
  float amount0 = min(maxTerm, pow(fd, uFogA.z));
  float nearFade = f < 0.015 ? fd / 0.015 : 1.0;
  float hN = sat((world.z - uFogH.x) / max(uFogH.y, 1.0)), hF = sat((world.z - uFogH.z) / max(uFogH.w, 1.0));
  float h = mix(hN, hF, fd);
  float density = mix(1.0, uFogNear.w, h);
  vec3 col = mix(mix(uFogNear.rgb, uFogFar.rgb, amount0), mix(uFogNearHigh.rgb, uFogFarHigh.rgb, amount0), h);
  return mix(c, col, density * amount0 * nearFade);
}
`;

const VARYINGS = `
in vec3 vWorld; in vec3 vN; in vec3 vBt; in vec3 vT; in vec2 vUV; in vec4 vColor; in vec4 vShadow; in vec4 vShadow2;
in float vViewZ;
in vec4 vCurClip; in vec4 vPrevClip;
layout(location=1) out vec4 outVel;  // TAA: screen motion since last frame (viewport units); ignored without TAA
// TAA: 1 while the shape's picture changes without moving (a UV-offset flipbook, scrolling or fading texture): TAA
// then trusts this frame there instead of a history that only looks still
uniform float uReactive;
vec2 motion() { return (vCurClip.xy / vCurClip.w - vPrevClip.xy / vPrevClip.w) * 0.5; }
`;

// Lit material values (std140, 8 vec4; packed in renderer.js litMaterial)
const LIT_MATERIAL = `
layout(std140) uniform Material {
  vec4 mUV;        // uv offset (xy), uv scale (zw)
  vec4 mAlpha;     // alpha, alpha test, alpha test ref, alpha blend
  vec4 mFlags;     // vertex colours, vertex alpha, has normal map, has _s map
  vec4 mFlags2;    // has glow map, env map (on and loaded), greyscale (on and palette loaded), specular on
  vec4 mVals;      // specular mult, smoothness, env mask scale, greyscale palette row
  vec4 mEmit;      // emissive colour x mult (linear), w: emissive on
  vec4 mMisc;      // backlight, wrap, glow map flag, skin tint (0/1)
  vec4 mDebug;     // x: debug view, y: drawn in the game's deferred pass (darkened by its ambient occlusion)
};
`;

// ---------------------------------------------------------------------------------------------------------------
// Refraction shapes (SF1 Refraction, e.g. stealth-boy domes, heat haze): not lit; the shape shows the finished scene
// behind it, shifted by its normal (normal map in tangent space, then view space) x Refraction Strength x vertex
// alpha. Screen-space like the game's; the game's exact offset formula was not traced, so this is an approximation.
export const REFRACT_FS = COMMON + FRAME + VARYINGS + `
uniform sampler2D uScene, uNormalTex;
layout(std140) uniform Material {
  vec4 mUV;        // uv offset, uv scale
  vec4 mR;         // strength, has normal map, vertex alpha
};
layout(location=0) out vec4 fragColor;
void main() {
  vec2 uv = vUV * mUV.zw + mUV.xy;
  vec3 Ng = normalize(vN);
  vec3 N = gl_FrontFacing ? Ng : -Ng;
  if (mR.y > 0.5 && dot(vBt, vBt) > 1e-10 && dot(vT, vT) > 1e-10) {
    vec2 nxy = texture(uNormalTex, uv).rg * 2.0 - 1.0;
    float nz = sqrt(1.0 - min(dot(nxy, nxy), 1.0));
    N = normalize(nxy.x * normalize(vBt) + nxy.y * normalize(vT) + nz * N);
  }
  vec3 nv = mat3(uView) * N;                                  // view space: x right, y up
  float w = mR.x * (mR.z > 0.5 ? vColor.a : 1.0);
  vec2 sp = gl_FragCoord.xy / uScreen.xy;
  vec2 off = nv.xy * w * vec2(uScreen.y / uScreen.x, 1.0) * uRes.xy;   // in screen heights, so the shift is round
  fragColor = vec4(texture(uScene, clamp(sp + off, vec2(0.001), uRes.xy - 0.001)).rgb, 1.0);
}`;

// §23 placed-light helpers shared by the lit shaders and the light shafts (needs COMMON_FNS)
const LIGHT_FNS = `
// §23 spotlight cone. c = cos of the angle from the spot's axis, w = cos of half its FOV, p = the light's falloff
// exponent. A shadow-casting spotlight fades across its shadow frustum: 1 - min(1, (tan / tan(half FOV))^p); the
// others: sat(1 - (1 - c) / (1 - w))^p
float spotCone(vec4 spot, vec3 toPoint, vec4 lx) {
  float c = dot(toPoint, spot.xyz), w = spot.w;
  if (lx.y > 0.5) {
    if (c <= 1e-4) return 0.0;
    float t = sqrt(max(1.0 - c * c, 0.0)) / c, tw = sqrt(max(1.0 - w * w, 0.0)) / max(w, 1e-4);
    return 1.0 - min(1.0, pow(t / max(tw, 1e-4), lx.x));
  }
  return pow(sat(1.0 - (1.0 - c) / max(1.0 - w, 1e-4)), lx.x);
}
#if LIGHT_SHADOWS
// §23 shadows of placed lights: per layer of uLightShadow the distance from the light / its radius of the nearest
// caster (a cube face of an omni or hemisphere light, or a spotlight's frustum), compared in hardware (2 x 2 filtered)
uniform highp sampler2DArrayShadow uLightShadow;
layout(std140) uniform LightShadows {
  vec4 uLSInfo[LS_MAX];      // per shadow slot: first layer, layers (1 spot, 6 cube faces), 1 / radius, filter radius (uv)
  mat4 uLSMat[LS_LAYERS];    // per layer: light-relative position -> the layer's clip space
};
// The filter reaches about as far as the game's (uiShadowFilter 3: 3 texels of its own map, whose resolution halves
// with the light's distance from the camera): 4 taps on a 2 x 2 grid while that is within a texel or two of this map,
// 16 on a 4 x 4 grid beyond; each tap filtered 2 x 2 in hardware. Taps stay on the face the pixel's direction picks
// (clamped to its edge).
float lightShadow(int slot, vec3 v, float d) {
  vec4 inf = uLSInfo[slot];
  int layer = int(inf.x + 0.5);
  if (inf.y > 1.5) {         // cube: the face the direction points through (+x -x +y -y +z -z)
    vec3 a = abs(v);
    layer += a.x >= a.y && a.x >= a.z ? (v.x > 0.0 ? 0 : 1) : (a.y >= a.z ? (v.y > 0.0 ? 2 : 3) : (v.z > 0.0 ? 4 : 5));
  }
  vec4 c = uLSMat[layer] * vec4(v, 1.0);
  if (c.w <= 0.0) return 1.0;
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
  float ref = (d - 1.0) * inf.z, L = float(layer), e = 0.5 / float(LS_SIZE);
  float s = 0.0;
  if (inf.w * float(LS_SIZE) <= 1.6) {
    for (int k = 0; k < 4; k++) {
      vec2 o = (vec2(float(k & 1), float(k >> 1)) - 0.5) * inf.w;
      s += texture(uLightShadow, vec4(clamp(uv + o, e, 1.0 - e), L, ref));
    }
    return s * 0.25;
  }
  for (int k = 0; k < 16; k++) {
    vec2 o = (vec2(float(k & 3), float(k >> 2)) - 1.5) * (inf.w / 1.5);
    s += texture(uLightShadow, vec4(clamp(uv + o, e, 1.0 - e), L, ref));
  }
  return s * (1.0 / 16.0);
}
// one comparison (the light shafts: many samples along a ray already average)
float lightShadow1(int slot, vec3 v) {
  vec4 inf = uLSInfo[slot];
  int layer = int(inf.x + 0.5);
  if (inf.y > 1.5) {
    vec3 a = abs(v);
    layer += a.x >= a.y && a.x >= a.z ? (v.x > 0.0 ? 0 : 1) : (a.y >= a.z ? (v.y > 0.0 ? 2 : 3) : (v.z > 0.0 ? 4 : 5));
  }
  vec4 c = uLSMat[layer] * vec4(v, 1.0);
  if (c.w <= 0.0) return 1.0;
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
  return texture(uLightShadow, vec4(uv, float(layer), (length(v) - 1.0) * inf.z));
}
#endif
`;

// ---------------------------------------------------------------------------------------------------------------
// Lit materials (BSLightingShaderProperty / BGSM): §2-§7, §9, §14. The body is shared with the projected decals
// (DECAL_FS), which work out the same inputs per pixel from the scene's depth.
const LIGHTING_BODY = `
uniform sampler2D uDiffuse, uNormalTex, uSpecTex, uGlowTex, uPalette;   // diffuse/palette/glow: sRGB-decoded
uniform samplerCube uEnvTex;
// placed lights (RGBA32F, 1024 wide): 5 texels per light (xyz + radius, negative for a spotlight | colour +
// specular 0/1 | attenuation + ambient only 0/1 | spot direction + cos of half the FOV | cone falloff exponent,
// shadow-casting spotlight 0/1, shadow slot or -1), then one texel per cluster (first index, count), then the light
// indices, 4 per texel
uniform highp sampler2D uLightGrid;
vec4 lightTexel(int t) { return texelFetch(uLightGrid, ivec2(t & 1023, t >> 10), 0); }
uniform sampler2D uAO;           // screen-space ambient occlusion of this frame (SAO_FS), one texel per pixel

${LIGHT_FNS}
layout(location=0) out vec4 fragColor;

vec3 softLight(vec3 b, vec3 t) {   // §14, per channel in gamma space
  vec3 lo = 2.0 * b * t + b * b * (1.0 - 2.0 * t);
  vec3 hi = sqrt(b) * (2.0 * t - 1.0) + 2.0 * b * (1.0 - t);
  return mix(lo, hi, step(0.5, t));
}

// ---- The editors' look (Even light, uClusterI.w): lit the way Outfit Studio lights a mesh (BodySlide's FO4 shader
// and its default light settings), so a texture shows the colours it has in the editor. Everything is in GAMMA space:
// the texture's stored values, lit by its rig: ambient 0.2, a frontal light 0.2 along the view, lights of 0.6 from the
// front left and front right and 0.85 from behind, fixed in the world (characters face +Y). Each light: Oren-Nayar
// diffuse (rough = 1 - smoothness where there is a specular map; Lambert without), a normalised-Phong specular with
// Schlick Fresnel (F0 0.2) and the editor's grazing ambient sheen, and the cube map scaled by that light. The sum is
// written back as linear (^2.2): TONEMAP_FS turns it into gamma again and applies the editor's own curve, so glow
// effects and the sky go the same way.
vec3 srgbEncode(vec3 c) {          // the GPU's sRGB decode, undone: the texture's stored value
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float edDiffuse(vec3 N, vec3 V, vec3 L, float rough) {     // Oren-Nayar, N.L folded in, with interreflection
  float nl = max(dot(N, L), 0.0), nv = max(dot(N, V), 1e-4);
  if (nl <= 0.0) return 0.0;
  float s2 = rough * rough;
  float A = 1.0 - 0.5 * s2 / (s2 + 0.33), B = 0.45 * s2 / (s2 + 0.09);
  float sl = sqrt(max(1.0 - nl * nl, 0.0)), sv = sqrt(max(1.0 - nv * nv, 0.0));
  float cphi = sl * sv > 1e-4 ? max(0.0, dot(V - nv * N, L - nl * N)) / (sl * sv) : 0.0;
  float sinA = nl < nv ? sl : sv, tanB = nl < nv ? sv / nv : sl / nl;          // alpha: the larger angle
  // light bounced between the rough surface's facets (Oren and Nayar's interreflection term): fabric gains a little
  float tb = 2.0 * acos(max(nl, nv)) / PI;                                         // 2 beta / pi (beta: the smaller angle)
  float inter = 0.17 * nl * s2 / (s2 + 0.13) * (1.0 - (dot(L, V) - nl * nv) * tb * tb);
  return nl * (A + B * cphi * sinA * tanB) + inter;
}
void edLight(vec3 L, float I, vec3 N, vec3 V, float s, float k, float rough, inout vec3 dif, inout vec3 spc, inout float envW) {
  float nl = max(dot(N, L), 1e-4), nv = max(dot(N, V), 1e-4);
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 1e-4), vh = max(dot(V, H), 1e-4);
  dif += vec3(edDiffuse(N, V, L, rough) * I);
  envW += 0.2 + nl * I;
  if (k <= 0.0) return;
  float n = exp2(10.0 * s + 1.0);
  float D = (n + 2.0) / (2.0 * PI) * pow(nh, n);
  float Gv = min(1.0, min(2.0 * nh * nv / vh, 2.0 * nh * nl / vh)) / nv;           // visibility / N.V
  float F = sat(pow(1.0 - vh, 5.0) * (1.0 - 0.2) + 0.2);
  spc += vec3(k * F * Gv * D * 0.25 * PI * nl * I);
  spc += vec3(0.2 * k * F * (1.0 - nv) * I);                                       // grazing ambient sheen
}
vec3 editorLook(vec3 albedo, vec3 N, vec3 V, float s, float k, vec3 emit) {
  vec3 a = srgbEncode(albedo);
  float rough = k > 0.0 ? 1.0 - s : 0.0;
  vec3 back = normalize(vec3(uView[0][2], uView[1][2], uView[2][2]));             // towards the camera
  // the rig turns with the character (uClusterI.w = 1 + its heading): lit from its own front left, front right and
  // back, as the editor lights a model that faces it
  float h = uClusterI.w - 1.0, ch = cos(h), sh = sin(h);
  mat3 turn = mat3(ch, sh, 0.0, -sh, ch, 0.0, 0.0, 0.0, 1.0);
  vec3 dif = vec3(0.0), spc = vec3(0.0);
  float envW = 0.0;
  edLight(back, 0.2, N, V, s, k, rough, dif, spc, envW);
  edLight(turn * normalize(vec3(-1.0, 1.0, 0.1)), 0.6, N, V, s, k, rough, dif, spc, envW);
  edLight(turn * normalize(vec3(1.0, 1.0, 0.1)), 0.6, N, V, s, k, rough, dif, spc, envW);
  edLight(turn * normalize(vec3(0.0, -1.0, 0.2)), 0.85, N, V, s, k, rough, dif, spc, envW);
  if (mFlags2.y > 0.5 && k > 0.0) {
    vec3 cube = srgbEncode(textureLod(uEnvTex, V - 2.0 * dot(N, V) * N, 8.0 - 8.0 * s).rgb);
    spc += cube * mVals.z * k * envW;
  }
  vec3 g = dif * a + spc + srgbEncode(emit) + 0.2 * a;
  return gammaToLinear(g);
}

void main() {
  vec2 uv = vUV * mUV.zw + mUV.xy;
  vec4 dif = texture(uDiffuse, uv);
  float va = mFlags.y > 0.5 ? vColor.a : 1.0;
  float alpha = mAlpha.x * dif.a * va;
#if CLIP
  if (mAlpha.y > 0.5 && dif.a * va < mAlpha.z) discard;
  if (mAlpha.w > 0.5 && alpha < 4.0 / 255.0) discard;
#endif

  // albedo (§3)
  vec3 albedo = dif.rgb;
  if (mFlags2.z > 0.5) albedo = textureLod(uPalette, vec2(pow(max(dif.g, 0.0), 1.0 / 2.2), mVals.w), 0.0).rgb;
  if (mFlags.x > 0.5) albedo *= gammaToLinear(vColor.rgb);
  float tintAmount = uTint.w * mMisc.w;
  if (tintAmount > 0.0) albedo = mix(albedo, gammaToLinear(softLight(linearToGamma(albedo), uTint.rgb)), tintAmount);

  // normal (§2): red along the NIF bitangent, green along the NIF tangent, no green flip; back faces negate z only
  vec3 Ng = normalize(vN);
  vec3 N = gl_FrontFacing ? Ng : -Ng;
  if (mFlags.z > 0.5) {
    vec2 nxy = texture(uNormalTex, uv).rg * 2.0 - 1.0;
    float nz = sqrt(1.0 - min(dot(nxy, nxy), 1.0));
    if (!gl_FrontFacing) nz = -nz;
    if (dot(vBt, vBt) > 1e-10 && dot(vT, vT) > 1e-10)
      N = normalize(nxy.x * normalize(vBt) + nxy.y * normalize(vT) + nz * Ng);
  }

  // smoothness and specular (§3): _s.G x Smoothness, _s.R x Specular Mult; the specular colour is not used
  vec2 ss = mFlags.w > 0.5 ? texture(uSpecTex, uv).rg : vec2(0.0);
  float s = sat(ss.g * mVals.y);
  float k = ss.r * mVals.x * mFlags2.w;
  float r = 1.0 - s;

  vec3 V = normalize(uCamPos.xyz - vWorld);
  vec3 L = uSunDir.xyz;
  float cv = dot(N, V), cl = dot(N, L);
  float NV = sat(cv), NL = sat(cl);
  vec3 H = normalize(V + L);
  float NH = sat(dot(N, H)), VH = sat(dot(V, H));
  // the sun's shadow taps only where they can matter: facing away from the sun (cl <= 0) with no backlight or wrap,
  // Esun and Ssun below are exactly 0 whatever sh is (debug view 5 shows sh itself)
  float sh = 1.0;
  if (cl > 0.0 || mMisc.x != 0.0 || mMisc.y != 0.0 || int(mDebug.x) == 5) sh = shadowAt(vShadow, vShadow2, sat(dot(Ng, L)));

  // §4 sun diffuse: modified Oren-Nayar + sheen + backlight + wrap
  float s2 = r * r;
  float A = 1.0 - 0.5 * s2 / (s2 + 0.57);
  float B = 0.45 * s2 / (s2 + 0.09);
  float P = max(0.0, dot(V - cv * N, L - cl * N));
  float Q = sqrt(sat((1.0 - cv * cv) * (1.0 - cl * cl))) / max(max(cv, cl), 1e-4);
  float ON = max(cl, 0.0) * (A + B * P * Q);
  float sheen = r * sat(dot(V, -L)) * pow(max(1.0 - NV, 0.0), 0.01) * NL;
  vec3 back = albedo * mMisc.x * sat(-cl);
  vec3 wrap = albedo * max(0.0, sat((cl + mMisc.y) / (1.0 + mMisc.y)) - NL);
  vec3 Esun = uSunColor.rgb * sh * (vec3(ON + sheen) + back + wrap);

  // §4 sun specular
  float n = exp2(10.0 * s + 1.0);
  // specular anti-aliasing: where the normal turns faster than one pixel can show (small polished parts such as
  // buckles, normal-map detail seen from afar) a highlight up to exponent 2048 is thinner than a pixel and sparkles as
  // the part moves. The lobe is widened to the pixel's footprint with its energy kept (Tokuyoshi & Kaplanyan 2019,
  // Blinn-Phong as roughness^2 = 2 / (n + 2)): the average the game's temporal anti-aliasing builds over frames, in
  // one frame. Pixels whose normal barely changes keep the game's exponent exactly.
  vec3 dNx = dFdx(N), dNy = dFdy(N);
  if (uClusterI.y > 0.5) {
    float a2 = 2.0 / (n + 2.0) + min(0.5 * (dot(dNx, dNx) + dot(dNy, dNy)), 0.18);
    n = max(2.0 / a2 - 2.0, 1.0);
  }
  float D = (n + 2.0) / (2.0 * PI) * pow(NH, n);
  float G = min(1.0, min(2.0 * NH * NV / max(VH, 1e-4), 2.0 * NH * NL / max(VH, 1e-4)));
  float F = min(1.0, 0.2 + 0.8 * pow(1.0 - VH, 5.0));
  vec3 Ssun = uSunColor.rgb * sh * k * PI * NL * min(15.0, D * F * G / (4.0 * max(NV, 1e-4)));

  // §8 point lights: att x colour x (Oren-Nayar + sheen), no backlight or wrap; specular = the sun formula x att.
  // Every placed light that reaches the pixel: its cluster (screen tile x depth slice) lists them (renderer.js
  // buildLightGrid), as the game lights a surface with all the lights touching it
  vec3 Epts = vec3(0.0), Spts = vec3(0.0);
  if (uFlags.w > 0.5) {
    ivec2 tile = clamp(ivec2(gl_FragCoord.xy / uClusterZ.zw), ivec2(0), ivec2(uCluster.xy) - 1);
    int slice = clamp(int(log(max(vViewZ, uClusterZ.y) / uClusterZ.y) * uClusterZ.x), 0, int(uCluster.z) - 1);
    vec4 oc = lightTexel(int(uCluster.w) + (slice * int(uCluster.y) + tile.y) * int(uCluster.x) + tile.x);
    int first = int(oc.x), count = int(oc.y), ibase = int(uClusterI.x);
    int it = -1;                                          // the index texel held in ix (4 indices per texel)
    vec4 ix = vec4(0.0);
    for (int q = 0; q < count; q++) {
      int j = first + q, t = ibase + (j >> 2);
      if (t != it) { it = t; ix = lightTexel(t); }
      int li = int(ix[j & 3]) * 5;
      vec4 lpos = lightTexel(li);                         // a cluster lists every light that may reach it: most
      vec3 dl = lpos.xyz - vWorld;                        // pixels are out of range of some, so test that first
      float d = length(dl), Rl = abs(lpos.w);
      if (d >= Rl) continue;
      vec3 Lp = dl / max(d, 1e-4);
      float clp = dot(N, Lp);
      vec4 lcol = lightTexel(li + 1), latt = lightTexel(li + 2);
      // a directional light behind the surface adds exactly 0 (diffuse and sheen carry max(clp, 0) / sat(clp), the
      // specular needs nlp > 0): skip its attenuation, cone and shadow taps. Same for att == 0 below
      if (latt.w <= 0.5 && clp <= 0.0) continue;
      float att = pow(1.0 - sat(latt.x + latt.y * pow(d / Rl, latt.z)), 2.2);
      vec4 lx = lightTexel(li + 4);
      if (lpos.w < 0.0) att *= spotCone(lightTexel(li + 3), -Lp, lx);     // spotlight (negative radius)
      if (att <= 0.0) continue;
#if LIGHT_SHADOWS
      if (lx.z > -0.5 && att > 1e-3) att *= lightShadow(int(lx.z + 0.5), -dl, d);
#endif
      if (latt.w > 0.5) { Epts += lcol.rgb * att; continue; }        // Ambient Only: fill light, no direction
      float nlp = sat(clp);
      float Pp = max(0.0, dot(V - cv * N, Lp - clp * N));
      float Qp = sqrt(sat((1.0 - cv * cv) * (1.0 - clp * clp))) / max(max(cv, clp), 1e-4);
      float sheenP = r * sat(dot(V, -Lp)) * pow(max(1.0 - NV, 0.0), 0.01) * nlp;
      Epts += lcol.rgb * att * (max(clp, 0.0) * (A + B * Pp * Qp) + sheenP);
      if (lcol.w * k * nlp <= 0.0) continue;                         // Non Specular light, or no specular here
      vec3 Hp = normalize(V + Lp);
      float NHp = sat(dot(N, Hp)), VHp = sat(dot(V, Hp));
      float Gp = min(1.0, min(2.0 * NHp * NV / max(VHp, 1e-4), 2.0 * NHp * nlp / max(VHp, 1e-4)));
      float Fp = min(1.0, 0.2 + 0.8 * pow(1.0 - VHp, 5.0));
      Spts += lcol.rgb * att * k * PI * nlp * min(15.0, (n + 2.0) / (2.0 * PI) * pow(NHp, n) * Fp * Gp / (4.0 * max(NV, 1e-4)));
    }
  }

  // §5 ambient
  vec3 Eamb = dirAmbient(N);
  vec3 R = 2.0 * dot(N, V) * N - V;
  vec3 Samb = k * 0.25 * pow(max(1.0 - NV, 0.0), 3.0 - s) * dirAmbient(R);

  vec3 Etotal = Esun + Eamb + Epts;

  // §6 environment cube: negated reflection, mip 6(1-s) + depth/512, strength sqrt(sat(s-0.3)) 3k envScale E
  vec3 env = vec3(0.0);
  if (mFlags2.y > 0.5) {
    vec3 dir = V - 2.0 * dot(N, V) * N;
    float lod = 6.0 * (1.0 - s) + vViewZ / 512.0;
    // with the specular anti-aliasing on: never sharper than the reflection's own sweep across one pixel (a cube
    // face spans 90 degrees in its width in texels). On small curved metal the reflected direction jumps across the
    // sky from pixel to pixel and the mirror image sparkles as it moves; the game's TAA averages that away
    vec3 rx = dFdx(dir), ry = dFdy(dir);
    if (uClusterI.y > 0.5)
      lod = max(lod, log2(max(sqrt(max(dot(rx, rx), dot(ry, ry))) * float(textureSize(uEnvTex, 0).x) * 0.6366, 1.0)));
    vec3 cube = textureLod(uEnvTex, dir, lod).rgb;
    env = cube * sqrt(sat(s - 0.3)) * 3.0 * k * mVals.z * Etotal;
  }

  // §7 emissive, added unlit
  vec3 emit = vec3(0.0);
  if (mEmit.w > 0.5) emit = mEmit.rgb * (mMisc.z > 0.5 && mFlags2.x > 0.5 ? texture(uGlowTex, uv).rgb : vec3(1.0));

  vec3 color = emit + Ssun + Spts + Samb + albedo * Etotal + env;
  if (uClusterI.w > 0.5) color = editorLook(albedo, N, V, s, k, emit);     // Even light: the editors' look
  // §21 the game's SAO multiplies the whole lit colour of its deferred surfaces (all light, reflections, emissive)
  // before fog; read from the half-resolution occlusion with an ordinary filtered lookup, as the game's composite
  float ao = uClusterI.z > 0.5 && mDebug.y > 0.5 ? texture(uAO, gl_FragCoord.xy * 0.5 / vec2(textureSize(uAO, 0))).r : 1.0;
  color *= ao;
  color = applyFog(color, vWorld);

  int dbg = int(mDebug.x);
  if (dbg == 1) color = albedo;
  else if (dbg == 2) color = N * 0.5 + 0.5;
  else if (dbg == 3) color = vec3(k, s, 0.0);
  else if (dbg == 4) color = emit;
  else if (dbg == 5) color = vec3(sh);
  else if (dbg == 7) color = Etotal;
  else if (dbg == 8) color = env + Ssun + Samb;
  else if (dbg == 9) color = vec3(ao);
  color = clamp(color, 0.0, 30000.0);            // keep RGBA16F finite (65504 max)
  fragColor = vec4(color, mAlpha.w > 0.5 ? alpha : 1.0);
  outVel = vec4(motion(), uReactive, 1.0);
}`;
export const LIGHTING_FS = COMMON + FRAME + COMMON_FNS + VARYINGS + LIT_MATERIAL + LIGHTING_BODY;

// ---------------------------------------------------------------------------------------------------------------
// Effect materials (BSEffectShaderProperty / BGEM): §11
export const EFFECT_FS = COMMON + FRAME + COMMON_FNS + VARYINGS + `
uniform sampler2D uBase, uPalette, uNormalTex, uEnvMask;   // base/palette sRGB-decoded
uniform samplerCube uEnvTex;
uniform sampler2D uSceneDepth;   // depth of the solid scene (resolved after the opaque pass)
layout(std140) uniform Material {
  vec4 mUV;        // uv offset, uv scale
  vec4 mAlpha;     // alpha, alpha test, alpha test ref, alpha blend
  vec4 mBase;      // base colour: linear rgb, raw alpha
  vec4 mF1;        // base colour scale, has base texture, has palette, greyscale colour
  vec4 mF2;        // greyscale alpha, vertex colours, falloff on, lighting influence
  vec4 mFalloff;   // start angle, stop angle (cosines), start opacity, stop opacity
  vec4 mF3;        // effect lighting, env map (on and loaded), env scale, has normal map
  vec4 mF4;        // has env mask, soft, soft depth, particles (§26)
};
layout(location=0) out vec4 fragColor;
void main() {
  vec2 uv = vUV * mUV.zw + mUV.xy;
  vec4 t = mF1.y > 0.5 ? texture(uBase, uv) : vec4(1.0);
  vec4 vc = mF2.y > 0.5 ? pow(max(vColor, 0.0), vec4(2.2)) : vec4(1.0);
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamPos.xyz - vWorld);
  float falloff = 1.0;
  if (mF2.z > 0.5) {
    float span = mFalloff.y - mFalloff.x;
    float ft = sat((abs(dot(N, V)) - mFalloff.x) / (abs(span) < 1e-4 ? 1e-4 : span));
    falloff = mix(mFalloff.z, mFalloff.w, ft * ft * (3.0 - 2.0 * ft));
  }
  // §11.8 soft particles: the effect fades out as it nears whatever lies behind it (ground, walls, the character)
  if (mF4.y > 0.5) {
    float zn = texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r * 2.0 - 1.0;
    float sceneZ = 2.0 * uScreen.z * uScreen.w / (uScreen.w + uScreen.z - zn * (uScreen.w - uScreen.z));
    falloff *= sat((sceneZ - vViewZ) / max(mF4.z, 1.0));
  }
  vec3 rgb; float a;
  // particles (mF4.w, §26): the particle's colour picks the palette row (a fire turns from hot to cool as its colour
  // goes from white to dark) and its alpha the alpha row, instead of tinting the result
  bool ps = mF4.w > 0.5, rowRGB = false, rowA = false;
  if (mF1.w > 0.5 && mF1.z > 0.5) {
    float u = pow(max(t.g, 0.0), 1.0 / 2.2);
    float v = pow(max(mBase.r, 0.0), 1.0 / 2.2) * falloff * (ps ? vColor.r : 1.0);
    rgb = textureLod(uPalette, vec2(u, v), 0.0).rgb * mF1.x;
    a = t.a * mBase.a * falloff;
    rowRGB = ps;
    if (ps && mF2.x > 0.5) {
      a = textureLod(uPalette, vec2(t.a, pow(max(mAlpha.x * mBase.a, 0.0), 1.0 / 2.2) * vColor.a * falloff), 0.0).a;
      rowA = true;
    }
  } else if (mF2.x > 0.5 && mF1.z > 0.5) {
    rgb = t.rgb * mBase.rgb * mF1.x;
    a = textureLod(uPalette, vec2(t.a, pow(max(mAlpha.x * mBase.a, 0.0), 1.0 / 2.2) * (ps ? vColor.a : 1.0) * falloff), 0.0).a;
    rowA = ps;
  } else {
    rgb = t.rgb * mBase.rgb * mF1.x;   // Base Colour Scale premultiplied (low confidence, §11.4)
    a = t.a * mBase.a * falloff;
  }
  if (!rowRGB) rgb *= vc.rgb;
  if (!rowA) a *= vc.a;
  if (mF3.y > 0.5) {
    float nA = mF3.w > 0.5 ? texture(uNormalTex, uv).a : 1.0;
    float m = mF4.x > 0.5 ? texture(uEnvMask, uv).r : 1.0;
    rgb += texture(uEnvTex, V - 2.0 * dot(N, V) * N).rgb * mF3.z * nA * m;
  }
  if (mF2.w > 0.0) {
    // effect lighting ignores N.L (§11.7); the engine's per-object light colour is approximated by ambient + sun
    vec3 light = mF3.x > 0.5 ? dirAmbient(N) + uSunColor.rgb * shadowAt(vShadow, vShadow2, 1.0) : vec3(1.0);
    rgb = mix(rgb, rgb * light, mF2.w);
  }
  a *= mAlpha.x;
#if CLIP
  if (mAlpha.y > 0.5 && a < mAlpha.z) discard;
#endif
  rgb = clamp(rgb, 0.0, 30000.0);
  fragColor = vec4(rgb, mAlpha.w > 0.5 ? a : 1.0);
  outVel = vec4(motion(), uReactive, 1.0);
}`;

// ---------------------------------------------------------------------------------------------------------------
// Shadow maps and the game-mode depth probes: position (+ skinning), alpha test only in the CLIP variant
export const SHADOW_VS = COMMON + BONES + `
layout(location=0) in vec3 aPos;
layout(location=4) in vec2 aUV;
layout(location=6) in vec4 aWeights;
layout(location=7) in vec4 aBoneIdx;
layout(location=8) in vec4 iM0;
layout(location=9) in vec4 iM1;
layout(location=10) in vec4 iM2;
layout(location=11) in vec4 iM3;
uniform mat4 uShadowVP;
out vec2 vUV;
void main() {
  vec4 p = vec4(aPos, 1.0);
#if SKINNED
  p = (aWeights.x * uBones[int(aBoneIdx.x)] + aWeights.y * uBones[int(aBoneIdx.y)]
     + aWeights.z * uBones[int(aBoneIdx.z)] + aWeights.w * uBones[int(aBoneIdx.w)]) * p;
#endif
  vUV = aUV; gl_Position = uShadowVP * (mat4(iM0, iM1, iM2, iM3) * p);
}`;
export const SHADOW_FS = COMMON + `
in vec2 vUV;
#if CLIP
uniform sampler2D uDiffuse;
layout(std140) uniform Material { vec4 mUV; vec4 mAlpha; };    // the first two rows of the lit material
#endif
out vec4 o;
void main() {
#if CLIP
  if (texture(uDiffuse, vUV * mUV.zw + mUV.xy).a < mAlpha.z) discard;
#endif
  o = vec4(1.0);
}`;

// §23 shadow maps of placed lights: each layer (a cube face, or a spotlight's frustum) stores the distance from the
// light / its radius of the nearest caster as its depth. Nothing nearer to the light than its near clip casts (the
// lamp's own fitting). Positions are taken relative to the light, so the far Commonwealth coordinates keep their
// precision.
export const LSHADOW_VS = COMMON + BONES + `
layout(location=0) in vec3 aPos;
layout(location=4) in vec2 aUV;
layout(location=6) in vec4 aWeights;
layout(location=7) in vec4 aBoneIdx;
layout(location=8) in vec4 iM0;
layout(location=9) in vec4 iM1;
layout(location=10) in vec4 iM2;
layout(location=11) in vec4 iM3;
uniform mat4 uShadowVP;          // light-relative position -> this layer's clip space
uniform vec3 uLightPos;
out vec2 vUV; out vec3 vRel;
void main() {
  vec4 p = vec4(aPos, 1.0);
#if SKINNED
  p = (aWeights.x * uBones[int(aBoneIdx.x)] + aWeights.y * uBones[int(aBoneIdx.y)]
     + aWeights.z * uBones[int(aBoneIdx.z)] + aWeights.w * uBones[int(aBoneIdx.w)]) * p;
#endif
  vRel = (mat4(iM0, iM1, iM2, iM3) * p).xyz - uLightPos;
  vUV = aUV; gl_Position = uShadowVP * vec4(vRel, 1.0);
}`;
export const LSHADOW_FS = COMMON + `
in vec2 vUV; in vec3 vRel;
uniform vec2 uLSRange;           // near clip, 1 / radius
#if CLIP
uniform sampler2D uDiffuse;
layout(std140) uniform Material { vec4 mUV; vec4 mAlpha; };    // the first two rows of the lit material
#endif
void main() {
#if CLIP
  if (texture(uDiffuse, vUV * mUV.zw + mUV.xy).a < mAlpha.z) discard;
#endif
  float d = length(vRel);
  if (d < uLSRange.x) discard;
  // stored a little further from the light, more where the surface turns away from it (the lookup filters up to a
  // few texels around a point: this slope-scaled offset keeps lit surfaces from shadowing themselves)
  gl_FragDepth = clamp((d + 0.5 + 3.0 * min(fwidth(d), 16.0)) * uLSRange.y, 0.0, 1.0);
}`;

// Selection (a single click): every pickable draw writes its id + instance into a 1 x 1 target under the cursor
export const PICK_VS = SHADOW_VS.replace('out vec2 vUV;', 'out vec2 vUV;\nflat out int vInst;')
  .replace('vUV = aUV; gl_Position', 'vInst = gl_InstanceID; vUV = aUV; gl_Position');
export const PICK_FS = COMMON + `
in vec2 vUV;
flat in int vInst;
uniform int uBase;
#if CLIP
uniform sampler2D uDiffuse;
layout(std140) uniform Material { vec4 mUV; vec4 mAlpha; };
#endif
out vec4 o;
void main() {
#if CLIP
  if (texture(uDiffuse, vUV * mUV.zw + mUV.xy).a < mAlpha.z) discard;
#endif
  int id = uBase + vInst + 1;
  o = vec4(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255), 255.0) / 255.0;
}`;
// the selected model's edges, drawn over the finished picture (after the tonemap, so the colour is the same in any
// light); only edges not hidden behind other surfaces (the solid scene's depth) show
export const WIRE_FS = COMMON + FRAME + `
in float vViewZ;
uniform sampler2D uSceneDepth;
uniform vec4 uColor;
out vec4 o;
void main() {
  float zn = texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy * uRes.xy), 0).r * 2.0 - 1.0;
  float sceneZ = 2.0 * uScreen.z * uScreen.w / (uScreen.w + uScreen.z - zn * (uScreen.w - uScreen.z));
  if (vViewZ > sceneZ * 1.004 + 1.5) discard;
  o = uColor;
}`;

// the collision view (physics.js): line lists in world space, one colour each; lines behind the scene drawn faint
export const COLL_VS = COMMON + FRAME + `
layout(location=0) in vec3 aPos;
out float vViewZ;
void main() {
  vec4 vp = uView * vec4(aPos, 1.0);
  vViewZ = -vp.z;
  gl_Position = uProj * vp;
}`;
export const COLL_FS = COMMON + FRAME + `
in float vViewZ;
uniform sampler2D uSceneDepth;
uniform vec4 uColor;
out vec4 o;
void main() {
  float zn = texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy * uRes.xy), 0).r * 2.0 - 1.0;
  float sceneZ = 2.0 * uScreen.z * uScreen.w / (uScreen.w + uScreen.z - zn * (uScreen.w - uScreen.z));
  o = vec4(uColor.rgb, uColor.a * (vViewZ > sceneZ * 1.004 + 1.5 ? 0.22 : 1.0));
}`;

// game mode: depth of the nearest surface in a small orthographic view (ground under the feet, wall ahead)
export const PROBE_FS = COMMON + `
in vec2 vUV;
out vec4 o;
void main() { o = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }`;

// ---------------------------------------------------------------------------------------------------------------
export const FULLSCREEN_VS = COMMON + `
out vec2 vUV;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
// the sky triangle sits on the far plane: drawn after the solid scene, only the pixels nothing covers run its shader
export const SKY_VS = COMMON + `
out vec2 vUV;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}`;

// Sky backdrop: weather sky colours (linear x Sky Scale). The game draws a sky dome with cloud layers; this is a
// gradient stand-in (see docs/DEVELOPMENT.md "Not simulated"). The colour by elevation (§20 sky-dome ring weights, or the plain
// gradient) is evaluated on the CPU into a lookup strip whenever the weather changes (renderer.js skyColor); the
// sun disc and glare stay per pixel.
export const SKY_FS = COMMON + `
in vec2 vUV;
uniform mat4 uInvViewProj;
uniform vec3 uSunDisc, uSunDir, uGlare;
uniform float uSunSize;
uniform sampler2D uSkyLut;      // linear sky colour by the sine of the elevation, -1 .. 1
out vec4 o;
void main() {
  vec4 p = uInvViewProj * vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(p.xyz / p.w);
  vec3 c = texture(uSkyLut, vec2(d.z * 0.5 + 0.5, 0.5)).rgb;
  float cs = dot(d, uSunDir);
  c += uGlare * pow(max(cs, 0.0), 24.0) * 0.6;
  c += uSunDisc * smoothstep(cos(uSunSize * 1.2), cos(uSunSize), cs);
  o = vec4(c, 1.0);
}`;

// Temporal anti-aliasing, the game's default (FO4 "TAA"). Each frame is drawn shifted by a sub-pixel (Halton 2,3,
// renderer.js) and blended into the history of earlier frames, found again through the motion vectors the mesh
// shaders write (camera, the character's placement, skinning and cloth). Against ghosting the history is clipped into
// the colour spread of the current pixel's neighbours (variance clipping in YCoCg, Salvi / Karis); colours are blended
// tone-compressed (c / (1 + max c)) so one bright sample cannot dominate an edge. A still scene averages its last
// frames evenly (uAlpha = 1 / n): a 16-frame supersample, after which nothing is redrawn.
export const TAA_FS = COMMON + `
in vec2 vUV;                       // 0..1 across the part of the targets the scene covers
uniform sampler2D uCur, uHist, uVel;
uniform vec2 uUVScale, uTexel;     // that part (texture units); one texel (texture units)
uniform float uAlpha;              // share of this frame
uniform int uReset;                // 1: no usable history (resize, render scale change, first frame)
uniform mat4 uReproj;              // this frame's NDC on the far plane -> last frame's clip (the sky: camera only)
out vec4 o;
float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }
vec3 tm(vec3 c) { return c / (1.0 + maxc(c)); }
vec3 itm(vec3 c) { return c / max(1.0 - maxc(c), 1e-3); }
vec3 toYC(vec3 c) { return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
vec3 fromYC(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
// the history through a 5-tap Catmull-Rom (bilinear would soften the picture a little more every frame)
vec3 history(vec2 uv) {
  vec2 res = 1.0 / uTexel, p = uv * res, c = floor(p - 0.5) + 0.5, f = p - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, t0 = (c - 1.0) * uTexel, t3 = (c + 2.0) * uTexel, t12 = (c + w2 / w12) * uTexel;
  vec3 s = texture(uHist, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y) + texture(uHist, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
         + texture(uHist, t12).rgb * (w12.x * w12.y) + texture(uHist, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
         + texture(uHist, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(s / ws, 0.0);
}
void main() {
  vec2 uv = vUV * uUVScale;
  vec3 cur = max(texture(uCur, uv).rgb, 0.0);
  if (any(isnan(cur)) || any(isinf(cur))) cur = vec3(0.0);
  if (uReset == 1) { o = vec4(cur, 1.0); return; }
  // the current neighbourhood (mean, spread) and the motion of its fastest-moving pixel (edges keep their motion)
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec2 vel = vec2(0.0);
  float best = -1.0, react = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 q = uv + vec2(float(x), float(y)) * uTexel;
    vec3 s = toYC(tm(max(texture(uCur, q).rgb, 0.0)));
    m1 += s; m2 += s * s;
    // motion in .xy, coverage in .a (surfaces write 1, the cleared background 0; the MSAA resolve averages both,
    // so motion / coverage is the covered samples' own motion even on an edge against the sky)
    vec4 v4 = texture(uVel, q);
    if (v4.a > 0.01) { vec2 v = v4.xy / v4.a; float l = dot(v, v); if (l > best) { best = l; vel = v; } }
    if (v4.a > 0.01) react = max(react, v4.z / v4.a);
  }
  if (best < 0.0) {                // the sky / background at infinity: moved by the camera only
    vec4 pc = uReproj * vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
    vel = vUV - (pc.xy / pc.w * 0.5 + 0.5);
  }
  vec2 prev = vUV - vel;           // where this pixel was last frame
  if (any(lessThan(prev, vec2(0.0))) || any(greaterThan(prev, vec2(1.0)))) { o = vec4(cur, 1.0); return; }
  // Per pixel: the history's alpha holds how many frames it already averages. A still pixel averages up to 16
  // jittered frames evenly (a supersample that no longer moves) and its history may stray further from the jittered
  // neighbourhood before it is clipped; a moving one keeps about 8 and is clipped tightly (no ghost trails).
  float px = length(vel * vec2(textureSize(uCur, 0)) * uUVScale);      // motion in pixels
  float still = react > 0.5 ? 0.0 : 1.0 - clamp(px / 2.0, 0.0, 1.0);
  vec3 h = toYC(tm(history(prev * uUVScale)));
  float age = texture(uHist, prev * uUVScale).a;
  vec3 mean = m1 / 9.0, sd = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
  // clip (not clamp) the history towards the mean into mean +- gamma sd: a revealed or changed pixel drops its past
  vec3 d = h - mean, r = abs(d) / max(mix(1.0, 2.0, still) * sd, vec3(1e-5));
  float k = max(r.x, max(r.y, r.z));
  if (k > 1.0) { h = mean + d / k; age = min(age, mix(2.0, 8.0, clamp(2.0 - k, 0.0, 1.0))); }  // far off: start over
  age = clamp(age, 0.0, mix(8.0, 16.0, still));
  if (react > 0.5) age = min(age, 1.0);      // a changing texture: at least half of this frame
  float a = max(1.0 / (age + 1.0), uAlpha * (1.0 - still));         // uAlpha: the floor for moving pixels
  vec3 res = mix(h, toYC(tm(cur)), a);
  o = vec4(itm(max(fromYC(res), 0.0)), age + 1.0);
}`;

// §12 eye adaptation: Rec.709 luminance, arithmetic mean through the mip chain
export const LUM_FS = COMMON + `
in vec2 vUV; uniform sampler2D uSrc; uniform vec2 uUVScale; out vec4 o;
void main() { o = vec4(dot(texture(uSrc, vUV * uUVScale).rgb, vec3(0.2125, 0.7154, 0.0721)), 0.0, 0.0, 1.0); }`;

// §12 eye adaptation on the GPU: the adapted luminance follows the measured mean with a first-order lag (Eye Adapt
// Speed). It lives in a 1 x 1 texture the tonemap reads, so no frame waits for a read-back to the CPU.
export const ADAPT_FS = COMMON + `
in vec2 vUV;
uniform sampler2D uLum, uPrev;
uniform int uLevel;              // the 1 x 1 mip of the luminance chain
uniform float uK;                // 1 - exp(-dt x speed); 1 = take this frame's value
out vec4 o;
void main() {
  float m = texelFetch(uLum, ivec2(0), uLevel).r;
  float a = texelFetch(uPrev, ivec2(0), 0).r;
  if (isnan(m) || isinf(m)) m = a;                  // a broken frame keeps the old value
  if (isnan(a) || isinf(a) || a < 0.0) a = m;
  o = vec4(a + (m - a) * uK, m, 0.0, 1.0);
}`;

// §12 bloom: bright = max(HDR - threshold, 0) x scale at reduced resolution, then a separable 15-tap Gaussian
export const BRIGHT_FS = COMMON + `
in vec2 vUV; uniform sampler2D uSrc; uniform float uThreshold, uScale; uniform vec2 uTexel, uUVScale;
out vec4 o;
void main() {
  vec3 c = vec3(0.0);   // 4x4 box from the full-resolution HDR (4 bilinear taps)
  vec2 uv = vUV * uUVScale;
  c += texture(uSrc, uv + vec2(-1.0, -1.0) * uTexel).rgb + texture(uSrc, uv + vec2(1.0, -1.0) * uTexel).rgb;
  c += texture(uSrc, uv + vec2(-1.0, 1.0) * uTexel).rgb + texture(uSrc, uv + vec2(1.0, 1.0) * uTexel).rgb;
  c *= 0.25;
  o = vec4(max(c - uThreshold, 0.0) * uScale, 1.0);
}`;
// The 15-tap Gaussian (weights 0.1177, 0.11299, 0.09997, 0.08151, 0.06125, 0.04242, 0.02708, 0.01593) read as 9
// bilinear taps: each pair of neighbouring texels is one tap placed between them by their weights. Same sum.
export const BLUR_FS = COMMON + `
in vec2 vUV; uniform sampler2D uSrc; uniform vec2 uStep; uniform float uClampOne;
out vec4 o;
void main() {
  const float W[5] = float[5](0.1177, 0.21296, 0.14276, 0.0695, 0.01593);
  const float O[5] = float[5](0.0, 1.469434, 3.429043, 5.389640, 7.0);
  vec3 c = texture(uSrc, vUV).rgb * W[0];
  for (int i = 1; i < 5; i++)
    c += (texture(uSrc, vUV + uStep * O[i]).rgb + texture(uSrc, vUV - uStep * O[i]).rgb) * W[i];
  if (uClampOne > 0.5) c = min(c, vec3(1.0));
  o = vec4(c, 1.0);
}`;

// §12-§13 tonemap, cinematic, output gamma, LUTs
export const TONEMAP_FS = COMMON + `
in vec2 vUV;
uniform sampler2D uScene, uBloom, uAdapt;    // uAdapt: r = adapted luminance (ADAPT_FS)
uniform vec2 uUVScale;          // share of the HDR target the scene covers
uniform vec4 uExpo;             // x: auto exposure, y: manual exposure or the bias multiplier, z: middle grey
uniform vec2 uAeRange;          // auto exposure min, max
uniform float uTonemapE, uWhite;
uniform vec3 uCinematic;        // saturation, brightness, contrast
uniform vec4 uTintIS;           // rgb, amount
uniform int uTonemapMode, uShowBloom;
uniform float uEditor;          // 1: Even light, the editors' look (no exposure, bloom, grading or LUT)
uniform sampler2D uLut0, uLut1; uniform vec2 uLutW;
// a backdrop in place of the sky and floor (NifSkope black, Outfit Studio grey), exact on screen: the models' coverage
// is the resolved scene's alpha (the sky and floor leave 0); NifSkope's floor grid and corner axes on top of it
uniform sampler2D uCover;
uniform vec4 uBackdrop;         // rgb: display colour, a: on
uniform vec4 uGrid;             // x: on, y: floor height, z: half size (NifSkope: 1024 units)
uniform vec4 uAxes;             // x: on, y: corner box in pixels (NifSkope: min(width / 10, 125))
uniform mat4 uInvVP, uView;     // the camera without TAA's jitter
uniform vec3 uEye;
out vec4 o;
// NifSkope's grid: lines every 128 units, white at 0.2, 1.4 px; one between each pair every 64, white at 0.1, 0.9 px
vec3 backdrop() {
  vec3 c = uBackdrop.rgb;
  if (uGrid.x < 0.5) return c;
  vec2 ndc = vUV * 2.0 - 1.0;
  vec4 a = uInvVP * vec4(ndc, -1.0, 1.0), b = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 dir = b.xyz / b.w - a.xyz / a.w;
  float t = (uGrid.y - uEye.z) / (abs(dir.z) > 1e-6 ? dir.z : 1e-6);
  vec2 p = uEye.xy + dir.xy * t;
  vec2 q = p / 64.0, fw = max(fwidth(q), vec2(1e-6));
  vec2 k = floor(q + 0.5), d = abs(q - k) / fw;                    // pixels to the nearest 64-unit line, per axis
  float dense = clamp((1.0 / max(fw.x, fw.y) - 3.0) / 6.0, 0.0, 1.0);   // fade where the cells shrink below a few px
  if (t <= 0.0 || max(abs(p.x), abs(p.y)) > uGrid.z + 0.5 || dense <= 0.0) return c;
  bvec2 major = equal(mod(k, 2.0), vec2(0.0));
  vec2 w = vec2(major.x ? 0.7 : 0.45, major.y ? 0.7 : 0.45);
  vec2 cov = clamp(w + 0.5 - d, 0.0, 1.0);
  float cMaj = max(major.x ? cov.x : 0.0, major.y ? cov.y : 0.0), cMin = max(major.x ? 0.0 : cov.x, major.y ? 0.0 : cov.y);
  c = mix(c, vec3(1.0), 0.2 * cMaj * dense);
  return mix(c, vec3(1.0), 0.1 * cMin * dense);
}
// NifSkope's corner axes: X red, Y green, Z blue from the box's middle, the far ones under the near ones
float segment(vec2 p, vec2 a, vec2 b, float hw) {
  vec2 ab = b - a; float h = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return clamp(hw + 0.5 - length(p - a - ab * h), 0.0, 1.0);
}
vec3 axes(vec3 c) {
  if (uAxes.x < 0.5) return c;
  float box = uAxes.y;
  vec2 p = gl_FragCoord.xy, m = vec2(box * 0.5);
  if (p.x > box || p.y > box) return c;
  mat3 R = mat3(uView);
  vec3 ax[3] = vec3[3](R[0], R[1], R[2]);                          // world X, Y, Z in view space
  vec3 col[3] = vec3[3](vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1));
  int ord[3] = int[3](0, 1, 2);                                    // farthest (most negative view z) first
  for (int i = 0; i < 2; i++) for (int j = 0; j < 2 - i; j++) {
    if (ax[ord[j]].z > ax[ord[j + 1]].z) { int s = ord[j]; ord[j] = ord[j + 1]; ord[j + 1] = s; }
  }
  float len = box * 0.3;
  for (int i = 0; i < 3; i++) {
    vec3 v = ax[ord[i]];
    vec2 tip = m + v.xy * len;
    float a = max(segment(p, m, tip, 1.1), clamp(3.5 - length(p - tip), 0.0, 1.0));
    c = mix(c, col[ord[i]], a);
  }
  return c;
}
vec3 hable(vec3 y, float E) {
  return (y * (0.15 * y + 0.05) + 0.20 * E) / (y * (0.15 * y + 0.50) + 0.06) - E / 0.30;
}
// 256x16 strip of a 16^3 LUT (red across a slice, green down, blue = slice). Texel centres sit at g*15/16 + 1/32.
vec3 lutSample(sampler2D L, vec3 g) {
  g = clamp(g, 0.0, 1.0);
  float b = g.b * 15.0, b0 = floor(b), b1 = min(b0 + 1.0, 15.0);
  vec2 p = vec2(g.r * 15.0 + 0.5, g.g * 15.0 + 0.5);
  // explicit LOD: implicit derivatives (and anisotropic filtering) would smear across the strip at colour edges
  vec3 s0 = textureLod(L, vec2((b0 * 16.0 + p.x) / 256.0, p.y / 16.0), 0.0).rgb;
  vec3 s1 = textureLod(L, vec2((b1 * 16.0 + p.x) / 256.0, p.y / 16.0), 0.0).rgb;
  return mix(s0, s1, b - b0);
}
void main() {
  // §12: Ex = clamp(Middle Gray / (adapted luminance + 0.001), Auto Exposure Min, Auto Exposure Max)
  float adapted = texelFetch(uAdapt, ivec2(0), 0).r;
  float ex = uExpo.x > 0.5 ? clamp(uExpo.z / (adapted + 0.001), uAeRange.x, uAeRange.y) * uExpo.y : uExpo.y;
  vec3 hdr = texture(uScene, vUV * uUVScale).rgb;
  if (any(isnan(hdr)) || any(isinf(hdr))) hdr = vec3(0.0);
  float cov = 1.0;
  vec3 back = vec3(0.0);
  if (uBackdrop.a > 0.5) {
    back = backdrop();                                             // (derivatives: before any early return)
    vec2 uv = vUV * uUVScale, tx = 1.0 / vec2(textureSize(uCover, 0));
    cov = clamp(texture(uCover, uv).a, 0.0, 1.0);
    if (cov < 0.004) { o = vec4(axes(back), 1.0); return; }
    if (cov < 0.996) {
      // an edge: the resolved colour mixes the model with the sky / floor behind it; take that background (the
      // mean of the nearby pixels that are all background) out again, so the model's edge blends into the backdrop
      vec3 bg = vec3(0.0); float n = 0.0;
      for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
        vec4 s = texture(uCover, uv + vec2(x, y) * tx);
        if (s.a < 0.004) { bg += s.rgb; n += 1.0; }
      }
      if (n > 0.0) hdr = max((hdr - (1.0 - cov) * bg / n) / cov, 0.0);
    }
  }
  if (uEditor > 0.5) {
    // the editors' look (Even light, editorLook in the lit shaders): back to gamma space, then the editor's own curve
    // (the same filmic curve, scaled so white stays white); no exposure, bloom, grading or LUT
    vec3 e = pow(max(hdr, 0.0), vec3(1.0 / 2.2));
    vec3 g = clamp(hable(e, 0.02) / hable(vec3(1.0), 0.02), 0.0, 1.0);
    if (uBackdrop.a > 0.5) g = axes(mix(back, g, cov));
    o = vec4(g, 1.0);
    return;
  }
  vec3 bloom = texture(uBloom, vUV).rgb;
  vec3 x = (hdr + bloom) * ex;                         // bloom is added before exposure
  vec3 T;
  if (uTonemapMode == 0) T = hable(2.0 * x, uTonemapE) / hable(vec3(uWhite), uTonemapE);
  else if (uTonemapMode == 1) T = x / (1.0 + x);
  else T = clamp(x, 0.0, 1.0);
  float Y = dot(T, vec3(0.2125, 0.7154, 0.0721));
  vec3 c1 = mix(vec3(Y), T, uCinematic.x);
  vec3 c2 = mix(c1, Y * uTintIS.rgb, uTintIS.a);
  vec3 c3 = uCinematic.z * (uCinematic.y * c2 - adapted) + adapted;
  vec3 g = pow(max(c3, 0.0), vec3(1.0 / 2.2));       // plain 2.2 power, not the sRGB curve
  float ws = uLutW.x + uLutW.y;
  if (ws > 0.0) g = (lutSample(uLut0, g) * uLutW.x + lutSample(uLut1, g) * uLutW.y) / ws;
  if (uShowBloom == 1) g = pow(bloom * ex, vec3(1.0 / 2.2));
  g = clamp(g, 0.0, 1.0);
  if (uBackdrop.a > 0.5) g = axes(mix(back, g, cov));
  o = vec4(g, 1.0);
}`;


// ---------------------------------------------------------------------------------------------------------------
// §21 Screen-space ambient occlusion (the game's SAO: bSAOEnable, fSAORadius / fSAOBias / fSAOIntensity). Three
// passes before the lit scene: the solid scene's depth (PREZ_FS, with the main pass's own matrices and jitter), the
// occlusion from that depth (SAO_FS), a depth-aware blur (SAO_BLUR_FS, two directions). The lit shaders read the result
// per pixel. Written fresh from the public SAO method (McGuire, Mara and Luebke 2012) and engine-notes §21.
export const PREZ_FS = COMMON + `
#if CLIP
in vec2 vUV;
uniform sampler2D uDiffuse;
layout(std140) uniform Material { vec4 mUV; vec4 mAlpha; };
#endif
void main() {
#if CLIP
  if (texture(uDiffuse, vUV * mUV.zw + mUV.xy).a < mAlpha.z) discard;
#endif
}`;
// view-space helpers shared by the occlusion and blur passes: uProj = (P00, P11, P20, P21) of the drawing projection
// (jitter included), uNF = (near, far); positions have z = distance in front of the camera (positive)
const SAO_COMMON = `
uniform highp sampler2D uDepth;
uniform vec4 uProj;
uniform vec2 uNF;
uniform vec2 uSize;          // the drawn part of the targets, in pixels
float linZ(ivec2 p) {
  float d = texelFetch(uDepth, clamp(p, ivec2(0), ivec2(uSize) - 1), 0).r * 2.0 - 1.0;
  return 2.0 * uNF.x * uNF.y / (uNF.y + uNF.x - d * (uNF.y - uNF.x));
}
vec3 viewPos(ivec2 p, float z) {
  vec2 ndc = (vec2(p) + 0.5) / uSize * 2.0 - 1.0;
  return vec3((ndc.x + uProj.z) * z / uProj.x, (ndc.y + uProj.w) * z / uProj.y, z);
}
`;
export const SAO_FS = COMMON + SAO_COMMON + `
uniform vec4 uSAO;           // fSAORadius, fSAOBias, fSAOIntensity, footprint scale (render height / 1080)
uniform int uSamples;
uniform float uTurns;
layout(location=0) out vec4 o;
layout(location=1) out float oZ;   // this texel's depth (linZ) for the blur passes (SAO_BLUR_FS uZ): read, not recomputed
void main() {
  // one occlusion texel per 2 x 2 pixels (half resolution, as the game); its pixel in the full-resolution depth
  ivec2 p = ivec2(gl_FragCoord.xy), fp = p * 2;
  float z = linZ(fp);
  oZ = z;
  if (z > uNF.y * 0.99) { o = vec4(1.0); return; }          // the sky: open
  vec3 C = viewPos(fp, z);
  // the face normal from the neighbours' positions (the side with the smaller depth step: no smearing at edges)
  float zl = linZ(fp - ivec2(1, 0)), zr = linZ(fp + ivec2(1, 0)), zd = linZ(fp - ivec2(0, 1)), zu = linZ(fp + ivec2(0, 1));
  vec3 dx = abs(zr - z) < abs(z - zl) ? viewPos(fp + ivec2(1, 0), zr) - C : C - viewPos(fp - ivec2(1, 0), zl);
  vec3 dy = abs(zu - z) < abs(z - zd) ? viewPos(fp + ivec2(0, 1), zu) - C : C - viewPos(fp - ivec2(0, 1), zd);
  vec3 n = normalize(cross(dx, dy));
  if (dot(n, C) > 0.0) n = -n;                               // facing the camera
  // the game's bias: the INI value, more with distance (past 2100 units) and towards the screen's corners
  float key = clamp(z / 7000.0, 0.0, 1.0);
  vec2 ndc = (vec2(fp) + 0.5) / uSize * 2.0 - 1.0;
  float beta = uSAO.y + 10.0 * max(key - 0.3, 0.0) + 5.0 * dot(ndc, ndc);
  float R = uSAO.x, R2 = R * R;
  // in occlusion texels: the game's fixed 100 at 1080p, scaled with the height so the look is the same at any size
  float ssR = 100.0 * R / z * uSAO.w;
  float spin = 10.0 * float((3 * p.x) ^ (p.x * p.y + p.y));
  float sum = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uSamples) break;
    float t = (float(i) + 0.5) / float(uSamples);
    float ang = t * uTurns * 6.28 + spin;
    ivec2 q = fp + ivec2(2.0 * ssR * t * vec2(cos(ang), sin(ang)));
    vec3 v = viewPos(q, linZ(q)) - C;
    float vv = dot(v, v), f = max(R2 - vv, 0.0);
    sum += f * f * f * max((dot(v, n) - beta) / (vv + 0.01), 0.0);
  }
  o = vec4(max(0.0, 1.0 - uSAO.z * sum / (R2 * R2 * R2) * (5.0 / float(uSamples))), 0.0, 0.0, 1.0);
}`;
// the game's blur: 7 taps 2 texels apart, nearly a box, cut where the depth differs by more than ~3.5 units. Taps 2
// apart never mix odd and even texels, and the game's history buffer is what evens those out; without one the four
// interleaved sets keep their own leftover noise (a screen-door pattern where the occlusion is strong). So the kernel
// here is the game's spread over the texels between its taps (x [1/4 1/2 1/4]): 15 taps, odd and even texels weighted
// alike, the same reach plus one texel, each tap still cut by depth.
// The depths come from the occlusion pass (uZ: its linZ(2q), stored exactly); a texel beyond uZ (an odd target width
// or height, where the drawn part is one texel wider than the targets) reads the depth as before.
export const SAO_BLUR_FS = COMMON + SAO_COMMON + `
uniform sampler2D uAOin;
uniform highp sampler2D uZ;
uniform ivec2 uDir;
uniform ivec2 uAOSize;       // the drawn part of the occlusion targets
uniform ivec2 uZSize;        // the size of the targets (uZ, uAOin)
out vec4 o;
float zAt(ivec2 q) { return q.x < uZSize.x && q.y < uZSize.y ? texelFetch(uZ, q, 0).r : linZ(q * 2); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float zc = zAt(p);
  // the sky (and what lies within the cut of it): every tap that counts is open sky, 1 in, so 1 out (the full sum gives
  // at least 0.9987, stored as 1 in R8). Only while every tap lies inside the targets.
  if (zc > uNF.y * 0.99 + 10.0 && uAOSize.x <= uZSize.x && uAOSize.y <= uZSize.y) { o = vec4(1.0); return; }
  float key = zc / 7000.0;
  const float W[5] = float[5](0.153170, 0.444893, 0.422649, 0.392902, 0.0);
  float sum = 0.0, wsum = 0.0;
  for (int k = -7; k <= 7; k++) {
    int a = abs(k);
    float g = (a & 1) == 0 ? 0.5 * W[a >> 1] : 0.25 * (W[a >> 1] + W[(a >> 1) + 1]);
    ivec2 q = clamp(p + uDir * k, ivec2(0), uAOSize - 1);
    float w = g * max(0.0, 1.0 - 2000.0 * abs(zAt(q) / 7000.0 - key));
    sum += texelFetch(uAOin, q, 0).r * w; wsum += w;
  }
  o = vec4(sum / (wsum + 0.0001), 0.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------------------------------------------
// §24 Light shafts (god rays): sunlight scattered towards the eye by the air between it and the scene, darker where
// the sun's shadow maps say the air is in shadow. The weather's GDRY gives the medium: three scattering terms (air:
// Rayleigh; forward: Henyey-Greenstein with g = Fwd Phase; back: Henyey-Greenstein with g = -Back Phase), each a colour
// x scale, and an intensity. Per pixel (half resolution): the scattering integral along the view ray, marched through
// the shadow maps where they reach and in closed form beyond (lit air). Written from the public description of the
// method (single scattering, Beer-Lambert transmittance, the standard phase functions) and engine-notes §24.
export const GODRAYS_FS = COMMON + FRAME + COMMON_FNS + LIGHT_FNS + `
uniform highp sampler2D uDepth;          // the scene's depth (full resolution)
uniform sampler2DShadow uFarMap;
uniform mat4 uFarVP;                     // the far sun map: the cell's casters FAR_R around the camera, coarse
uniform float uFarOn;
uniform mat4 uInvViewProj;               // the drawing view-projection without the camera position, inverted
uniform vec4 uAir, uFwd, uBack;          // scattering per unit length (rgb); w: g of the forward / backward lobe
uniform vec4 uGR;                        // intensity, march length, steps, noise frame
uniform float uMaxDist;                  // the sky and anything further: integrated this far
// spotlights with their own god rays (LIGH WGDR), up to 4: position + radius, axis + cos of half the FOV, colour x
// intensity + shadow slot (-1 none), attenuation constants + cone falloff exponent, their medium (air / forward / back
// scattering per unit, w: g), the near clip of their rays and whether the cone is a shadow spotlight's
uniform int uSpotN;
uniform vec4 uSpotPos[4], uSpotDir[4], uSpotCol[4], uSpotAtt[4], uSpotAir[4], uSpotFwd[4], uSpotBack[4], uSpotX[4];
out vec4 o;
float hg(float mu, float g) { float d = max(1.0 + g * g - 2.0 * g * mu, 1e-4); return (1.0 - g * g) / (4.0 * PI * d * sqrt(d)); }
// sunlight reaching a point of the air: the cell map where it reaches (sharp), else the far map (coarse), times the
// character's map; one hardware-filtered comparison each; outside them all, lit
float sunVis(vec3 P) {
  float v = 1.0;
  bool near = false;
  if (uFlags.x > 0.5) {
    vec4 c = uShadowMat * vec4(P, 1.0); vec3 q = c.xyz / c.w * 0.5 + 0.5;
    if (q.x > 0.02 && q.x < 0.98 && q.y > 0.02 && q.y < 0.98 && q.z <= 1.0) { v = texture(uShadowMap, vec3(q.xy, q.z - 0.0015)); near = true; }
  }
  if (!near && uFarOn > 0.5) {
    vec4 c = uFarVP * vec4(P, 1.0); vec3 q = c.xyz / c.w * 0.5 + 0.5;
    if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0 && q.z <= 1.0) v = texture(uFarMap, vec3(q.xy, q.z - 0.0008));
  }
  if (uFlags.y > 0.5) {
    vec4 c = uShadowMat2 * vec4(P, 1.0); vec3 q = c.xyz / c.w * 0.5 + 0.5;
    if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0 && q.z <= 1.0) v *= texture(uShadowMap2, vec3(q.xy, q.z - 0.0015));
  }
  return v;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), fp = p * 2;
  vec2 vp = uScreen.xy * uRes.xy;
  float d = texelFetch(uDepth, min(fp, ivec2(vp) - 1), 0).r;
  vec4 w4 = uInvViewProj * vec4((vec2(fp) + 0.5) / vp * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 rel = w4.xyz / w4.w;
  float D = length(rel);
  vec3 V = rel / max(D, 1e-4);
  if (d >= 1.0) D = uMaxDist;
  D = min(D, uMaxDist);
  float mu = dot(V, uSunDir.xyz);          // 1: looking into the sun (forward scattering)
  vec3 S = uAir.rgb * (3.0 / (16.0 * PI)) * (1.0 + mu * mu) + uFwd.rgb * hg(mu, uFwd.w) + uBack.rgb * hg(mu, -uBack.w);
  vec3 bt = max(uAir.rgb + uFwd.rgb + uBack.rgb, vec3(1e-9));      // extinction (no absorption)
  float L = min(D, uGR.y);
  int n = int(uGR.z);
  float jit = fract(52.9829189 * fract(0.06711056 * float(p.x) + 0.00583715 * float(p.y)) + uGR.w * 0.618034);
  // steps closer together near the camera (t = L x u^2), where shafts are seen largest
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= n) break;
    float u = (float(i) + jit) / float(n), t = L * u * u, dt = 2.0 * L * u / float(n);
    acc += sunVis(uCamPos.xyz + V * t) * exp(-bt * t) * dt;
  }
  acc += (exp(-bt * L) - exp(-bt * D)) / bt;      // past the shadow maps: lit air, in closed form
  vec3 col = uGR.x > 0.0 ? uGR.x * uSunColor.rgb * S * acc : vec3(0.0);
  // §24 spotlight shafts: the part of the ray inside each light's sphere, marched through its cone, attenuation and
  // shadow map; light reaching a point is dimmed on its way from the light and on to the eye
  for (int k = 0; k < 4; k++) {
    if (k >= uSpotN) break;
    vec3 Lp = uSpotPos[k].xyz - uCamPos.xyz;
    float Rl = uSpotPos[k].w, tc = dot(Lp, V), h2 = Rl * Rl - (dot(Lp, Lp) - tc * tc);
    if (h2 <= 0.0) continue;
    float h = sqrt(h2), t0 = max(tc - h, 0.0), t1 = min(tc + h, D);
    if (t1 <= t0) continue;
    vec3 sa = uSpotAir[k].rgb, sf = uSpotFwd[k].rgb, sb = uSpotBack[k].rgb, be = max(sa + sf + sb, vec3(1e-9));
    vec4 lx = vec4(uSpotAtt[k].w, uSpotX[k].y, -1.0, 0.0);
    float dt = (t1 - t0) / 24.0;
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 24; i++) {
      float t = t0 + (float(i) + jit) * dt;
      vec3 v = V * t - Lp;                       // from the light to the point
      float d = length(v);
      if (d >= Rl || d < uSpotX[k].x) continue;
      vec3 Lv = -v / max(d, 1e-4);               // from the point towards the light
      // the cone first: 0 over most of a narrow spot's sphere, and then the step is skipped below anyway
      float cone = spotCone(uSpotDir[k], -Lv, lx);
      if (cone <= 0.0) continue;
      float att = pow(1.0 - sat(uSpotAtt[k].x + uSpotAtt[k].y * pow(d / Rl, uSpotAtt[k].z)), 2.2) * cone;
      if (att <= 1e-4) continue;
#if LIGHT_SHADOWS
      if (uSpotCol[k].w > -0.5) att *= lightShadow1(int(uSpotCol[k].w + 0.5), v);
#endif
      float m = dot(V, Lv);
      vec3 Sk = sa * (3.0 / (16.0 * PI)) * (1.0 + m * m) + sf * hg(m, uSpotFwd[k].w) + sb * hg(m, -uSpotBack[k].w);
      sum += att * Sk * exp(-be * (t + d));
    }
    col += uSpotCol[k].rgb * sum * dt;
  }
  o = vec4(clamp(col, 0.0, 30000.0), D);
}`;
// depth-aware blur of the half-resolution shafts (alpha: the distance the ray covered), across then down
export const GODRAYS_BLUR_FS = COMMON + `
uniform sampler2D uSrc;
uniform ivec2 uDir, uSize;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uSrc, p, 0);
  vec3 s = c.rgb; float ws = 1.0;
  for (int i = 1; i <= 4; i++) for (int k = -1; k <= 1; k += 2) {
    vec4 e = texelFetch(uSrc, clamp(p + uDir * (i * k), ivec2(0), uSize - 1), 0);
    float w = exp(-float(i * i) / 10.0) * max(0.0, 1.0 - abs(e.a - c.a) / (0.05 * c.a + 20.0));
    s += e.rgb * w; ws += w;
  }
  o = vec4(s / ws, c.a);
}`;
// the shafts added to the HDR scene: each pixel takes the half-resolution texels nearest in distance (no halo of far,
// bright air around near edges)
export const GODRAYS_APPLY_FS = COMMON + FRAME + `
uniform sampler2D uSrc;
uniform highp sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform float uMaxDist;
out vec4 o;
void main() {
  ivec2 fp = ivec2(gl_FragCoord.xy);
  vec2 vp = uScreen.xy * uRes.xy;
  float d = texelFetch(uDepth, fp, 0).r;
  vec4 w4 = uInvViewProj * vec4((vec2(fp) + 0.5) / vp * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  float D = d >= 1.0 ? uMaxDist : min(length(w4.xyz / w4.w), uMaxDist);
  ivec2 h = (fp - 1) / 2, hs = textureSize(uSrc, 0) - 1;
  vec3 s = vec3(0.0); float ws = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 q = clamp(h + ivec2(k & 1, k >> 1), ivec2(0), hs);
    vec4 e = texelFetch(uSrc, q, 0);
    float w = 1.0 / (abs(e.a - D) / (0.02 * D + 10.0) + 0.05);
    s += e.rgb * w; ws += w;
  }
  o = vec4(s / ws, 0.0);
}`;

// ---------------------------------------------------------------------------------------------------------------
// Landscape (cell viewer): the lighting shader with its material inputs taken from up to four texture layers,
// blended by per-vertex weights (base layer + the strongest additional layers of each quadrant), times the LAND
// vertex colours. Layer weights arrive in attribute 6 (unused for skinning here).
export const LAND_VS = MESH_VS.replace('out float vViewZ;', 'out float vViewZ;\nout vec4 vLW;')
  .replace('vUV = aUV; vColor = aColor;', 'vUV = aUV; vColor = aColor; vLW = aWeights;');
export const LAND_FS = LIGHTING_FS
  .replace('out vec4 fragColor;', `out vec4 fragColor;
in vec4 vLW;
uniform sampler2D uLD0, uLD1, uLD2, uLD3, uLN0, uLN1, uLN2, uLN3, uLS0, uLS1, uLS2, uLS3;
vec4 landDiffuse(vec2 uv) {
  return texture(uLD0, uv) * vLW.x + texture(uLD1, uv) * vLW.y + texture(uLD2, uv) * vLW.z + texture(uLD3, uv) * vLW.w;
}
vec2 landNormal(vec2 uv) {
  return (texture(uLN0, uv).rg * vLW.x + texture(uLN1, uv).rg * vLW.y + texture(uLN2, uv).rg * vLW.z
        + texture(uLN3, uv).rg * vLW.w) * 2.0 - 1.0;
}
vec2 landSpec(vec2 uv) {
  return texture(uLS0, uv).rg * vLW.x + texture(uLS1, uv).rg * vLW.y + texture(uLS2, uv).rg * vLW.z + texture(uLS3, uv).rg * vLW.w;
}`)
  .replace('vec4 dif = texture(uDiffuse, uv);', 'vec4 dif = landDiffuse(uv);')
  .replace('vec2 nxy = texture(uNormalTex, uv).rg * 2.0 - 1.0;', 'vec2 nxy = landNormal(uv);')
  .replace('vec2 ss = mFlags.w > 0.5 ? texture(uSpecTex, uv).rg : vec2(0.0);', 'vec2 ss = landSpec(uv);')
  // no palette, glow or cube map on the landscape: 12 layer maps + 2 shadow maps stay within 16 texture units
  .replace('if (mFlags2.z > 0.5) albedo = textureLod(uPalette, vec2(pow(max(dif.g, 0.0), 1.0 / 2.2), mVals.w), 0.0).rgb;', '')
  .replace('texture(uGlowTex, uv).rgb', 'vec3(1.0)')
  .replace('lod = max(lod, log2(max(sqrt(max(dot(rx, rx), dot(ry, ry))) * float(textureSize(uEnvTex, 0).x) * 0.6366, 1.0)));', 'lod = lod;')
  .replace('vec3 cube = textureLod(uEnvTex, dir, lod).rgb;', 'vec3 cube = vec3(0.0);')
  .replace('vec3 cube = srgbEncode(textureLod(uEnvTex, V - 2.0 * dot(N, V) * N, 8.0 - 8.0 * s).rgb);', 'vec3 cube = vec3(0.0);');
// every replace above must hit: a silent miss leaves the landscape reading a sampler on a unit its layers use
for (const k of ['textureSize(uEnvTex', 'textureLod(uEnvTex', 'texture(uDiffuse', 'texture(uGlowTex'])
  if (LAND_FS.includes(k)) console.error(`LAND_FS: lighting shader text changed, "${k}" was not replaced`);

// ---------------------------------------------------------------------------------------------------------------
// §22 Projected decals (placed TXST references: grime, blood, scorch marks, puddles). Each decal is a box; its
// texture is projected along the box's +Y onto whatever solid cell surface lies inside it. The box is drawn by its
// back faces, depth-tested against the scene (GEQUAL: only where a surface lies in front of the far side of the box);
// the fragment shader finds that surface's position from the scene's depth, and lights the decal there with the
// ordinary lit-material body (LIGHTING_BODY), as the game blends its decals into the surfaces before lighting them.
export const DECAL_VS = COMMON + FRAME + `
layout(location=0) in vec3 aPos;       // a corner of the unit box (-0.5 .. 0.5)
layout(location=8) in vec4 iM0;        // the box: its axes (x its size) in iM0-iM2, its centre in iM3; the bottom
layout(location=9) in vec4 iM1;        // row carries the decal's own values (iM0.w: which subtexture)
layout(location=10) in vec4 iM2;
layout(location=11) in vec4 iM3;
flat out vec4 vBoxX; flat out vec4 vBoxY; flat out vec4 vBoxZ; flat out vec4 vBoxO;
void main() {
  vec3 X = iM0.xyz, Y = iM1.xyz, Z = iM2.xyz, O = iM3.xyz;
  // each axis divided by its squared length: a dot product with it gives the box coordinate (-0.5 .. 0.5 inside)
  vBoxX = vec4(X / dot(X, X), iM0.w); vBoxY = vec4(Y / dot(Y, Y), iM1.w); vBoxZ = vec4(Z / dot(Z, Z), iM2.w);
  vBoxO = vec4(O, 1.0);
  gl_Position = uProj * (uView * vec4(O + X * aPos.x + Y * aPos.y + Z * aPos.z, 1.0));
}`;
const DECAL_INPUTS = `
// what the lit body reads from a mesh's vertices, worked out per pixel instead (decalSetup)
vec3 vWorld; vec3 vN; vec3 vBt; vec3 vT; vec2 vUV; vec4 vColor; vec4 vShadow; vec4 vShadow2; float vViewZ;
layout(location=1) out vec4 outVel;    // not kept: decals draw colour only (the surface's own motion stays)
uniform float uReactive;
vec2 motion() { return vec2(0.0); }
flat in vec4 vBoxX; flat in vec4 vBoxY; flat in vec4 vBoxZ; flat in vec4 vBoxO;
uniform highp sampler2D uSceneDepth;   // the solid cell's depth (resolved just before the decals)
// the drawing view-projection (jitter included) without the camera's position, inverted: positions come out relative
// to the camera, small numbers whose differences stay exact (world coordinates reach 100 000 in the Commonwealth, where
// a float keeps only ~0.01 of a unit and the surface normal worked out from neighbours turns to noise)
uniform mat4 uInvViewProj;
uniform vec4 uDecal;                   // rgb: the decal colour (gamma), a: 1 = the texture holds 2 x 2 subtextures
uniform float uDecalMul;               // 1: multiplicative decal (darkens the surface by its colour; blend DST_COLOR x ZERO)
vec3 relAt(ivec2 p) {
  vec2 vp = uScreen.xy * uRes.xy;      // the part of the targets the scene is drawn into
  float d = texelFetch(uSceneDepth, clamp(p, ivec2(0), ivec2(vp) - 1), 0).r;
  vec4 w = uInvViewProj * vec4((vec2(p) + 0.5) / vp * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return w.xyz / w.w;
}
void decalSetup() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 C = relAt(p), W = uCamPos.xyz + C, q = C - (vBoxO.xyz - uCamPos.xyz);
  vec3 l = vec3(dot(q, vBoxX.xyz), dot(q, vBoxY.xyz), dot(q, vBoxZ.xyz));
  if (any(greaterThan(abs(l), vec3(0.5)))) discard;
  // the surface's face normal from the neighbours' positions (the side with the smaller step: no smearing at edges)
  vec3 wl = relAt(p - ivec2(1, 0)), wr = relAt(p + ivec2(1, 0)), wd = relAt(p - ivec2(0, 1)), wu = relAt(p + ivec2(0, 1));
  vec3 dx = dot(wr - C, wr - C) < dot(C - wl, C - wl) ? wr - C : C - wl;
  vec3 dy = dot(wu - C, wu - C) < dot(C - wd, C - wd) ? wu - C : C - wd;
  vec3 n = normalize(cross(dx, dy));
  if (dot(n, C) > 0.0) n = -n;
  // surfaces turned away from the projection get nothing; edge-on ones fade out (the texture smears along them)
  vec3 Yd = normalize(vBoxY.xyz);
  float facing = -dot(n, Yd);
  if (facing <= 0.05) discard;
  vec3 Xd = normalize(vBoxX.xyz), Zd = normalize(vBoxZ.xyz);
  vec2 uv = vec2(l.x + 0.5, 0.5 - l.z);
  if (uDecal.a > 0.5) uv = uv * 0.5 + vec2(mod(vBoxX.w, 2.0), floor(vBoxX.w * 0.5)) * 0.5;
  vUV = uv;
  vWorld = W; vN = n;
  vBt = Xd - dot(Xd, n) * n;           // normal map red: along +u
  vT = Zd - dot(Zd, n) * n;            // green: towards the top of the image (-v)
  vColor = vec4(uDecal.rgb, smoothstep(0.05, 0.3, facing));
  vShadow = uShadowMat * vec4(W, 1.0); vShadow2 = uShadowMat2 * vec4(W, 1.0);
  vViewZ = -(uView * vec4(W, 1.0)).z;
}
`;
export const DECAL_FS = COMMON + FRAME + COMMON_FNS + DECAL_INPUTS + LIT_MATERIAL + LIGHTING_BODY
  .replace('void main() {\n  vec2 uv = vUV', 'void main() {\n  decalSetup();\n  vec2 uv = vUV')
  .replace(/gl_FrontFacing/g, 'true')
  // a multiplicative decal leaves the surface's light as it is and darkens it by its own colour, faded by its alpha:
  // it needs only its albedo and alpha, so it returns before the lighting (uniform branch; same value as below)
  .replace('albedo = mix(albedo, gammaToLinear(softLight(linearToGamma(albedo), uTint.rgb)), tintAmount);\n', `$&  if (uDecalMul > 0.5 && int(mDebug.x) == 0) {
    fragColor = vec4(mix(vec3(1.0), albedo, sat(alpha)), 1.0); outVel = vec4(motion(), uReactive, 1.0); return;
  }
`)
  .replace('fragColor = vec4(color, mAlpha.w > 0.5 ? alpha : 1.0);',
    'fragColor = uDecalMul > 0.5 && dbg == 0 ? vec4(mix(vec3(1.0), albedo, sat(alpha)), 1.0) : vec4(color, mAlpha.w > 0.5 ? alpha : 1.0);');
for (const k of ['decalSetup();', 'uDecalMul > 0.5 && int(mDebug.x) == 0', 'uDecalMul > 0.5 && dbg'])
  if (!DECAL_FS.includes(k)) console.error(`DECAL_FS: lighting shader text changed, "${k}" was not inserted`);
