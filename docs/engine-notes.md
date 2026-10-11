# Engine notes: how Fallout 4 shades a frame

Written 2026-10-05 for FO4 Lightbox. These are clean-room notes: what the game computes, written as
maths and plain numbers. They were worked out by studying the compiled shaders that ship with the
game on this machine (`Fallout4 - Shaders.ba2`), read-only. No Bethesda code, bytecode or
disassembly is in this project. The evidence trail (which shader, which instructions) is kept outside
the project in `_LightboxResearch_PRIVATE\shaders\SHADERS_EVIDENCE.md`; section numbers there match
the topics here.

**Confidence labels**
- **High:** the formula and its constants come straight from the game's shader maths.
- **Medium:** the formula is clear, but what the engine feeds into it (or the field name) is inferred.
- **Low:** inference or a best guess. Calibrate it against the game before relying on it.

Notation used throughout:
- Vectors are unit length. N is the shaded normal, V points from the surface to the eye, L points from
  the surface to the light, and H = normalize(V + L).
- NV = sat(N·V), NL = sat(N·L), NH = sat(N·H), VH = sat(V·H). sat() clamps to [0, 1].
- s = smoothness, r = 1 - s, k = specular intensity, a = linear albedo.
- Colours are linear unless they are called "gamma".

---

## Porting checklist

1. **Textures:** decode diffuse, palette and effect base textures as sRGB. Read normal and `_s` maps
   as linear. The game's own re-encode uses a plain 2.2 power, so pow 2.2 is equally faithful.
2. **Vertex colours:** in lighting materials, use rgb^2.2 and leave alpha linear. In effect materials,
   raise all four channels, alpha included, to the power 2.2.
3. **Normal map:** nx = 2R - 1, ny = 2G - 1, nz = sqrt(1 - min(nx² + ny², 1)). Don't flip green.
   - The world normal is normalize(nx·B + ny·T + nz·N).
   - B is the NIF "bitangent" (the three per-vertex Bitangent X/Y/Z values) and T is the NIF "tangent".
   - On back faces of two-sided meshes, negate nz only.
4. **Smoothness:** s = `_s`.G × material Smoothness. **Specular:** k = `_s`.R × material Specular
   Mult. The deferred path ignores the specular colour.
5. **Sun diffuse:** use the modified Oren-Nayar with r = 1 - s (section 4), plus three extra terms:
   a roughness sheen, backlight (× albedo) and wrap (× albedo). The final composite multiplies the
   whole diffuse sum by albedo again.
6. **Sun specular:** normalised Blinn-Phong with exponent n = 2^(10s + 1). Use the Cook-Torrance
   geometry term and Schlick Fresnel with F0 = 0.2. The result is min(15, D·F·G/(4·NV)) × π × k × NL
   × light colour.
7. **Ambient:** a 3×4 matrix built from the weather's directional ambient (DALC).
   - Evaluate it in **gamma space** on (N, 1), then apply ^2.2.
   - Ambient specular is the same matrix evaluated on the reflection vector, times
     k × 0.25 × (1 - NV)^(3 - s).
   - No shader term reads the DALC specular colour or the Fresnel-power/"Scale" value.
8. **Environment map:** sample the cube along **V - 2(N·V)N in world space**. That is the *negated*
   reflection vector, with no axis swizzle.
   - Mip level: 6·(1 - s) + viewDepth/512.
   - Strength: sqrt(sat(s - 0.3)) × 3k × EnvMapScale × (the total diffuse light at that pixel).
   - There is no Fresnel term.
9. **Composite:** colour = emissive + total specular + total diffuse × albedo + environment. Then apply
   fog.
10. **Tonemap:** Hable/Uncharted-2 with A = 0.15, B = 0.50, C = 0.10, D = 0.20, F = 0.30.
    - E = the imagespace "Tonemap E" (vanilla 0.02), and white = 11.2.
    - The curve input is 2 × (HDR + bloom) × exposure.
    - Exposure = clamp(Middle Gray / (adapted luminance + 0.001), Auto Exposure Min, Auto Exposure Max).
11. **Cinematic:** saturation and tint around Rec.709 luminance. Contrast pivots on the **adapted scene
    luminance**, not on 0.5.
12. **Output:** encode with a plain power 1/2.2 (not the sRGB curve), then optionally apply the 16³ LUT.
    Write that value to the canvas with no further sRGB conversion.

---

## 1. Order of a frame

Confidence: high for the structure, medium for the exact placement of TAA.

1. **G-buffer pass.** Opaque and alpha-tested lit geometry (BSLightingShaderProperty / BGSM) writes
   these targets:
   - albedo, plus the backlight power in its alpha;
   - normal, view space, two-channel sphere-map encoding;
   - environment data: cube-map slot, env scale and an SSR flag;
   - smoothness, specular, wrap/rolloff and material ID;
   - emissive;
   - motion vectors.
   Alpha-blended lit geometry uses a variant that *blends its attributes into the G-buffer* (section 9).
2. **Light pass.** The sun with directional ambient, then point and spot lights. Each adds into two
   buffers, diffuse light and specular light. The diffuse buffer is stored at one third and multiplied
   by 3 when read back, so the net effect is nothing.
3. **Composite.**
   - colour = emissive + specular + diffuse × albedo + environment reflection;
   - then distance/height fog;
   - pixels tagged as material 2 or 3 are left for other passes.
4. **Forward passes:** effect shaders (BSEffectShaderProperty / BGEM), water, sky and particles, with
   per-vertex fog.
5. **HDR.**
   - Downsample, measure average luminance, adapt it over time.
   - Bloom: threshold, scale and blur.
   - Tonemap with exposure, then cinematic and fade.
6. **Temporal anti-aliasing,** on clamped LDR colour, so after the tonemap.
7. **Final.** Apply the 1/2.2 power, blend up to four 16³ colour LUTs, then present.

---

## 2. Textures, vertices and colour spaces

### Colour space of inputs
- **Diffuse and palette textures are decoded to linear by the hardware (sRGB view).** Confidence:
  medium-high, inferred from consistent evidence.
  - Wherever the game needs the original stored value, it re-encodes with a 1/2.2 power. It does this
    for the skin-tint blend and for the greyscale-to-palette lookup coordinate.
  - The resulting colour is then used directly as linear albedo.
- **Effect base textures are sRGB-decoded too.** Their palette lookup re-encodes the green channel with
  1/2.2. Confidence: medium-high.
- **Normal and `_s` maps are linear.** The shader uses their raw values for vector maths and for
  smoothness. Confidence: high.
- **Glow (emissive) and environment cube maps: unknown.** The shader does not convert them, so the
  binding decides.
  - Recommendation: treat both as sRGB colour data. Confidence: low.
- **Texture alpha is always linear.** Confidence: high.
- **Colour constants arrive linear.** Confidence: medium. This covers base colour, tint and presumably
  the emissive colour: the engine applies a 2.2 power on the CPU. The shader undoes it (1/2.2) wherever
  it needs the authored value.
- **Directional ambient is the exception.** It is evaluated in gamma space and linearised per pixel
  (section 5). Confidence: high.

### Vertex data (lighting materials)
- **UV** = uv × (UScale, VScale) + (UOffset, VOffset), from the material. Confidence: high for the
  form, medium for the field mapping.
- **Vertex colour:** rgb^2.2 multiplies the albedo. Raw alpha multiplies the diffuse alpha for the
  alpha test. Confidence: high.
- **Tangent frame:** the normal map's red channel follows the vector made from the three per-vertex
  "Bitangent X/Y/Z" values, and green follows the "Tangent" vector. Confidence: high.
  - Bitangent X is stored in the position's 4th component, Y in the normal's 4th and Z in the
    tangent's 4th.
- **No green flip.** Normal maps are DirectX-style as stored. Confidence: high.
- **Back faces of two-sided materials:** only the tangent-space z of the normal is negated before the
  frame is applied. Confidence: high.
- **Model-space normal maps** (the MSN flag): normal = 2·rgb - 1, read as model-space
  (X, Y, Z) = (R, B, G).
  - On back faces the G-derived component is negated.
  - Confidence: medium. The axis assignment depends on the matching vertex shader.

---

## 3. Material inputs: what feeds each term

Material IDs carried in the G-buffer:
- default: no special branch;
- 1: hair, with its own specular (section 13);
- 5: skin, with a separate screen-space subsurface pass not traced here;
- 2 and 3: skipped by the composite.

