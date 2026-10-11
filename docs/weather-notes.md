# Weather, climate and imagespace notes

These notes cover the data behind `server/esm_weather.py`. That module reads the user's own
`Fallout4.esm` and DLC masters at runtime and turns their weather records into lighting values. Below:
what each field means, its units, what has been **verified** and what is only **inferred**, and how the
values are meant to feed the renderer. Researched 2026-10-05.

## 1. How the layouts were checked

- **Field layouts** come from FO4Edit 4.1.5f's record definitions, exported with its command-line tool.
- **Every decoded value** was then compared with FO4Edit's own decoded output, for all vanilla records
  of the types used:
  - WTHR 104, IMGS 332, GDRY 69, CLMT 11, SPGD 4, across Fallout4.esm, DLCRobot, DLCCoast and
    DLCNukaWorld;
  - **75,799 values, 0 mismatches**;
  - covered: all colours per time of day, directional ambient, all fog floats, every DATA byte and flag,
    the imagespace and god-ray references, cloud layers, all imagespace and god-ray fields, climate lists
    and timings, and precipitation records.
- **The check is real.** A deliberately broken decoder (two labels swapped) produced 8,840 mismatches.
- **The CK's string table** gives the same colour-slot and time-of-day names, in the same order.
- The dumps and comparison scripts are private research material and are not distributed.

**What could not be checked: the engine's code.** The game and CK executables are encrypted on disk
(Steam DRM), so no claim below rests on disassembly, and no attempt was made to get around that. Where
behaviour matters but is not visible in the data, it is marked **inferred**.

## 2. Reading the files (verified)

- **Plugins** are a header record, then a tree of groups. Records have 24-byte headers.
  - A record with flag `0x00040000` is zlib-compressed behind a 4-byte uncompressed size.
  - A subrecord called `XXXX` carries the real size of the next, oversized subrecord.
- **FormIDs.** The top byte of a FormID indexes the file's own master list. The module re-bases every
  FormID onto the files it actually loaded, and the last file wins.
  - With the four vanilla masters: Fallout4 00, DLCRobot 01, DLCCoast 02, DLCNukaWorld 03.
  - FormIDs are returned as 8-digit hex strings.
- **Overrides seen in vanilla.** DLCNukaWorld overrides the Commonwealth worldspace record, but leaves
  its climate on `DefaultClimate [0000015F]`. DLCCoast overrides Diamond City's.
- **Speed.** The module loads only the groups it needs: about 0.06 s for all four masters.

## 3. Eight times of day (verified)

Every per-time structure stores eight entries, always in this order:

> Sunrise, Day, Sunset, Night, EarlySunrise, LateSunrise, EarlySunset, LateSunset

That order covers colours, cloud colours and alphas, imagespaces, god rays and the eight
directional-ambient subrecords. Through a day the sets run Night, EarlySunrise, Sunrise, LateSunrise,
Day, EarlySunset, Sunset, LateSunset, Night. The first four are Skyrim's sets; FO4 appended the other
four.

- **FO4Edit naming slip.** FO4Edit 4.1.5f names the 8th imagespace entry and the 8th cloud alpha
  "EarlySunrise". By position the entry is LateSunset, and the data agree: Clear's 8th imagespace is its
  late-dusk one.
- **Old records with four sets.** Four vanilla weathers (DefaultWeather, NeutralWeather,
  FXDiamondSunlightBounce, FXWthrInvertDayNight) store only the first four sets. FO4Edit decodes them
  that way too.
  - `sample()` fills the other four with a rule taken from other tools, **unverified**:
    - an early or late colour is the average of its two neighbours (EarlySunrise from Night and
      Sunrise, LateSunrise from Sunrise and Day, and so on);
    - an early or late imagespace or god-ray slot reuses Sunrise or Sunset.
- **Empty imagespace slots.** A few weathers leave some imagespace slots empty: one in Dusty, all of
  them in an unused marsh test weather. `sample()` then uses `DefaultImageSpace [00000167]`. That
  record exists; that the engine falls back to it is **unverified**.