| Quantity | Game formula (dry) | Source fields (BGSM / NIF) | Confidence |
| --- | --- | --- | --- |
| Albedo | diffuse.rgb × vc.rgb^2.2 | Diffuse texture | High |
| Albedo with palette | Palette(U = diffuse.G^(1/2.2), V = palette scale), mip 0; replaces the diffuse rgb | Greyscale texture, GrayscaleToPaletteScale (NIF "Grayscale to Palette Scale") | High (shader), medium (field) |
| Albedo with skin tint | Soft-light blend in gamma space (section 13) | TintColor (rgb) and its amount | High (shader), medium (field) |
| Smoothness s | `_s`.G × Smoothness | `_s` texture, Smoothness | High |
| Specular k | `_s`.R × SpecularMult | `_s` texture, SpecularMult (NIF "Specular Strength") | High |
| Specular colour | Not used by the deferred lighting | SpecularColor | High (absence) |
| Backlight b | Multiplies albedo × sat(-N·L) × sun colour | BackLightPower (NIF "Backlight Power") | Medium (field) |
| Wrap / rolloff w | Wrap term in section 4 | SubsurfaceLightingRolloff (NIF "Subsurface Rolloff") | Medium (field) |
| Emissive | EmissiveColor × glow.rgb (glow map), or EmissiveColor alone; added unlit | Glow texture, EmittanceColor (× EmittanceMult, presumably premultiplied) | High (shader), medium (fields) |
| Env scale | 0 to 50, see section 6 | EnvironmentMappingMaskScale (NIF "Environment Map Scale") | Medium (field) |
| Env cube | Per-material cube, used through a cube-array slot | EnvmapTexture (NIF texture slot 4) | Medium |
| Alpha test | Discard when diffuse.a × vc.a < ref | NiAlphaProperty threshold / 255 | High |
| Alpha (blended) | Material alpha × (diffuse alpha if enabled) | Alpha, blend flags | Medium |

**Rim lighting.** No term was found that matches a rim-light power. The deferred sun has a fixed
"roughness sheen" instead (section 4). Confidence: medium.

---

## 4. Sun (directional light)

Confidence: high for the maths. The sun colour fed in is presumably the weather's sunlight colour ×
the imagespace Sunlight Scale (that multiplication is CPU-side; medium).

**Diffuse terms** (each is later multiplied by albedo in the composite):

- **Modified Oren-Nayar** (σ = r = 1 - s; c_v = N·V and c_l = N·L, raw, unclamped):

      A  = 1 - 0.5·σ² / (σ² + 0.57)
      B  = 0.45·σ² / (σ² + 0.09)
      P  = max(0, (V - c_v·N) · (L - c_l·N))           (projections are NOT normalised)
      Q  = sqrt(sat((1 - c_v²)(1 - c_l²))) / max(c_v, c_l)
      ON = max(c_l, 0) · (A + B · P · Q)

  Because the projections are not normalised, the B term carries an extra sinθv·sinθl factor compared
  with textbook Oren-Nayar. Copy it as written.

- **Roughness sheen** (forward-scatter toward a viewer looking at the light):

      Sheen = σ · sat(V · (-L)) · (1 - NV)^0.01 · NL

  The (1 - NV)^0.01 factor is close to 1 except at exactly head-on view.

- **Backlight:** Back = a · b · sat(-(N·L)).

- **Wrap:** Wrap = a · max(0, sat((N·L + w) / (1 + w)) - NL).

- **Sun diffuse light:**

      E_sun = SunColour · shadow · (ON + Sheen + Back + Wrap)

  Back and Wrap already contain albedo once. After the composite multiply they scale with albedo².
  This matches the game.

**Specular:**

      n  = 2^(10·s + 1)                       (2 .. 2048)
      D  = (n + 2) / (2π) · NH^n
      G  = min(1, 2·NH·NV / VH, 2·NH·NL / VH)
      F  = min(1, 0.2 + 0.8·(1 - VH)^5)
      S_sun = SunColour · shadow · k · π · NL · min(15, D · F · G / (4·NV))

- The 1/NL of Cook-Torrance cancels against the NL factor. The π converts the irradiance-style light
  colour.
- There is no 1/π on the diffuse terms.
- A per-frame weather value, probably the rain level, softens the sun specular when it is above 0:
  - it multiplies n by 1 - 0.98·w;
  - it multiplies S_sun by 1 - 0.5·w;
  - here w = 1 - (1 - rain)^5.
  - It is 0 in clear weather, and the viewer should keep it at 0. Confidence: low for what the value is.

---

## 5. Ambient (directional ambient, DALC)

Confidence: high for the shader side; low for the CPU conversion.

- **The engine turns the six DALC colours into three rows, one per colour channel,** each of the form
  (ax, ay, az, b). The shader evaluates the rows in gamma space and then linearises:

      amb(d) = ( row_R·(d,1), row_G·(d,1), row_B·(d,1) ) ^ 2.2
      E_amb  = amb(N)
      S_amb  = k · 0.25 · (1 - NV)^(3 - s) · amb(R),   R = 2(N·V)N - V   (standard reflection)

  - The shader clamps nothing. Clamp the row results at 0 before the power, to avoid NaN.
  - Hair (material 1) gets no ambient specular.
- **Converting six colours to rows is CPU work and is not visible in the shaders.** The natural
  least-squares fit, per channel, in 0-1 gamma units:

      ax = (X+ - X-)/2,  ay = (Y+ - Y-)/2,  az = (Z+ - Z-)/2,  b = (X+ + X- + Y+ + Y- + Z+ + Z-)/6

  - This reproduces each axis colour exactly when its two opposite colours have equal sums.
    Confidence: low.
  - **Which slot faces world up is not visible in the shaders.** `weather-notes.md` §5 finds the
    sky-blue colour in the Z- slot. Using Z- for up-facing normals agrees with that.
  - **In-game check (§19):** with this fit and Z- up, shadowed ground matched the game within 2 levels
    of 255 per channel in clear and overcast noon, sky-blue tint included. A flat ambient (the
    weather's NAM0 "Ambient" from every direction) gave grey shadows. The viewer uses this fit.
- **The DALC "Specular" colour and the extra float (Fresnel power / "Scale") are not read by any
  shader in the pack.** If the engine uses them, it folds them in on the CPU. Confidence: high for
  their absence from the shaders.
- **Ambient adds to the light buffers.** E_amb goes into the diffuse buffer (so it is multiplied by
  albedo later) and S_amb into the specular buffer.

---

## 6. Environment / cube-map reflection (BSLightingShader)

Confidence: high for the maths; medium for the field mapping and the cube-map colour space.

- **Enabled** when the material has an environment cube. The engine gives it a slot in a cube-map
  array.
- **Direction:** V - 2(N·V)N, in world space with Z up and no swizzle. This is the negative of the
  usual reflection vector R.
  - A cube uploaded face-for-face from the DDS into WebGL keeps D3D's face orientation.
  - To match the game, sample it with -R_world.
- **Mip level:** 6·(1 - s) + z_view/512.
  - z_view is the view-space depth in game units, about 1.43 cm per unit, so the level grows by 1 per
    512 units (about 7.3 m).
  - The vanilla `mipblur` cubes are built for this.
- **Weather desaturation:** the cube colour is pulled toward its Rec.601 luma (0.299, 0.587, 0.114)
  by 0.9 × the same rain value as in section 4. That is 0 in the viewer.
- **Strength:**

      Env = cube · sqrt(sat(s - 0.3)) · 3·k · envScale · E_total

  - E_total is the pixel's **total diffuse light**: sun + ambient + lights, *before* albedo. So
    reflections darken in shadow and brighten in sunlight.
  - Smoothness at or below 0.3 gives no reflection.
  - envScale is stored with a square-root companding into 0..1, so its useful range is 0 to 50.
  - There is **no separate env-mask texture** for BSLightingShader, and **no Fresnel term**. The `_s`
    red channel (through k) and smoothness are the mask.

---

## 7. Composite and emissive

Confidence: high.

    C = Emissive + (S_sun + S_amb + S_lights) + a·(E_sun + E_amb + E_lights) + Env

- Emissive is added unlit, without albedo, and goes through the HDR pipeline, so values above 1 bloom.
- Output alpha is the albedo alpha. That is meaningful only for the blended path.
- Fog is applied after this (section 10).

---

## 8. Point and spot lights (brief)

- **Attenuation:**

      att = (1 - sat(c0 + c1·(d/R)^c2))^2.2

  - R is the light radius, and c0, c1, c2 are per-light engine constants.
  - The effect shader and the forward lighting shader hard-code the special case
    att = (1 - (d/R)²)^2.2. That suggests c0 = 0, c1 = 1, c2 = 2. Confidence: medium.
- **Deferred point lights add att × LightColour × (ON + Sheen)** to the diffuse buffer, with the same
  roughness. They have no backlight or wrap term. Confidence: high.
- **The point-light variants found write no specular.** Specular for local lights comes from a tiled
  light pass that was not traced. For the viewer, use the sun specular formula × att. Confidence: low.
- **Spot cone:** the effect shader computes
  sat(1 - (1 - L·spotDir) / (1 - cosAngle))^SpotPower. Confidence: medium.

---

## 9. Alpha: test and blend (lit materials)

- **Alpha test:** discard when diffuse.a × vc.a < threshold/255. Confidence: high.
- **Alpha blend:** FO4 does **not** forward-shade alpha-blended BSLightingShader geometry. A G-buffer
  variant writes coverage into every target's alpha, so hardware blending mixes albedo, normal,
  smoothness/specular and emissive with the surface behind. The mix is lit once afterwards.
  Confidence: medium-high.
  - coverage = material alpha × (diffuse alpha, when texture alpha is enabled).
  - Coverage below 4/255 is discarded.
- **Viewer approximation:** forward-shade and blend the lit colours. This only differs where blended
  layers overlap other surfaces with different lighting.

---

## 10. Fog

The structure is high confidence. Mapping the constants to WTHR fields is medium: it follows the
weather fields in `weather-notes.md` §6. The same fog runs per-vertex on effect shaders. On opaque
geometry it runs per pixel in the composite.

    f        = (d - Near) / (Far - Near)             d = distance from the camera
    fd       = sat(f)
    maxTerm  = FogMax                                 if f <= 0.75
             = min(1, FogMax + (1 - FogMax)·4·(fd - 0.75))   if f > 0.75
    amount0  = min(maxTerm, fd^FogPower)
    nearFade = fd / 0.015 if f < 0.015, else 1
    hN, hF   = sat((z - NearHeightMid) / NearHeightRange), same with the far pair   (z = world height)
    h        = lerp(hN, hF, fd)
    density  = lerp(1, HighDensityScale, h)
    colour   = lerp( lerp(FogNear, FogFar, amount0), lerp(FogNearHigh, FogFarHigh, amount0), h )
    amount   = density · amount0 · nearFade
    result   = lerp(C, colour, amount)

The exact midpoint/range form is inferred from a scale-and-offset pair (low).

**Opaque composite only:**
- The fog colour is tinted toward a sun-glare colour by Scale·max(0, viewDir·sunDir)^Power.
- When amount < FogMax, the fog colour is pulled toward the scene's grey level g = (R+G+B)/3 by
  lerp(colour, g, g).

**Effect shaders:** additive effects darken by (1 - amount) instead of lerping to the fog colour, and
multiplicative effects lerp toward white by sat(1.5 × amount).

For a viewer at close range, fog is negligible. Implement it last.

---

## 11. Effect shader (BSEffectShaderProperty / BGEM)

Forward-rendered into the HDR buffer, unlit unless Lighting Influence > 0. Confidence: high for the
maths; medium for the field names.

1. **Base colour:**
   - With a base texture: c = tex.rgba × BaseColor.rgba. BaseColor is linear rgb, raw alpha.
   - Without one: c = BaseColor.
2. **Vertex colour:** c ×= vc^2.2, **all four channels**.
3. **Falloff** (computed per vertex; angles are cosines as stored in the NIF):

       t = sat((|N·V| - StartAngle) / (StopAngle - StartAngle))
       falloff = lerp(StartOpacity, StopOpacity, t²·(3 - 2t))      (1 when falloff is off)

   The alpha is multiplied by falloff.
4. **Greyscale to palette colour:**

       rgb = Palette( U = tex.G^(1/2.2),  V = BaseColor.R^(1/2.2) · falloff · soft ) · BaseColorScale
       alpha = tex.A · BaseColor.A · falloff · soft

   - The palette row comes from the **red channel of Base Colour**, not from a separate scale field.
   - BaseColorScale (the emissive multiple) appears in the shader only in this mode. Elsewhere the
     engine presumably premultiplies it into BaseColor. Confidence: low.
5. **Greyscale to palette alpha:**

       alpha = PaletteAlpha( U = tex.A, V = (PropertyAlpha · BaseColor.A)^(1/2.2) · falloff )

   The rgb stays tex × BaseColor.
6. **Environment:**

       c.rgb += Cube(V - 2(N·V)N) · EnvmapScale · normalMap.A · envMask.R

   - Hardware mip selection and no Fresnel.
   - The normal map is decoded as in section 2.
7. **Lighting influence:**

       c.rgb = lerp(c.rgb, c.rgb · Light, LightingInfluence)

   - With the effect lighting flag, Light = (sum of up to 4 point/spot lights with attenuation
     (1 - (d/R)²)^2.2) + the directional/ambient light colour. Effects ignore N·L.
   - Without the flag, Light is a per-object "property colour" supplied by the engine. For the viewer
     use (1, 1, 1), or the scene ambient. Confidence: low.
8. **Soft particles:** alpha ×= sat((sceneDepth - fragmentDepth) / SoftFalloffDepth). A second
   near-camera fade applies a smoothstep over the first ~0.5 units of the range. Confidence: medium.
9. **Alpha output and test:**
   - Output alpha = c.a × property alpha.
   - Discard when the output alpha < AlphaTestRef.
   - A second optional cut-off discards texels whose alpha exceeds an upper bound (dissolve-style).
10. **Fog:** section 10, with the blend-mode variants.

---

## 12. HDR, bloom, tonemap, cinematic

Confidence: high for the shader maths; the IMGS field mapping is high (it was checked against vanilla
values; see the end of this section).

**Adapted luminance.** Rec.709 luminance (0.2125, 0.7154, 0.0721) of the HDR frame is averaged
(arithmetic, not log) over a downsample chain. The adapted value moves toward it each frame:

    Lad ← Lad + (Lavg - Lad) · rate        (rate from Eye Adapt Speed and frame time; formula not visible)

A NaN result keeps the previous value.

**Exposure:**

    Ex = clamp( MiddleGray / (Lad + 0.001),  AutoExposureMin,  AutoExposureMax )

**Bloom:**

    bright = max(HDR - BloomThreshold, 0) · BloomScale

- It is blurred separably with a 15-tap Gaussian at reduced resolution. The weights from the centre
  out are 0.1177, 0.11299, 0.09997, 0.08151, 0.06125, 0.04242, 0.02708, 0.01593.
- The compute path clamps the result to at most 1.
- Narrower 3- to 13-tap variants exist.
- Bloom is **added to the scene before exposure**.

**Tonemap** (Hable "Uncharted 2" form, exposure bias 2, white 11.2):

    F(y) = ( y(0.15y + 0.05) + 0.20·E ) / ( y(0.15y + 0.50) + 0.06 ) - E/0.30
    T    = F( 2 · (HDR + bloom) · Ex ) / F(11.2)            E = Tonemap E (vanilla 0.02)

**Cinematic** (Y = Rec.709 luminance of T):

    c1 = lerp(Y, T, Saturation)
    c2 = lerp(c1, Y · TintColour, TintAmount)
    c3 = Contrast · (Brightness · c2 - Lad) + Lad          (contrast pivots on the adapted luminance)
    c4 = lerp(c3, FadeColour, FadeAmount)                  (imagespace-modifier fade)

**Exclusions:**
- Pixels the engine marks with a special mask (value 4, used for some screen/UI surfaces) skip the
  tonemap entirely.
- Sunlight Scale and Sky Scale are not in the tonemap. They scale the sun colour and the sky before
  lighting.

**IMGS fields** (FO4Edit names, checked against vanilla values, e.g. DefaultImageSpaceF4):

| Record part | Values, in order |
| --- | --- |
| HNAM | Eye Adapt Speed 10, Tonemap E 0.02, Bloom Threshold 0.33, Bloom Scale 0.1, Auto Exposure Max 10, Auto Exposure Min 0.5, Sunlight Scale 1, Sky Scale 1, Middle Gray 0.18 |
| CNAM | Saturation, Brightness, Contrast (all 1 by default) |
| TNAM | Amount, then the R, G, B colour |
| TX00 | LUT path |

E = 0.02 and Middle Gray 0.18 are the textbook values, which confirms the mapping.

---

## 13. LUT and output

Confidence: high.

    g   = c4^(1/2.2)                                     per channel, plain power
    out = Σ_i w_i · LUT_i( g · 15/16 + 1/32 )            up to 4 LUTs of 16³, weights sum to 1

- Without a LUT the output is g.
- The result goes to the swap chain as is. The display encoding is therefore a **2.2 power, not the
  sRGB curve**.
- The LUTs come from IMGS TX00, for example `Effects\LUTs\LUT_CW_ClearDAY.DDS`. They are blended by
  weather and imagespace-modifier weights.
- Clamp c4 at 0 before the power. Contrast can push values negative.

---

## 14. Skin and hair (brief)

- **Skin tint** (TintColor on face/skin materials). Confidence: high for the maths, medium for the
  field. Per channel, in gamma space:
  - b = a^(1/2.2) and t = TintRGB^(1/2.2);
  - r = 2bt + b²(1 - 2t) when t < 0.5, otherwise sqrt(b)(2t - 1) + 2b(1 - t);
  - a' = lerp(a, r^2.2, TintAmount).
  This is the soft-light blend. The pixel is tagged as skin (material 5) for the subsurface pass,
  which was not traced.
- **Where the tint colour comes from** (plugin data, 2026-10-06). Confidence: medium-high.
  - Each `NPC_` record carries `QNAM` ("texture lighting"): four floats, RGB in 0-1 plus 1.0 (no tone: zeros,
    or a neutral 0.502 grey, which leaves soft light unchanged).
  - The Player record (`0x000007`) stores 0.914 / 0.855 / 0.847, which is HumanSkinBase02 (233, 218, 216) / 255.
    Its skin-tone tint layer (template index 1156) names the same colour at value 100.
  - Nora (`MQ101PlayerSpouseFemale`, `0x0A7D35`) stores HumanSkinBase01 (247, 239, 238).
  - HumanRace's skin-tone layer (TETI slot 12) offers 13 CLFM presets, HumanSkinBase01-13, all with blend
    operation 3 (soft light). So the face tint's skin-tone layer and the body's SkinTint use the same colour
    and the same blend.
  - The viewer uses t = QNAM rgb and TintAmount = the fourth float. It tints SkinTint and FaceTint materials;
    the face's other tint layers are not built.
  - Check against the noon shot (A_3): the vanilla hand texture alone renders dark brown, while with the Player
    tone the lit hand matches the game's pale hand.
- **Hair** (material 1) replaces the sun specular with a two-lobe shifted-tangent (Kajiya-Kay style)
  model. Confidence: medium.
  - The G-buffer carries a hair tangent from a flow texture.
  - The two lobes have per-frame strengths, exponents and shift angles.
  - The secondary lobe also brightens diffuse, capped by the albedo alpha.
  - Not needed for packs.

---

## 15. Wetness (all off in the viewer)

A per-frame world wetness value (0 in dry weather) activates the BGSM wetness controls. Confidence:
high for the shader side. With wetness 0, every term reduces to the dry formulas above.

When it is above 0, the game:
- darkens albedo by 1 - wet × darkening;
- raises specular toward 1;
- lerps smoothness, specular and env scale toward the WetnessControl values;
- can enable SSR.

BGSM wetness values of -1 mean "unused".

---

## 16. Forward lit variant (for reference)

A small forward version of the lighting shader also exists. It has a cascaded sun shadow, up to about 6
point lights and a **flat** ambient colour (no directional ambient). Its use is not certain;
interface/menu rendering is plausible. It differs from the deferred path as follows:
- its Oren-Nayar roughness uses the material Smoothness only, without the `_s` map;
- its sheen weight is 3 - 3/(1 + e^(8.66·(2r - 1))) instead of r;
- its output alpha is the constant material alpha.
Don't use it as the main model. Confidence: medium.

---

## 17. Confidence summary

| Topic | Confidence | Notes |
| --- | --- | --- |
| Tonemap curve, exposure clamp, bloom-before-exposure, cinematic order | High | IMGS mapping confirmed by vanilla values |
| Output 2.2 power + 16³ LUT blend | High | |
| Eye adaptation | High (shader), Low (rate) | Arithmetic mean of Rec.709 luminance; rate formula CPU-side |
| Bloom threshold/scale/blur | High (form), Medium (chain sizes) | |
| Normal-map decode, TBN assignment, back-face rule | High | |
| Diffuse/palette textures sRGB, normal/`_s` linear | Medium-High / High | Inferred from re-encoding in the shaders |
| Glow and cube colour space | Low | Not determined by the shaders |
| Smoothness/specular from `_s` × material | High | Squared factor only when wetness controls are active |
| Sun BRDF (Oren-Nayar variant, sheen, backlight, wrap, Blinn-Phong/CT spec, F0 0.2, cap 15) | High | |
| Ambient as gamma-space linear-in-N matrix, ^2.2, ambient specular form | High | |
| DALC six colours to matrix, up-axis slot | Medium | CPU-side; least-squares fit with Z- up matched the game's shadow colour (§19) |
| DALC specular colour / Fresnel power unused by shaders | High | Absence |
| Env map: negated reflection, mip rule, sqrt(s - 0.3), × 3k × envScale × diffuse light | High | Field mapping medium |
| Composite sum and emissive | High | |
| Point light attenuation | Medium | Local-light specular path not traced |
| Alpha test / G-buffer alpha-blend path | High / Medium-High | |
| Fog formula | High (form), Medium (field mapping) | |
| Effect shader (base, falloff, palette, env, lighting, fog modes) | High (maths), Medium (field names) | |
| Skin tint | High | |
| Hair | Medium | Brief only |

## 18. Open questions to calibrate in game

1. **DALC conversion:** the six colours to rows, and which slot faces up.
2. **Glow and cube maps:** sRGB or linear.
3. **Sun colour scaling:** whether the sun colour is exactly linear(Sunlight) × Sunlight Scale.
4. **Base Colour Scale** for non-palette effects: premultiplied, or ignored.
5. **Adaptation:** the eye-adaptation rate as a function of Eye Adapt Speed and frame time.
6. **Bloom:** downsample sizes and blur radius.
7. **Point lights:** the specular path for local lights, and the attenuation constants.
8. **Effect "property colour":** what the engine feeds as the per-object colour when lighting is off.

## 19. In-game calibration results (2026-10-05)

Measured from Bman's screenshots (NifViewer mode: no SSAO, god rays, DOF or motion blur) against viewer
renders of the same setup: Vault 111 suit with the Mountaineer's Backpack on landscape asphalt at Red
Rocket, FOV 55. The tools and shots stay in the private research folder. "Calibrated" below means a value
was fitted to these shots, not read from the engine.

- **Sun path (calibrated).** Shadow directions and lengths in three top-down shots (09:00, 12:00, 15:00)
  and the noon and morning setups fit a sun on a circular sky path with latitude 76.6° and declination
  34°, solar noon midway between the middles of the climate's sunrise and sunset windows (13:00 in
  DefaultClimate):
  - 12:00: elevation 46.8° (measured 44.6-48°);
  - 07:00: 33° (measured about 33°).
  - The sun never gets low. At night the light runs back along the same arc, west to east, which put
    the 22:00 moonlight in the south-west as in the night shots. The game's night light looked somewhat
    lower (about 34° against 43°).