## 4. Weather record (WTHR)

**Colour sets (NAM0).** 19 slots, each with eight times of day, stored as 0-255 RGB:

> Sky-Upper, Fog Near, Unknown, Ambient, Sunlight, Sun, Stars, Sky-Lower, Horizon, Effect Lighting,
> Cloud LOD Diffuse, Cloud LOD Ambient, Fog Far, Sky Statics, Water Multiplier, Sun Glare, Moon Glare,
> Fog Near High, Fog Far High.

- **Slot 3.** FO4Edit calls slot 3 "Unknown"; the CK calls it "Cloud Layer". It is black in vanilla.
- **Two records** lack the last two (high-fog) slots.
- **For lighting (meanings inferred from the names):**
  - **Sunlight** is the colour of the directional sun, or moon, light. It is the main key light.
  - **Sun** tints the sun disc.
  - **Effect Lighting** lights effect shaders.
  - **Horizon, Sky-Upper and Sky-Lower** drive the sky gradient.
  - **Ambient** is the same grey ramp in most weathers (93 by day, 2 at night). It is probably a scalar,
    and not the scene ambient; that is the directional ambient below.

**Other fields:**

| Field | Meaning |
| --- | --- |
| Cloud textures (`00TX` ... `O0TX`) | One per cloud layer, up to 32. The first character of the signature counts up from `0`. |
| Cloud speeds | One byte per layer. FO4Edit shows `(byte - 127) / 1270` (verified). |
| Cloud colours | Per layer, per time of day. |
| Cloud alphas | Per layer, per time of day, floats. |
| Disabled-layer bit mask | Which cloud layers are off. |
| `NAM4`, `LNAM` | Unknown. One float per layer, and one integer. |
| Precipitation | A link to a rain/snow particle record. |
| Visual effect | A camera-attached effect, such as the camera mist. |
| Fog | Section 6. |
| Imagespaces | 8 links, section 7. |
| God rays | 8 links, section 8. |
| Directional ambient | 8 subrecords, section 5. |
| Aurora model | |
| Sun lens flare | |
| Sounds | Default, precipitation, wind and thunder sounds. |
| Sky statics | |
| Lightning / activation spells | |
| Volatility and visibility multipliers | |

**DATA**, in FO4Edit's names:

| Byte | Field |
| --- | --- |
| 0 | Wind speed (`/255`) |
| 1-2 | Unknown |
| 3 | Transition delta |
| 4 | Sun glare (`/255`) |
| 5 | Sun damage |
| 6-7 | Precipitation begin fade in / end fade out (fractions of a weather transition, `/255`) |
| 8-10 | Thunder begin, end and frequency |
| 11 | Flags |
| 12-14 | Lightning colour |
| 15-16 | Visual effect begin/end |
| 17 | Wind direction (degrees = `byte*360/256`, inferred) |
| 18 | Wind direction range |
| 19 | Wind turbulence (optional) |

**Flags:** Pleasant, Cloudy, Rainy, Snow, Sky statics always visible, Sky statics follow the sun, Rain
occlusion, HUD rain effects.
- The first four classify the weather for gameplay, not looks. The radstorms are flagged **Snow** and
  have no precipitation record.

## 5. Directional ambient (layout verified, use partly inferred)

**Layout.** Each time of day has six colours (X+, X-, Y+, Y-, Z+, Z-), an ambient specular colour, and
one float that FO4Edit calls "Scale". (Skyrim's version of the float was a Fresnel power.)

**Vanilla data:**
- **Scale** is 1.0 in all 816 vanilla entries, so the data cannot show what it does.
- **The sky-blue colour is Z-, not Z+.**
  - Z- is the brighter one in 704 of 816 entries, equal in 110, and darker in only 2. It is also bluer.
  - Example, Clear by day: Z- is 101,133,169; Z+ is 42,52,62.
  - **Inferred:** the labels name the direction the light travels, so an up-facing surface takes the
    Z- colour. Map X and Y the same way for consistency: a +X normal takes X-, a +Y normal takes Y-.
  - X and Y show no east/west swap between morning and evening, so they can't confirm this.
- **Specular** is an ambient specular tint, black at night.

**Suggested use:** six-direction ambient on the surface normal, linearised by the renderer. Tools that
replicate the engine evaluate ambient as a constant plus a linear term per axis, then apply a 2.2 gamma.
That is not verified here.

## 6. Fog (layout verified, blending inferred)

**Fields:**
- Day and night **near** and **far** distances, in game units (64 units = 1 yard, about 1.43 cm per
  unit).
- Day and night **power**: the shape of the fog curve.
- Day and night **max**: the maximum fog opacity.
- Most weathers add **height fog**: a near and a far height midpoint and range, plus a high-altitude
  density scale, each for day and night.

**Colours:**
- Fog Near and Fog Far, plus Fog Near High and Fog Far High at altitude (the altitude part is inferred).
- The game setting `fDirectionalFogPower` (8) hints at fog shaped by the sun direction.

**Day/night blending.** The record holds only day and night values. `sample()` blends them with a
`day_factor`, **inferred**:
- 0 before sunrise begins;
- rising linearly to 1 at sunrise end;
- 1 until sunset begins;
- falling back to 0 at sunset end.

## 7. Imagespace (layout verified)

| Group | Fields |
| --- | --- |
| HDR | Eye Adapt Speed, Tonemap E, Bloom Threshold, Bloom Scale, Auto Exposure Max, Auto Exposure Min, Sunlight Scale, Sky Scale, Middle Gray |
| Cinematic | Saturation, Brightness, Contrast |
| Tint | Amount, then a colour stored as **0-1 floats** |
| Depth of field | Strength, Distance, Range, a sky/blur-radius value, Vignette Radius, Vignette Strength |
| LUT | A colour-grading texture path |

- **The sky/blur-radius value** is a float: 2 + 8 x radius, plus 4 when the sky is excluded. This
  reproduces FO4Edit's label for every vanilla record.
- **One old record** keeps a single legacy block instead of these groups.
- **Vanilla statistics:**
  - Most outdoor imagespaces share one LUT (`Effects\LUTs\LUT_CW_ClearDAY.DDS`).
  - Only 61 of 332 imagespaces have non-neutral cinematic values.
  - The big per-time differences are in Sunlight Scale, Sky Scale and the exposure range (section 12).
- **What the renderer gets.** `sample()` blends every number by time-of-day weight and lists the LUTs
  with their weights. Nothing is pre-multiplied. A typical sun is `linear(Sunlight) x Sunlight Scale`,
  and the sky is scaled by Sky Scale; the renderer applies both.

## 8. God rays (layout verified)

**Fields:** back and forward colours (0-1 floats), intensity, the three colour scales, back and forward
phase, and an air colour. Weathers point at a "None_Rays" record for times without rays.

## 9. Wetness: what makes materials wet

**No weather or imagespace field holds a wetness value.** What the game files show:

- **Shader inputs.** The game's executable lists a world wetness level and a world rain level among the
  lighting shader's per-pixel constants. Wetness is one global number that every lit material receives.
- **Console commands** exist to set the wetness level, the rain level, and a forced wetness.
- **Each material decides how it looks wet.** BGSM files carry a "wetness control" block: specular
  scale, specular power scale, minimum specular, environment-map scale, Fresnel power and metalness.
  - Landscape has default values in the game settings.
  - A display setting turns wet materials on.
- **Which weathers rain** (verified):
  - Every vanilla weather that actually rains links a precipitation record of type **Rain**, and sets the
    flags Rainy, Rain occlusion and HUD rain effects. These are CommonwealthRain,
    CommonwealthMistyRainy, Far Harbor's rain and Nuka-World's rain.
  - A few weathers set "Rainy" without any precipitation, so the flag alone does not mean rain.
- **Inferred, not verified:** the engine raises the world wetness level while rain falls and lets it dry
  afterwards. Rain occlusion keeps covered areas dry. Rain starts and stops at the fade points stored in
  DATA, for example at 50 % of the weather transition.
- **For the viewer:** `wetness.makes_surfaces_wet` is true when the precipitation type is Rain. Treat
  that as full wetness once the weather has settled, and apply each material's own wetness-control
  values.

## 10. Climates and the Commonwealth's weather lists

**Timing** (verified): sunrise begin, sunrise end, sunset begin and sunset end, each in units of **10
minutes**. Then come volatility, and a moon byte: two flags plus a phase length in days, with FO4Edit
reusing Skyrim's moon names.

**The Commonwealth** uses `DefaultClimate`: sunrise 05:00-09:00, sunset 17:00-21:00. Its weather list:

| Weather | Chance |
| --- | --- |
| Clear | 51 |
| ClearestSkies | 13 |
| Overcast | 11 |
| Misty | 6 |
| Foggy | 6 |
| Rain | 6 |
| MistyRainy | 5 |
| GSRadstorm (radstorm) | 4 |

**Regions** carry their own weighted lists with an override flag and a priority. Example: the outer
Glowing Sea region is 50/50 GSOvercast and GSRadstorm.

**Other climates:**
- Diamond City and Goodneighbor: sunrise 05:30-08:00, sunset 16:00-20:30.
- Far Harbor and Nuka-World: the same as DefaultClimate.

**Viewer presets** (`presets()`), chosen from these lists:

| Weather | Notes |
| --- | --- |
| CommonwealthClear `0002B52A` | |
| CommonwealthClearestSkies `001D670E` | |
| CommonwealthOvercast `001C8556` | |
| CommonwealthMisty `001CC186` | |
| CommonwealthFoggy `001C3473` | |
| CommonwealthRain `001CA7E4` | |
| CommonwealthGSRadstorm `001C3D5E` | |
| CommonwealthGSOvercast `000F1033` | Glowing Sea haze, from the region list |

All of them use DefaultClimate's timing. `CommonwealthDusty`, `CommonwealthPolluted` and the
`DarkSkies` variants exist, but no climate or region lists them, so they are not offered.

## 11. Time-of-day blending (CALIBRATED on one shot)

**What `time_of_day_weights()` does.** Inside the climate's sunrise window the four sets EarlySunrise,
Sunrise, LateSunrise and Day are a third of the window apart, EarlySunrise at its begin and Day at its end.
The Night -> EarlySunrise ramp takes one more third before the window. The sunset side is the mirror image.

| Position | begin - ⅓ | begin | ⅓ | ⅔ | end ... begin | ⅓ | ⅔ | end | end + ⅓ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Set | Night | EarlySunrise | Sunrise | LateSunrise | Day ... Day | EarlySunset | Sunset | LateSunset | Night |

Between keys the sets cross-fade linearly. With DefaultClimate (sunrise 05:00-09:00, sunset 17:00-21:00):

| 03:40 | 05:00 | 06:20 | 07:40 | 09:00-17:00 | 18:20 | 19:40 | 21:00 | 22:20 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Night | EarlySunrise | Sunrise | LateSunrise | Day | EarlySunset | Sunset | LateSunset | Night |

The positions are one constant (`TOD_WINDOW_FRACTIONS`).

**Evidence (2026-10-05, setup D: CommonwealthClear, `set gamehour to 7`, timescale 1, so about 07:01).**
The sun/shade contrast across the character's shadow on landscape asphalt, per channel, was compared with
viewer renders at 07:00-08:00 under the earlier quarter scheme (Night at the window's begin, Sunrise at its
middle):

| | sun term / ambient (Y) | red / blue of that ratio |
| --- | --- | --- |
| Game, 07:01 | 2.44 | 3.35 |
| Quarter scheme 07:15 / 07:30 / 07:45 | 1.31 / 2.21 / 3.48 | 2.42 / 4.06 / 5.44 |

The game at 07:01 looked like the quarter scheme at about 07:25-07:35, half Sunrise and half
LateSunrise: the warm, bright LateSunrise sun was already half in. Equal thirds inside the window put that
mix at exactly 07:00. The quarter scheme was half an hour late. Only this one time was measured: the
sunset side is assumed to mirror sunrise, and the length of the Night ramps is assumed.

**Still unknown:**
- the other key positions: the dawn series in CALIBRATION.md (section 5, F) checks them;
- whether the engine eases between keys rather than blending linearly;
- what the game setting `fDaytimeColorExtension` (2.0 in Fallout4.esm) does.

**Earlier reasoning (superseded):** Skyrim's four-set scheme is generally reconstructed with Sunrise at
the middle of the climate's sunrise window, and the fill rule other tools use for four-set records makes
each early/late set the halfway point between its neighbours, which pointed to quarters with Night at the
window's begin.

**In-game check**, for someone with the game:
1. Stand outside with a frozen camera.
2. Run `fw 2B52A`, then `set gamehour to` 6, 6.5, 7 and so on up to 9, taking a screenshot each time.
3. With the scheme above, the warm sunlight peaks at 07:40 and the stars are almost gone by then. If the
   peak lands elsewhere, change the constant to match.

## 12. Calibration weathers

Values are what `sample()` returns at each hour under DefaultClimate, shown as 0-255. They were taken
under the earlier quarter scheme (§11):
- The three hours fall exactly on one time of day each (Day, LateSunrise, Night). Under the current
  scheme 08:00 is three-quarters LateSunrise and a quarter Day.
- Every colour, imagespace and directional-ambient value here matched FO4Edit's decode of that set
  exactly (288 checks).
- Fog at 08:00 is the day/night blend (day_factor 0.75).

**CommonwealthClear** `0002B52A`

| | 12:00 (Day) | 08:00 (LateSunrise) | 22:00 (Night) |
| --- | --- | --- | --- |
| Sunlight | 225,225,225 | 255,181,152 | 53,70,87 |
| Ambient (NAM0) | 93,93,93 | 89,89,89 | 2,2,2 |
| DALC Z- (sky term) | 101,133,169 | 104,128,171 | 38,54,71 |
| DALC Z+ | 42,52,62 | 49,60,72 | 13,19,25 |
| DALC X+ / X- | 97,113,130 / 75,93,111 | 89,98,117 / 67,75,91 | 16,24,31 / 12,17,23 |
| DALC Specular | 161,176,180 | 94,102,105 | 0,0,0 |
| Fog near / far | 3000 / 250000 | 2450 / 250000 | 800 / 250000 |
| Fog power / max | 0.35 / 0.85 | 0.3375 / 0.85 | 0.3 / 0.85 |
| Imagespace | CW_ClearDAY_MAY19 | CW_ClearDAWN_L | CW_ClearNIGHT |
| Sunlight Scale / Sky Scale | 4.5 / 2.4 | 3.5 / 3.4 | 1 / 3 |
| Auto Exposure Min / Max | 1.6 / 3.25 | 1.5 / 1.5 | 1 / 4.5 |
| Eye Adapt Speed | 3 | 2 | 3 |
| Bloom Threshold / Scale | 0.5 / 0.2 | 0.5 / 0.2 | 0.5 / 0.2 |
| Cinematic Sat / Bright / Contrast | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |

**CommonwealthOvercast** `001C8556`

| | 12:00 (Day) | 08:00 (LateSunrise) | 22:00 (Night) |
| --- | --- | --- | --- |
| Sunlight | 89,97,107 | 108,79,71 | 46,56,67 |
| Ambient (NAM0) | 93,93,93 | 89,89,89 | 2,2,2 |
| DALC Z- (sky term) | 86,116,150 | 74,100,129 | 54,79,102 |
| DALC Z+ | 41,54,65 | 30,39,48 | 22,31,38 |
| DALC X+ / X- | 52,64,78 / 35,46,54 | 43,49,63 / 28,36,45 | 13,16,20 / 7,10,12 |
| DALC Specular | 188,205,210 | 94,102,105 | 0,0,0 |
| Fog near / far | 1600 / 250000 | 1500 / 250000 | 1200 / 250000 |
| Fog power / max | 0.28 / 0.95 | 0.28 / 0.95 | 0.28 / 0.95 |
| Imagespace | CW_OvercastDAY_May8 | CW_OvercastDAWN_L_May8 | CW_OvercastNIGHT_May8 |
| Sunlight Scale / Sky Scale | 6.5 / 1 | 5 / 1 | 1 / 1 |
| Auto Exposure Min / Max | 1.8 / 4 | 1.5 / 4.5 | 1 / 4.6 |
| Eye Adapt Speed | 5 | 2 | 3 |
| Bloom Threshold / Scale | 0.5 / 0.2 | 0.5 / 0.2 | 0.4 / 0.015 |
| Cinematic Sat / Bright / Contrast | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |

**CommonwealthRain** `001CA7E4`

| | 12:00 (Day) | 08:00 (LateSunrise) | 22:00 (Night) |
| --- | --- | --- | --- |
| Sunlight | 78,91,98 | 68,52,52 | 32,43,50 |
| Ambient (NAM0) | 93,93,93 | 89,89,89 | 2,2,2 |
| DALC Z- (sky term) | 92,129,158 | 77,99,131 | 62,96,120 |
| DALC Z+ | 42,57,66 | 32,40,49 | 25,35,41 |
| DALC X+ / X- | 48,57,63 / 33,41,45 | 39,43,51 / 32,38,45 | 15,21,25 / 9,13,15 |
| DALC Specular | 188,205,210 | 94,102,105 | 0,0,0 |
| Fog near / far | 800 / 250000 | 800 / 250000 | 800 / 250000 |
| Fog power / max | 0.19 / 0.95 | 0.19 / 0.95 | 0.19 / 0.95 |
| Imagespace | CW_RainDAY_MAY12 | CW_RainDAWN_L_MAY12 | CW_RainNIGHT_MAY12 |
| Sunlight Scale / Sky Scale | 1 / 1 | 1 / 1 | 1 / 1 |
| Auto Exposure Min / Max | 2 / 4 | 1 / 4 | 1 / 3.5 |
| Eye Adapt Speed | 5 | 2 | 3 |
| Bloom Threshold / Scale | 0.5 / 0.2 | 0.5 / 0.2 | 0.4 / 0.015 |
| Cinematic Sat / Bright / Contrast | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |

**Readings:**
- All three weathers use the same LUT and neutral cinematic values. Their looks differ through
  Sunlight, the directional ambient, fog, Sunlight Scale and the exposure range.
- Rain's Sunlight Scale stays at 1 all day; Overcast's rises to 6.5 at noon.

## 13. How the values feed the lighting (suggested)

| Viewer input | Taken from |
| --- | --- |
| Key light | `colors.Sunlight`, linearised by the renderer, times `imagespace.hdr["Sunlight Scale"]` |
| Ambient | `dalc`, with Z- facing up (section 5), linearised |
| Specular ambient tint | `dalc.Specular` |
| Sky backdrop | Sky-Upper, Sky-Lower and Horizon, times Sky Scale |
| Fog | `fog`, with the colours Fog Near / Fog Far |
| Exposure and tonemap | `imagespace.hdr` |
| Colour grade | `imagespace.cinematic`, `tint` and the `luts` list |
| Bloom | `imagespace.hdr` Bloom Threshold / Scale |
| Effect shaders | Effect Lighting |
| Wetness | `wetness.makes_surfaces_wet`, then each material's wetness control |

Every `sample()` result carries a `units` block that states these encodings. Nothing in the result is
linearised or pre-scaled.