- **Ambient:** the DALC fit of §5 (see there).
- **Landscape specular (calibrated).** Terrain writes smoothness and specular to the G-buffer like
  the lighting shader: per-draw factors × the layer's `_s` map. LandscapeAsphalt01 uses
  `asphalt01_s.dds`. The per-draw factors are set CPU-side and are not in the TXST/LTEX records. A
  specular factor of 0.6 (smoothness factor 1) matched the sun/shade contrast in both clear and
  overcast weather. Without specular the viewer's sunlit ground was 0.85× the game's.
- **Time-of-day keys:** recalibrated, see `weather-notes.md` §11.
- **Result per spot** (viewer minus game, scene light in EV, both inverted with the viewer's exposure):

| Setup | Sunlit ground | Ground in shadow | Bedroll top | Suit shoulder | Sky at zenith |
| --- | --- | --- | --- | --- | --- |
| A clear 12:00 | +0.01 | -0.04 | -0.09 | +0.02 | -0.02 |
| B overcast 12:00 | -0.23 | -0.29 | -0.24 | -0.03 | -0.06 |
| C clear 22:00 | +1.05 | +0.89 | +0.34 | -0.66 | -1.08 |
| D clear 07:00 | -0.32 | -0.14 | -0.41 | -0.59 | -0.03 |

- How to read the table:
  - B is uniformly about 0.25 EV dark, which is what an exposure difference looks like: the game's
    auto-exposure sees the whole street, the viewer only the character and its ground.
  - D's sunlit surfaces are short of the game's warmth, as if the game were a little further into
    LateSunrise than the 50% the keys give at 07:00.
  - C (night) is the weakest:
    - the ground is too bright and the moon shadow too strong (sun/shade contrast 1.26 against the
      game's 1.02);
    - the night sky at the zenith is about 1 EV too dark;
    - the viewer has no cloud layers, which light the game's night sky;
    - the bedroll and shoulder boxes in C and D sit on differently oriented surfaces than in the
      viewer's view, so they are rough.

## 20. Sky gradient (the dome mesh)

Read from the vanilla `meshes\sky\atmosphere.nif` (a BSSkyShaderProperty dome, 609 vertices). The dome is
a flattened hemisphere: radius about 511 units, height about 208. Its vertices sit in rings, and every
vertex in a ring has the same vertex colour. The colour's R, G, B are blend weights that sum to 1:

- **R:** 1 just below the horizon, fading to 0 by about 11° of elevation.
- **G:** rises from the horizon, peaks at about 7-9° (0.84), and fades out by about 36°.
- **B:** starts at about 8°, reaches 0.5 near 16°, 0.9 near 36° and 1 near 74°.

The weights belong to the weather's colours as follows. The 07:00 calibration shot facing south shows a
blue sky a few degrees up, a salmon tint only at the horizon line, and Sky-Upper alone at the zenith. That fits
R = Horizon, G = Sky-Lower, B = Sky-Upper, each scaled by the imagespace Sky Scale.

The viewer reads the rings from the user's own file at run time (`/api/sky`) and interpolates the weights
by view elevation. It keeps no copy.

The shader pack has no shader that blends three colours by vertex-colour channels, so the game most likely
writes the mixed colours into the dome's vertices on the CPU each frame. Whether it mixes before or after
linearising is therefore not visible in the shaders. Mixing the weather's 0-255 colours in gamma space,
then linearising and scaling by Sky Scale, matched the overcast horizon shot within about 5 levels from 5°
to 16° of elevation. A linear mix was 5-10 levels too bright. The viewer mixes in gamma space (calibrated,
medium confidence).

In the clear-noon horizon shot the game's low sky stays darker than this model: at about 5° the game shows
(122,178,231) and the viewer (164,212,253), about 0.4 EV. In that setup the camera faced west, away from
the sun, so the game probably adds a sun-side or azimuth term to the sky that the dome's rings do not carry.
Not modelled.

The viewer's old gradient used Horizon up to about 30° and made the low sky too pale: 16° up at noon it
showed (137,173,217) where the game shows (70,133,199). At dawn it was salmon everywhere.

Not modelled:
- the sun-side glow and the cloud layers;
- the night sky: the game's zenith at 22:00 is brighter than Sky-Upper × Sky Scale gives.

## 21. Screen-space ambient occlusion (SAO, 2026-10-07)

The game's default AO (Fallout4Prefs.ini `bSAOEnable=1`) is Scalable Ambient Obscurance (McGuire, Mara and Luebke,
2012) with changes of Bethesda's own. Settings, `[Display]` in Fallout4_Default.ini, overridden by Fallout4.ini /
Prefs / Custom: radius R = fSAORadius (108.2), bias = fSAOBias (0.6), intensity I = fSAOIntensity (7.1). The console
`sao` command takes them in that order. A separate legacy SSAO and NVIDIA's HBAO+ also exist; neither is the default.

**Passes:** linear depth, a depth pyramid (each level the minimum of 2 x 2, 5 levels), the occlusion at **half
resolution**, a blur across then down. Confidence: high (pass and constant names from the executable, maths from
the shaders).

**Occlusion of one texel** (z = view distance in game units, positive):
- key = clamp(z / 7000, 0, 1).
- Normal: the face normal from the depth's neighbours (one variant blends towards the G-buffer normal; which one is
  the default is open), facing the camera.
- Spiral: N samples, t = (i + 0.5) / N, angle = t x turns x 6.28 + spin, radius = t x 100 x R / z occlusion
  texels (a fixed 100, not derived from the field of view). spin = 10 x ((3x) XOR (x*y + y)) with the texel's
  integer coordinates. In game N = 5 with 2 turns and a history buffer (temporal); without history, N = 10 with
  7 turns. Both give the same expected darkness.
- Bias: beta = bias + 10 x max(key - 0.3, 0) + 5 x (ndc.x^2 + ndc.y^2): weaker past 2100 units and towards the
  screen's corners. No other distance fade.
- Each sample Q (its depth from the pyramid level clamp(floor(log2 r) - 3, 0, 4)): v = Q - C,
  sum += max(R^2 - v.v, 0)^3 x max((v.n - beta) / (v.v + 0.01), 0).
- A = max(0, 1 - I x sum / R^6 x 5 / N): visibility, 1 = open. No power or contrast curve.

**Blur:** 7 taps 2 texels apart (0, +-2, +-4, +-6) with weights 0.153170, 0.444893, 0.422649, 0.392902 (nearly a
box), each times max(0, 1 - 2000 x |key(tap) - key(centre)|) (cut at ~3.5 units of depth), normalised by
(sum of weights + 0.0001). Across, then down.

**Where it applies:** in the **composite**, not in the lights: the deferred surface's whole lit colour (emissive +
specular + 3 x diffuse light x albedo + cube reflection, so sun, ambient and placed lights alike) is multiplied by
A, read from the half-resolution texture with an ordinary filtered lookup, **before fog**. Forward-drawn surfaces
(effect shaders, alpha-blended lit surfaces) come later and are not darkened; deferred decals are. Interiors and
exteriors do not differ.

**In the viewer** (web/js: PREZ_FS, SAO_FS, SAO_BLUR_FS, renderer.ambientOcclusion): a depth pre-pass of the solid
and alpha-tested surfaces with the main pass's own matrices and jitter; the no-history variant (N = 10, 7 turns);
the face normal; depth read at full resolution (no pyramid); A multiplies the lit colour of every surface the game
draws deferred (solid, alpha-tested, decals, landscape) before fog. Two deliberate changes: the 100-texel footprint is
scaled with the render height / 1080, so the look matches the game at 1080p and stays the same at any size
(screenshots at 2x / 3x included); the game's own AO grows thinner at higher resolutions. And the blur's kernel is
the game's convolved with [1/4 1/2 1/4] (15 taps one texel apart): taps 2 apart never mix odd and even texels, so
without the game's history buffer the four interleaved sets kept their own leftover noise, a fine screen-door pattern
where the occlusion is strong (the ARC's reactor glow deep in the fan, reported 2026-10-08). The wider kernel weights
odd and even texels alike and keeps the mean.
The occlusion pass also writes each texel's linear depth (a second target, R32F) that the two blur passes read
instead of recomputing it from the depth buffer per tap; sky texels skip the blur (2026-10-09).

**Calibration (2026-10-08).** Bman found the ARC backpack's fan glow far too dark with AO on. Matched in-game A/B
(GameDriver, Red Rocket, Clear 15:16, SAO with HBAO+ off, `sao 108.2 0.6 7.1` against `sao 108.2 0.6 0`, the
third-person camera solved to 0.47 px, the viewer's character placed so the pack is the same size on screen;
brightness on / off, linear, normalised by the sky):

| | Fan glow | Pack housing | Pillar base | Rubble |
| --- | --- | --- | --- | --- |
| Game | 0.84 | 0.89 | 0.98 | 0.995 |
| Viewer, maths as above | 0.33 | 0.72 | 0.96 | 0.99 |
| Viewer x 0.5 (now) | 0.68 | 0.88 | 0.98 | 0.995 |

- The game darkens about half as much as the shader maths with the INI intensity give. Where the factor comes from
  (the constant the engine passes, half-resolution AO, the min-depth pyramid, the blur) was not traced; renderer
  AO_GAIN = 0.5 scales the intensity.
- The game does darken glow (the fan's emissive) with AO, as the composite evidence says, just less. The remaining
  gap on the fan is partly the tonemap: the glow sits on the curve's shoulder in both, where ratios read closer to 1.
- Measured in one scene; other places not checked yet. HBAO+ (the launcher's other AO, NVIDIA cards) is a different
  technique the viewer does not draw.

## 22. Projected decals (placed texture sets, 2026-10-07)

A placed reference of a TXST with decal data (DODT) puts a texture on the surfaces around it: grime, blood, scorch
marks, puddles, ground blends. The executable builds these as geometry decals at load time (`BSTempEffectGeometryDecal`,
`bBackgroundInitializeGeometryDecals`); `bAllowDecalsOnAlpha` (off) keeps them off alpha-tested surfaces, and they do
not land on actors. Confidence: medium (names and record data; the geometry build itself was not traced).

**Record data:**
- DODT (36 bytes): min width, max width, min height, max height, depth, shininess, parallax scale (floats), parallax
  passes (byte), flags (byte), alpha threshold (u16), colour (RGB + pad).
- Flags: 0x01 parallax, 0x02 alpha blending, 0x04 alpha testing, 0x08 no subtextures, 0x10 multiplicative; 0x20 and
  0x40 unknown. Without 0x08 the texture is a 2 x 2 atlas and each decal shows one quarter (checked on the puddle,
  blood and splatter textures).
- Textures: TX00 diffuse, TX01 normal, TX07 smoothness/specular; or MNAM, a BGSM whose alpha blend mode may be
  Multiplicative (DST_COLOR x ZERO, e.g. GrimeSubtle01). DNAM bit 0: no specular map.
- Reference: XPDD (two floats) scales width and height (e.g. 1.87 x 0.11 for a long rust streak along a wall base);
  XPRM holds a box on about 10 000 decal references, whose use is not known.
- Box: width along the reference's X, height along Z, depth along +Y (the projection direction), centred on the
  reference. Measured on Vault 111's 540 decals: the reference sits on its surface (median offset 0, quartiles
  +-0.15 x depth), so the box must reach both ways. Texture u runs along +X, v down along -Z (wall drips run down).

**In the viewer** (DECAL_VS / DECAL_FS, renderer.drawProjDecal): a screen-space projection instead of geometry. After
the solid cell and the landscape are drawn, the cell's depth is resolved and each decal box is drawn by its far side,
depth-tested GEQUAL. The surface position is rebuilt from depth relative to the camera, and the face normal from the
neighbouring pixels. Surfaces turned away from the projection take nothing; edge-on ones fade. The decal is then lit
like any lit surface, with AO applying. Alpha-tested surfaces and the character are drawn after the decals and take
none. Width and height: one value per reference between min and max (seeded by its FormID) times XPDD.

## 23. Shadows of placed lights (2026-10-07)

**Which lights:** LIGH flags 0x400 Shadow Spotlight, 0x800 Shadow Hemisphere, 0x1000 Shadow Omnidirectional (0x4000 is
the non-shadow spotlight). In the vanilla game and DLC: 885 shadow spotlights, 466 omni, 17 hemisphere placed (333
interiors have at least one; DLC03 Vault 118 has 74). LIGH DATA: falloff exponent at offset 16, FOV at 20, near clip at
24 (omni usually 7.2 or 1, spotlights 64). The reference's XLIG: FOV +/-, fade +/-, end distance cap, shadow depth bias,
near clip (overrides when above 0), volumetric intensity. Confidence: high (record layout and survey).

**Maps** (deferred light shader variants with a shadow, technique bits 0x8 / 0x10 / 0x20):
- Omni: two paraboloid maps (front and back half, two slices of a texture array). A point's direction from the light
  picks the half by the sign of its local z; uv = xy / (1 + |z|) * 0.5 + 0.5. The stored value is distance / radius.
- Hemisphere: one paraboloid (the front half only).
- Spotlight: a perspective map along the spot's axis; the stored value is its projected depth.
- Lit where stored >= value - bias (a per-light constant; the units of XLIG's shadow depth bias were not traced). The
  light is further multiplied by 1 - (d^2 / c)^8, c a per-light constant (probably radius^2: no effect inside it).
  Confidence: high for the lookups, low for the bias.

**Filter** (`uiShadowFilter`, exe default 3): 1 = one hardware comparison (2 x 2 filtered); 2 = 3 x 3 comparisons one
texel apart, averaged; 3 = 16 comparisons from a fixed pattern spread over +-3 texels, averaged.

**Resolution:** `iShadowMapResolution` (exe default 2048; the Ultra preset 4096); a light's map halves for every
`flocalShadowMapHalveEveryXUnit` (750) of its distance from the camera (the map then uses a corner of its slice).
`fShadowDistance` (3000; Ultra 14000) is the shadow distance. How many lights get a map at once was not traced.

**Spotlight cone** (all spotlights, not only shadowed ones; p = the light's falloff exponent, assumed to be LIGH DATA
offset 16; c = cos of the angle from the axis, w = cos of half the FOV):
- shadow spotlight: 1 - min(1, r^p) with r the radial position in its shadow frustum (taken as tan / tan(half FOV),
  1 at the edge of the cone);
- non-shadow spotlight: sat(1 - (1 - c) / (1 - w))^p.

**In the viewer** (renderer.updateLightShadows / drawLightLayer, LSHADOW_VS / LSHADOW_FS, LIGHTING_BODY lightShadow):
- **Maps:** cube maps (six 90-degree faces) instead of paraboloids, a deliberate change. A paraboloid bends straight
  edges, and linear rasterisation of large triangles (wall quads near the light) puts the shadow in the wrong place.
  Each texel stores distance / radius (the game's own value for omni lights, for spotlights too), so the comparison
  is the same on every face.
- **Storage:** 1024 x 1024 per face, 16-bit, in one array of 48 layers.
- **Which lights:** up to 8 shadow-casting lights whose sphere is in view within fShadowDistance, nearest the camera
  first. A light keeps its layers while it stays chosen. A layer is drawn again when the cell changes or the
  character moves inside it.
- **Near clip:** nothing nearer to the light than its near clip casts.
- **Filter:** reaches the game's angle (3, 1 or half a texel of its map at its resolution and halving, about 3 /
  resolution radians per texel). That is 4 or 16 hardware comparisons of this map, at least 3/4 of a texel.
- **Bias:** casters are stored 0.5 units + 3 x their slope further away; the receiver 1 unit nearer.
- **Not covered:** the landscape takes no light shadows (no texture unit free); hemisphere lights use the full cube.

## 24. Light shafts (god rays, 2026-10-07)

The game's sun shafts are NVIDIA's volumetric lighting library (`GFSDK_GodraysLib.x64.dll`, Gameworks "Godrays",
INI `bVolumetricLightingEnable`, `iVolumetricLightingQuality`; console `gr`). Its public description (NVIDIA GDC 2016):
single scattering in a medium made of an absorption term and several phase terms. The lit parts of each view ray are
found from the light's shadow map (a tessellated mesh of the lit volume, front faces adding and back faces
subtracting the integral from the eye). A directional light's integral is in closed form, and the result is added to
the scene at half or quarter resolution. Its shaders are its own, not in the game's shader pack. Confidence: high
for the model, low for the absolute scale.

**Data:**
- GDRY (69 records, DATA 60 bytes): Back Colour (rgb), Fwd Colour (rgb), Intensity, Air Colour Scale, Back Colour
  Scale, Fwd Colour Scale, Back Phase, Air Colour (rgb), Fwd Phase.
- The library's constants name the same set: air scatter, forward scatter + phase, back scatter + phase, absorption,
  a distance scale, an intensity.
- WTHR WGDR: one GDRY per time of day, blended like the imagespaces (esm_weather sample `god_rays`).
- Vanilla clear weather:
  - None_Rays (intensity 0) at night, dawn and sunrise;
  - ClearSunriseRays (late sunrise);
  - ClearDayRays (I 1; air (0.64, 0.68, 0.75) x 0.1; forward (1, 0.6, 0.07) x 1, g 0.80; back (0.77, 0.80, 0.86) x 5,
    g 0.55);
  - a weak ClearSunSetRays (I 0.1).
- Foggy (I 4) and radstorm (I 3.25, back x 13) weathers are far stronger.
- 25 spotlight bases carry their own GDRY (LIGH WGDR). 10 interiors carry one (CELL XGDR), Vault 111 among them.

**Medium as used here:**
- Scattering = air x Rayleigh 3 / (16 pi) (1 + mu^2), + forward x Henyey-Greenstein(mu, g = Fwd Phase), + back x
  HG(mu, -Back Phase).
- Each term is its colour x scale. mu is the cosine between the view ray and the direction to the sun.
- Extinction = the sum of the three (no absorption term in the record).
- In-scattered light along a ray of length D = Intensity x sun colour x scattering x integral over 0..D of
  visibility(t) x exp(-extinction t) dt, added to the scene (the scene itself is not attenuated).

**The scale:** the engine's distance scale and how it converts the record's numbers were not traced. Calibrated on
NVIDIA's own in-game Ultra / Off comparisons (Fallout 4 graphics guide, 2016), clear day looking towards the sun:
- shaded buildings near the sun's direction gain about 40-80 of 255;
- the side sky about 40-46;
- the sky around the sun goes white.

0.00008 per game unit (colour x scale x that = scattering per unit) gives the same gains on comparable Concord
views.

**Spotlights:** a spotlight with a GDRY of its own (LIGH WGDR, 25 bases; DATA +52 the rays' near clip) shows a
shaft. Its medium and intensity come from that record (DefaultWhiteGodrays01: white forward and back lobes, g 0.6 /
0.06, intensity 4), times the light's colour, attenuation, cone and shadow map. Many placed copies set a large near
clip (XLIG, 500-2300 units): the light sits outside a window or above a roof opening, and nothing nearer than that
casts or scatters. The CK refuses god rays on paraboloid (omni) lights. CELL XGDR (10 interiors) is read but its
role was not traced.

**In the viewer (spotlights):** the same pass marches up to 4 such spotlights in view (24 steps through the part of
the ray inside the light's sphere). Each step takes the light's attenuation, cone (§23) and shadow map (one
comparison), and starts at the larger of the two near clips. The air's density is the same as the sun's; the
brightness is x 50 (spotGain, a calibration value: with the sun's scale alone the cones were barely visible, while
NVIDIA's interior example shows strong beams).

Open:
- Vault 111's god-ray spot shines in through the closed gear door (it is the daylight of the door-open scene), so it
  stays dark;
- the Old Corner Bookstore's three window beams stop at the window glass, whose BGSM casts shadows; how the game
  lets them through is unknown.

**Calibrated in game (2026-10-08).** GameDriver A/B (`gr on` / `gr off`, runs/20261008_122050_gr_ab_v111) at the
Vault 111 platform, first person, Clear: the mean added brightness (display bytes, R/G/B over the frame):

| View | Game | Viewer before | Viewer now |
| --- | --- | --- | --- |
| 12:00 facing N (sun behind) | 2 / 2 / 2 | 42 / 34 / 27 | 4 / 3 / 2 |
| 12:00 facing E | 11 / 8 / 4 | 23 / 15 / 8 | 12 / 7 / 3 |
| 12:00 facing S (towards the sun) | 22 / 18 / 14 | 27 / 17 / 9 | 23 / 16 / 10 |
| 12:00 facing W | 6 / 5 / 5 | 28 / 24 / 22 | 5 / 4 / 3 |
| 18:00 into the sun | 10 / 2 / -1 | 25 / 2 / -5 | 11 / 0 / -2 |
| 18:00 away from the sun | 4 / 3 / 2 | 36 / 19 / 10 | 4 / 1 / 0 |

- Looking away from the sun the game adds almost nothing, while the lobes as first written (back lobe x 5 turned
  away from the sun, lit air out to 20000 units) laid a white veil over everything: Vault 111's hills vanished.
- Fit (renderer GR_PARAMS): the record's back lobe points towards the sun (HG with +Back Phase: a broad, neutral
  glow), at 0.15 of its scale; the forward lobe at 0.3; no air term; lit air integrated to 4000 units. RMS error 4 of
  255 over the six views' top and middle thirds (25 before). One weather, one place: other weathers use the same
  shares untested.

**In the viewer** (GODRAYS_FS / GODRAYS_BLUR_FS / GODRAYS_APPLY_FS, renderer.godRays; Camera & image > light
shafts; View > light shafts shows them alone):
- **When:** cell viewer outdoors, when the weather's god rays are on at that hour.
- **March:** half resolution, 32 steps per pixel spaced quadratically (dense near the camera) with per-pixel jitter,
  over the reach of the sun's shadow maps. Visibility: the cell map where it reaches (sharp), else a coarse far map
  drawn for the shafts only (+-7500 units around the camera, 2048, kept while the camera stays within 750 units and
  the sun does not move), times the character's map.
- **Beyond the maps:** lit air in closed form, up to 4000 units (calibrated above; the sky counts as that far).
- **Blur and composite:** a depth-aware blur across and down, then added to the HDR scene before TAA, bloom and eye
  adaptation, each pixel taking the half-resolution values nearest in distance.
- **Cost:** about 0.5 ms at 1080p.

## 25. The game's first-person camera, and the sun disc (game shots, 2026-10-07)

Measured with the GameDriver (Documents/Fallout4_Mod_Projects/GameDriver): console batches typed into the running game
set the exact pose, weather and hour, and screenshots are taken with the HUD hidden. Same view rendered by the viewer
(`lightboxDev.gameCamera`), then registered on edge maps (scale, shift). Confidence: high for the camera, medium for
the sun disc (one hour measured).

**The camera** (Sanctuary, x -80380, y 89300, z 7776.55 as printed by `player.getpos`, heading 127, pitch -20 and 0):
- **Eye:** 120 units above the `player.getpos` z (the feet). A 10-unit error moves the near house 9 px at 1600x900,
  and the best fit was within 0.5 px at 120.
- **FOV:** horizontal, at the window's aspect (16:9 here), equal to `fDefault1stPersonFOV` (80 on this PC), not
  `fDefaultWorldFOV` (70, presumably the third-person view; not measured). At 80 the scale fit is 1.000 at both
  pitches (edge correlation 0.80 / 0.83); at 70 everything is about 14 % too large.
- **Angles:** `player.getangle x` is the pitch (negative looks up), `getangle z` the heading in degrees clockwise from
  north (+Y). `player.setangle` sets both exactly in first person.
- The ground height from the viewer's terrain probe (7777.4) matched the game's resting z (7776.55).

**The sun disc** (CommonwealthClear, DefaultClimate, `show gamehour` 10.02, shot about 10.06; god rays off):
- The disc's centre in the frame gives the direction to it: elevation 33.8 deg, azimuth 138.9 deg.
- The viewer's sun path (fitted to shadows on 10-05, `SUN_FIT` in weather.js) gives 42.8 / 126.9 at 10:00, about 9 deg
  higher and 12 deg further east.
- **Settled 2026-10-08: the light and the disc take different paths.**
  - **Disc, hourly 09:00-18:00** (first person, Bret's settlement x 40000 y 30633, clear), elevation / azimuth:
    09:00 22.5 / 129; 10:00 34.9 / 138; 11:00 46.8 / 149; 12:00 56.9 / 163; 13:00 61.9 / 180; 14:00 56.6 / 196;
    15:00 47.4 / 212; 16:00 35.0 / 223; 17:00 21.3 / 230; 18:00 10.0 / 236.
  - The disc path is symmetric about 13:00 (the middle of DefaultClimate's 07:00-19:00 day). Neither the
    latitude/declination form nor a straight-line form fits it better than about 2 degrees, so the viewer
    interpolates the measured table (`sunDiscDirection` in weather.js).
  - **Light (shadows):** one fixed view down Concord's main street at 08/10/12/14/16 h. Lightbox rendered the same
    view with 165-225 candidate sun directions per hour, and each candidate was scored by its blurred
    log-luminance against the game frame.
    - At 12:00 and 14:00 the shadows match about 45 degrees of elevation (azimuth 163-168 and about 196); the disc
      is at 57 degrees.
    - The shadow-fitted path above gives 46.9, which agrees.
    - 08/10/16 h were inconclusive in that view (too few shadow edges).
  - **So the viewer keeps the light path above** for shading, shadows and light shafts, and draws the sky's sun
    disc and glare from the measured disc path. It was checked on the 10-07 Sanctuary shot, which was not used
    for the table: the disc now lands within about 2 degrees of the game's, against about 15 degrees before.
- The ESM's sun-path settings (GMST): fSunXExtreme 600, fSunYExtreme -325, fSunZExtreme -150, fSunDirXExtreme 350.
  fSunShadowMinAngle exists but is not in the ESM. The separate "Dir" X hints that the light swings east-west by a
  different amount than the disc.
- The engine family's sun runs on a straight line in direction space. OpenMW documents Morrowind's as x = -400 x
  orbit with y and z fixed, where orbit goes +1 at sunrise to -1 at sunset. A straight line is a great circle through
  east and west, tilted from overhead. The 10:00 disc fits that shape with X 600 and |y| 325 at orbit 0.47, which is
  10:10 on a 07:00-19:00 day; z / |y| = 0.89 is still unexplained.
- Still open:
  - the light direction at 08/10/16 h (needs a view with more shadow edges at those hours);
  - the disc between 06:00 and 09:00 and after 18:00 (blocked by trees from that spot);
  - the game's lens-flare star around the disc.
- The GameDriver run rules learned here: never lift the player (`tcl` has no effect in Bman's game, and a fall
  killed the character); restore everything at the end of a run and check it with a console shot, but not while
  the HUD is hidden (`tm` hides the console too).

## 26. Particles (simplified, 2026-10-08)

Fallout 4's particle systems are NiParticleSystem blocks with a chain of modifiers and controllers (nif.xml). The
viewer reads them (fo4nif.py, scene.py `scene_particles`), simulates them on the CPU and draws camera-facing quads
with the system's own effect material (web/js/particles.js, renderer `updateParticles`). It is not the engine; it
follows the parts that decide the look. Confidence: medium. The conventions were inferred from the data; none of
it has been compared with in-game frame sequences yet (the GameDriver can take them).

**Coverage:**
- The game has 1,674 systems in 723 meshes.
- The reader was checked on all 26,299 particle blocks: each one ends exactly at its stored size, and the values
  equal a nif.xml-driven reader's.
- Emitters: box (741), mesh (525), sphere (241), cylinder (171).
- Modifiers in nearly every system: age / death, position, simple colour (1,673), scale curve (1,590).
- Also common: gravity (1,380), drag (3,478 axes), rotation (1,060), sub-texture flipbook (534), wind (565).

**Birth rate:** the emitter controller (NiPSysEmitterCtlr / BSPSysMultiTargetEmitterCtlr) gives particles per
second, and its visibility interpolator switches it on and off.
- In 994 of 1,645 systems the controller's own interpolators are blends. The real values sit in the object's
  controller sequence, e.g. a fire barrel's `autoLoop`. The viewer takes the BirthRate / EmitterActive channels and
  timing of the sequence an untouched object plays: the first one named idle / loop / default / special, the one the
  renderer plays too. An oxygen tank's spray belongs to `stage2loop`, which the game plays only once the tank is
  shot; its quiet `stage1loop` comes first, so the tanks stay still (checked in game at Vault 111, 2026-10-08; the
  spray had shown as fires on the crates).
- Controllers are previewed on a loop (a one-shot burst repeats).

**Emitters:**
- Direction: declination from the emitter object's +Z axis, planar angle around it, each +/- its variation. Speed,
  radius and life span +/- their variations. Box = width x height x depth along X, Y, Z; cylinder = radius in XY,
  height along Z; sphere = radius.
- Mesh emitters: every vanilla one starts particles along the surface normal, nearly all from random points on the
  faces. 481 of them point at placeholder shapes without vertices (the game uses the actor's own mesh); those emit
  from the shape's bounding sphere.

**Forces:**
- Gravity: acceleration in units / s2 (median 108) along the gravity object's axis, or a world axis when World
  Aligned. Spherical gravity (66 systems) pulls towards the object.
- Drag "Percentage" (median 0.05): read as the fraction of the velocity along the drag axis removed per 1/30 s frame.
  Inferred; per second it would do nothing visible.
- Rotation: angle and speed +/- variation, with a random sign when Random Rot Speed Sign is set.

**Simple colour modifier:**
- The four percentages are ordered (colour 1 end <= colour 1 start <= colour 2 end <= colour 2 start in 1,671 of
  1,673), so they are keys over the particle's life: colour 1, blend to colour 2, hold, blend to colour 3. Applied to
  RGB.
- All four at 0 (200 systems) means unused: those systems always have an invisible first and last colour around a
  visible middle one, so the middle colour is kept.
- Alpha: the middle colour's alpha (the peak) times the fade-in / fade-out envelope (in over the first fade-in
  fraction of life, out from the fade-out fraction to the end; nif.xml's defaults 0.1 / 0.9 make that symmetric).
  The colours' alphas usually repeat the same fade, so applying both fades twice (a fire barrel's smoke vanished).

**Size and flipbook:**
- Size = radius x the scale curve (BSPSysScaleModifier: values evenly spaced over the life).
- Atlas frames (NiPSysData sub-texture offsets) are (u, width, v, height): the small fire's 128 = 16 x 8, steam's
  4 = 2 x 2.
- BSPSysSubTexModifier: Frame Count is frames per second (+/- its fudge); Start Frame Fudge is a random start
  range; frames loop from Loop Start Frame (+ its fudge) to End Frame.
- Quads: width = size x Aspect Ratio. Aspect flag 1 turns them along the velocity on screen; flag 256 blends the ratio
  from Aspect Ratio at speed 1 to Aspect 2 at speed 2 (sparks and flames stretch).

**Material:**
- The particle's colour rides in the vertex colour.
- With a greyscale palette, the particle's colour picks the palette row and its alpha the alpha row (a fire runs
  from hot to cool as its colour goes from white to dark), instead of tinting the result.
- Additive systems (destination ONE) are not sorted; blended ones are drawn far to near.

**Not simulated:** spawn on death, LOD, colliders, bombs, wind, inherited velocity, recycle bounds.

**Cost:** Concord (51 placed systems, 40 active, about 330 particles): about 0.2 ms of CPU per frame for the
update and the quads, one draw call per system.

## 27. Distant LOD (2026-10-08)

Past its loaded cells (uGridsToLoad, 5 x 5 by default) the game draws the worldspace's LOD: terrain chunks and object
chunks generated by the Creation Kit. Without them a cell opened in the viewer ended in sky, and every placed cloud
sheet (`meshes\sky\clouddistant*`, soft effects that fade into the hill behind them) hung in front of nothing as a
white wall. Found at Vault 111 against a GameDriver shot; the hills and tree lines now match it.

**Files** (Fallout4 - Meshes / Textures archives; plain NIFs the viewer already reads):
- `meshes\terrain\<world>\<world>.<level>.<x>.<y>.btr`: terrain. One `Land` BSTriShape over level x level cells,
  vertices 0..4096 scaled x 4 in the shape's own transform, relative to the chunk's south-west corner (cell x, y times
  4096); diffuse `textures\terrain\<world>\<world>.<level>.<x>.<y>.dds` and model-space normals `..._msn.dds`. A second
  shape is the LOD water (an effect shader without textures).
- `meshes\terrain\<world>\objects\<world>.<level>.<x>.<y>.bto`: objects (trees, rocks, buildings), BSSubIndexTriShape
  in world coordinates, an atlas `textures\terrain\<world>\objects\<world>.objects.dds` (+ _n, _s); `obj` opaque and
  `obj-at` alpha-tested.
- Levels 4, 8, 16 and 32 (Commonwealth: 2648 / 673 / 164 / 40 files); chunk corners are multiples of the level.

**In the viewer** (world.js `loadLod`, after the cell's own models): level-4 terrain out to 12 cells, level-4 objects
out to 8, level-8 terrain out to 32 (minus the level-4 square). The server cuts every triangle that lies wholly
inside the loaded cells (or, for level 8, the level-4 square) from the chunk it serves (`/api/nif?...&cut=x0,y0,x1,y1`
in the model's own space), so nothing is drawn twice; triangles across the edge stay, so there are no cracks. LOD
casts no shadows, takes no light shadows and is not stood on (renderer batches flagged `lod`). The LOD water is left
to the cells' water planes. Camera & image > distant land switches it. Cost at Sanctuary: about 725k triangles in 146
chunks, about 1 ms a frame at 1080p.

Not done: levels 16 and 32 (the farthest mountains), the game's LOD fade, tree LOD billboards beyond the object chunks.

**Also from that comparison:**
- Vault 111's elevator (`vltelevatorexterior.nif`) carries a sky dome for the intro's descent; the ride up (sequence
  stage4) switches it off at 9 s for good. The viewer draws the bind pose, so scene.py hides `m_SkyDome` by name
  (END_STATE_HIDDEN). The elevator's platform itself still shows lowered (the pit), and skeleton corpses stand in
  their bind pose (the game poses them from the reference's ragdoll data, XRGD): both open.
- A hidden node hides its children in the game, but 8 vanilla meshes keep visible shapes under hidden DamageStage
  nodes, and `carmini01hulk.nif` keeps its whole body there: the engine shows the stage node that matches the object's
  damage stage, so the viewer does not hide by parent flags in general.
