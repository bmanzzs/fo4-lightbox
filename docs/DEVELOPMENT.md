# FO4 Lightbox: developer notes

How the viewer is built, what is measured and what is approximated, and the log of every change. Paths are relative
to the viewer's folder. For using the viewer, see `README.md`.

Started 2026-10-05 for Backpacks of the Commonwealth (Bman). Version 1.0.0 packaged for release on 2026-10-06, 1.1.0 on
2026-10-07, 1.2.0 on 2026-10-11 (see "1.2.0", "1.1.0" and "Release package" below).

## Run it

- Release zip: `Start Lightbox.bat` runs the Python bundled in `runtime\` (built by `tools/build_release.py`).
- From the source folder: Python 3.10+ with numpy (`py -3 -m pip install numpy` once), then `Start Lightbox.bat` or
  `python server/app.py [--game DIR] [--port 8765] [--no-browser] [--plugin FILE] [--save-dir DIR]`.
- It finds Fallout 4 by itself (`--game`, then `FO4_DATA`, the Bethesda registry key, Steam's libraries including a
  Steam installed elsewhere, GOG Galaxy). If that fails and it was started from a console, it asks once and keeps the
  answer in `game_path.txt` next to the viewer.
- A second start on a port the viewer already uses opens the running viewer instead of starting another server.

Needs a WebGL2 browser with S3TC/RGTC/BPTC texture compression and float render targets (Chrome/Edge on Windows have
them; Firefox is untested).

## Foundation rule: learn from the game's shaders, never ship them

Approved by Bman, 2026-10-05. It keeps the tool shareable and costs no accuracy (the same maths with the same
constants gives the same pixels).

1. Decompiling `Fallout 4 - Shaders.ba2` to learn exactly what the game does is fine, but that output lives OUTSIDE
   this folder, in `..\_LightboxResearch_PRIVATE\` (never published). No compiled or decompiled Bethesda shader
   files in this folder, ever.
2. What we learn is written down in our own words in `docs/engine-notes.md`: formulas as maths, constants as numbers,
   the order of the passes, which ESM / BGSM fields feed what. Facts about how the game behaves, not code.
3. The viewer's GLSL is written fresh from those notes. No pasted or line-by-line translated decompiled code, no
   bundled shader blobs.
4. Everything Bethesda-owned (shaders, textures, meshes, materials, ESM data, animations) is read at run time from the
   user's own install and never included in the tool.

`python tools/check_clean.py` must pass before anything is published: it fails on game file types, DXBC bytecode,
NIF/DDS/BA2/plugin headers and shader-disassembly text anywhere in this folder.

## What it reads (and never writes)

| Data | Source |
| --- | --- |
| Meshes, materials, textures | loose files under `Data` first, then BA2 archives in the game's own mount order (`Fallout4_Default.ini` / `Fallout4.ini` / `Fallout4Custom.ini` archive lists, then the archives of active plugins in load order). Archives of inactive plugins are ignored, like the game does. |
| Weather, imagespace, climate | `Fallout4.esm` (+ DLC masters), parsed directly: `server/esm_weather.py` |
| Reference bodies | vanilla body / hands / head, optionally in the Vault 111 suit or Road Leathers, with their own materials and textures from the archives; an installed body replacer (CBBE etc., loose files) is detected and can be switched on |
| Skin tone | `QNAM` of the Player record (male body) and of Nora, `MQ101PlayerSpouseFemale` (female body), from the load order |

Nothing from Bethesda is bundled. Everything is read from the user's own install at run time.

### It never locks your files (edit while it runs)

The Creation Kit, FO4Edit, an archive packer or a script can save, rewrite, replace or delete any plugin or BA2 while
Lightbox runs (`server/fileshare.py`). Nothing is held open while the server waits: plugins are memory-mapped only
while they are indexed (about half a second at start), then read by position; an operation (opening a cell, reading
one file from an archive) opens what it reads with all sharing allowed and closes it when it ends.

Saved changes show up without a restart: about 1.5 s after a plugin or archive stops changing on disk the server reads
it again, and open pages reload the scene (the open cell is read again). Measured 2026-10-06 with a scratch plugin in
`Data`: a cell loaded, then `open('wb')` rewrites and rename-over saves succeeded and the changed cell name showed up
2.9 s later; no plugin or archive was held open between requests (Windows Restart Manager check). Only a save that
replaces the file in one step (`ReplaceFile` / `os.replace`) in the very milliseconds a cell is being read can be
refused; save again. Note: Fallout 4 itself holds every plugin in `Data` open while the game runs.

`--plugin <file>` (repeatable) also reads a plugin that is not enabled, after the load order: preview a work in progress
without activating it.

## Layout

```
FO4 Lightbox.exe        release zip only: the launcher, compiled from launcher/Launcher.cs by tools/build_release.py
launcher/               Launcher.cs (C# 5, .NET Framework 4), app.manifest, lightbox.ico, make_icon.py (icon + web/icon.png)
Start Lightbox.bat      console launcher (runtime\python.exe if present, else py -3 / python)
README.md               for users: run it, features, uses, controls, known limits
runtime/                release zip only: Python + numpy, built by tools/build_release.py (runtime/README.txt)
server/app.py           HTTP server (stdlib) + API
server/fo4paths.py      install detection, load order, archive order
server/sources.py       where the game's files come from: the game folder (or an MO2 profile, mo2.py)
server/mo2.py           Mod Organizer 2 read from its own files: instances, profiles, mod list, loose index
server/havok.py         read-only Havok 2014 packfile reader (the cloth data inside NIFs)
server/cloth.py         BSClothExtraData -> flat arrays for the browser's cloth solver
web/js/cloth.js         cloth physics preview: position-based solver run on the game's cloth data
server/fileshare.py     lock-free reads (all sharing, open only per operation, change detection)
server/vfs.py           loose + BA2 (GNRL and DX10) virtual file system; DX10 entries get a DDS header back
server/fo4nif.py        NIF reader (20.2.0.7 / BS 130): nodes, BSTriShape family, BSSkin, shaders, controllers
server/scene.py         NIF -> JSON scene (skinned shapes posed in the NIF's bind pose, materials resolved)
server/materials.py     BGSM / BGEM reader
server/esm_weather.py   WTHR / IMGS / CLMT reader + time-of-day sampling
server/esm_world.py     cell viewer: worldspaces, cells, placed objects, landscape, lights (whole load order)
server/anim.py          HKX clips -> per-frame bone transforms named by the character skeleton
server/vendor/          third-party code (PyNifly's anim_fo4.py, GPL-3.0; see vendor/README.md)
web/index.html          UI
web/js/renderer.js      WebGL2: instanced HDR MSAA pass, two sun shadow maps, bloom, GPU eye adaptation, tonemap
web/js/shaders.js       GLSL; the FO4 maths lives in FO4_LIGHTING / FO4_POST
web/js/dds.js           DDS parser; block-compressed data is uploaded to the GPU unchanged
web/js/anim.js          controller playback (NiTimeController timing, key interpolation)
web/js/weather.js       weather sample -> lighting environment
web/js/widgets.js       weather slider, hour ticks
web/js/world.js         cell viewer: loads a cell, builds landscape / water / lights, streams the models
web/js/game.js          game mode: walk the character through the scene (third person, clips, probes)
web/js/pathtags.js      mesh path -> display name + tags for the search list
web/js/icons.js         inline SVG icons (drawn for this project)
web/js/thumbs.js        reference-button previews, rendered once from the user's install, cached in the browser
docs/engine-notes.md    how FO4 shades, in our own words (maths, constants, pass order, which fields feed what)
docs/weather-notes.md   WTHR / IMGS / CLMT fields, units, verified vs inferred
docs/DEVELOPMENT.md     these notes
docs/prior-art.md       other FO4 viewers and what they do (research notes; not in the release package)
tools/check_clean.py    release guard (see the foundation rule)
tools/build_release.py  builds the release zips (see "Release package")
tools/capture.py        headless capture: render a model / plugin record to PNGs + contact sheet + manifest
tools/build_simple_cell.py  writes scenes/LightboxSimple.esp (the Simple scene; a running server reads it again)
scenes/                 the viewer's own test scenes (plugins of Fallout4.esm objects; loaded after the game's)
tools/calibration/      in-game shot list + console batches for the screenshot comparison (Bman's setup; not in
                        the release package, nor is tools/restart_lightbox.ps1)
```

Private, never published, outside this folder: `..\_LightboxResearch_PRIVATE\` (shader extraction and disassembly,
xEdit dumps, research and scratch scripts).

## Accuracy notes (what is measured vs approximated)

Recorded honestly as the work goes; see `docs/` and `tools/calibration/`.

**Verified on this install (structural, not visual):**
- NIF node world matrices match PyNifly exactly (63 nodes of the vanilla Vault 111 suit, 60 of them rotated).
- 3,000 random meshes from the user's Data + archives parse without an error (3.5 s).
- All 8,649 vanilla BGSM/BGEM files parse to their last byte.
- The HKX skeleton's reference pose reproduces skeleton.nif's rest pose to 0.005 game units (77 shared bones).
- Weather/imagespace/climate decoding matches FO4Edit on every vanilla WTHR/CLMT/IMGS record (75,799 values,
  0 mismatches; `docs/weather-notes.md`).
- Textures are sampled from the same bytes as the game (no re-encode); colour slots use sRGB views like the game.

**Implemented from the game's own shader maths** (`docs/engine-notes.md`, high confidence there): normal-map decode
and tangent frame, `_s` specular/smoothness, sun diffuse (modified Oren-Nayar + sheen + backlight + wrap), sun
specular (normalised Blinn-Phong, F0 0.2, cap 15), directional ambient in gamma space + ambient specular,
environment cube (negated reflection, mip rule, smoothness/specular mask, lit by the diffuse light), composite,
greyscale-to-palette, skin tint, effect shader (base colour, falloff, palettes, env, lighting influence), bloom before
exposure, exposure clamp, Hable tonemap with the imagespace's Tonemap E, cinematic order, 2.2 output power,
imagespace LUTs, distance/height fog.

**Measured against the game (2026-10-05, Bman's screenshots; `docs/engine-notes.md` §19):**
- Clear noon: sunlit ground, shadowed ground, pack, suit and sky at the zenith all within 0.1 EV of the game.
- Overcast noon: everything about 0.25 EV darker than the game, evenly. That is the auto-exposure seeing a
  different scene; the light ratios match.
- 07:00: sky within 0.03 EV; sunlit surfaces 0.3-0.6 EV short of the game's warm morning light.
- 22:00 (night): the weakest case. The ground is about 1 EV too bright, the moon shadow too strong, and the
  sky about 1 EV too dark (no cloud layers yet).

**Calibrated** (fitted to those shots, not read from the engine):
- the sun's path across the sky (`web/js/weather.js` `SUN_FIT`) and the night light's path;
- the directional ambient: the DALC six-colour fit with Z- facing up, which matched the colour of shadowed
  ground (a flat ambient did not);
- the ground's specular: the landscape `_s` map × 0.6;
- the time-of-day colour keys: thirds inside the climate's sunrise/sunset windows
  (`docs/weather-notes.md` §11, one morning shot).

**Still approximated:**
- Sun colour = linear(Sunlight) × Sunlight Scale.
- Eye adaptation rate; bloom resolution and radius.
- Glow and cube maps treated as sRGB colour data.
- Alpha-blended lit geometry is forward-shaded and blended (the game blends G-buffer attributes, then lights once).
- Two sun shadow maps where the game uses cascades: the cell's objects around the view (4096², kept for many
  frames) and the character group (2048², fitted tightly around it). Shadows fade out at the cell map's edge.
- Decals (decal-flagged materials) draw after the solid geometry with a depth bias, as the game draws them.
- Sky: the game's own dome gradient (Horizon / Sky-Lower / Sky-Upper weights read from the user's
  `meshes\sky\atmosphere.nif`), but no cloud layers, no brighter sky toward the sun, and a night sky that is
  too dark.
- Not simulated: SSR, god rays, shadows of placed lights, the skin subsurface pass, hair specular, rain wetness,
  particles, the soft particles' near-camera fade, scripted enable states (quests).
- Refraction: screen-space shift by the normal map x strength x vertex alpha (approximation, not traced).
- Face: the head gets the skin-tone layer only. The game composites a face-tint texture from the character's
  other tint layers (cheeks, lips, dirt and so on), which the viewer does not build.

## Status

Tier 1 done (2026-10-05): open NIF (loose / BA2 / drag-and-drop); BGSM/BGEM materials with all texture slots;
reference bodies (Vault 111 suit M/F, body M/F, or any armour); weather presets from Fallout4.esm with continuous
time of day; game-maths lighting, cube reflections, glow, alpha; shader controllers and NiControllerSequences;
sun shadows, HDR, bloom, eye adaptation, Hable tonemap, cinematic grade, imagespace LUTs; screenshots; compare
overlay with a colour probe. In-game calibration: first round done 2026-10-05 (setups A-D and the sun-path shots
of `tools/calibration/CALIBRATION.md`); the dawn series (F) would pin down the time-of-day keys.

Tier 2: HKX playback done (GPU skinning; vanilla relaxed idle M/F, walk/jog/run/sprint in place, or any .hkx from
the archives; the calibration scenes use the male idle). Next: rain wetness, particles, cloud layers, skin-tone
picker (the race's 13 HumanSkinBase presets), local lights.

Cell viewer (2026-10-05): the World panel finds any cell in the active load order (mods included, overrides
applied as in the game) and builds it in the viewer.
- **Exteriors** load 1, 3×3 or 5×5 cells with:
  - the landscape (heights, vertex colours, up to four texture layers per quadrant);
  - every placed object (SCOLs expanded when they have no model of their own);
  - the worldspace's persistent refs that fall in the area;
  - flat water planes.
- **Interiors** use the cell's XCLL lighting (or its lighting template) and its imagespace.
- **Placed lights:** every visible light, clustered (screen tiles × depth slices), so each surface gets all the lights
  that reach it (§8 attenuation, no shadows); the reference's XLIG fade and FOV, spotlight cones and the Non
  Specular / Ambient Only / Off By Default flags apply.
- **Material swaps** of placed objects (the base's MODS or the reference's XMSP) are applied.
- **Speed:** each NIF is loaded once and drawn at every placement, with frustum culling; copies of the same
  model are drawn in a row with the material set once. Red Rocket, 3×3: 2,337 objects, 647 models, loaded in
  about 8 s, about 4 ms a frame.
- **Not yet drawn:** actors (ACHR), pack-ins, particles, grass, distant LOD, precombine optimisations, real
  water. Initially disabled refs and editor markers are skipped, and shapes named EditorMarker /
  VisibilityEditorMarker are hidden, as in the game.

Game mode (2026-10-05): the reference body and everything it wears is one placed character.
- When a cell loads, the character stands where the console's `coc` would put the player: the cell's
  `COCMarkerHeading` reference (base 0x32), facing its way. Cells without one use the middle of the navmesh triangle
  nearest the middle of the cell (navmesh = where actors can walk; NVNM read from the load order, later plugins win).
  Only pack-in storage cells and editor copies have neither; there the character stands at the middle of the cell.
  The camera starts behind the character, and the cell streams in from that spot.
- **Play as character** (or G) gives a third-person camera behind it, as in the game. W/A/S/D move
  relative to the camera at the player's speeds from Fallout4.esm (MOVT forward: run 350.9, Shift sprint
  500, Caps Lock walk 90). The vanilla run / sprint / walk / idle clips play with a short crossfade.
- Ground following, step-up (45 units), gravity, wall stops and camera collision come from small depth
  probes of the cell's solid geometry. Alpha-tested foliage and decals are ignored.
- **Space** jumps: take-off speed for the game's jump height (Fallout4.esm GMST `fJumpHeightMin` = 90 units, peak
  measured 87) under 700 units/s² gravity, with the game's standing / walking / running take-off, fall-loop and
  landing clips (`mt\neutral\jump*.hkx`, female ones where the game has them). Holding Space after the take-off
  keeps lifting the character (flying, a viewer extra); letting go drops it with the fall loop and the landing.
  Falling into the void puts the character back on the last solid ground.
- This approximates the game's Havok collision: no slope limit, no doors.

Plugin check and capture (2026-10-05):
- **From a plugin:** find any ARMO record in the load order and see what it actually makes the game load:
  - the armature picked by the default addon index or by an OMOD variant (SET = value, ADD = default + value);
  - its male, female and first-person models and the ground model, each shown as loose (with the file's date)
    or archived, or flagged missing;
  - the material swaps of the armature and the variant (MSWP, including colour remap and remove operations),
    applied when the model is worn on the matching body or loaded as a ground model.
- **`tools/capture.py`** starts a private server, renders headless in the installed Edge or Chrome (real GPU),
  waits for every texture, and saves one PNG per lighting x camera preset, a contact sheet and
  `<name>_manifest.json`. The manifest holds per-shot luminance / blown / crushed figures, the GPU, the
  resolved item and its files, and every warning. It takes `--nif` (inside Data), `--file` (any .nif on disk,
  e.g. a fresh export) or `--armor ID --variant V --sex m|f [--ground]`.
  `python tools/capture.py --help` lists the presets.

Bodies and skin (2026-10-06):
- **Body replacers:** a loose `femalebody.nif` / `malebody.nif` whose shapes differ from the archived one is a
  replacer; its shape name says which (CBBE names its shape "CBBE"). A checkbox under the reference buttons
  switches it on. Off, the reference is the vanilla body with its own materials and textures. Before this, the
  vanilla mesh picked up the replacer's loose textures, which use another UV layout, so the skin came out patchy.
- **Skin tone:** the game soft-light blends an NPC's skin colour (`NPC_` `QNAM`, the fourth float is the amount)
  over its skin shaders. The male body wears the Player record's tone (HumanSkinBase02), the female body Nora's
  (HumanSkinBase01). Without it the vanilla skin textures (mean sRGB about 0.43 / 0.34 / 0.28 on the hands) look
  deeply tanned; with it the hands match the pale hands in the noon calibration shots.

UI round 2 (2026-10-06, Bman's notes):
- Reference: Male / Female choose the body, and two stacked outfit buttons (Vault Suit, Road Leathers) dress it.
  An outfit is never shown on its own: picking one without a body uses the last body, and removing the body
  removes the outfit.
- The key hints sit at the bottom of the view and change in game mode. Explanatory sidebar notes were removed,
  and the search icons no longer overlap the text.
- Environment: running time is a switch with a speed slider (one game hour per 60 s ... 1 s); the sun direction
  has an icon. The weather line is plain words ("Clear weather, between sunrise and morning light."), with
  the record details in its tooltip.
- Camera: exposure is two buttons, Auto (eye adaptation) and Fixed. Tonemap, view and screenshot size sit
  under "Advanced", which starts folded. Animation comes before Compare, which also starts folded and opens
  when a screenshot is dropped.

Worn models on a bone (2026-10-06):
- A NIF whose root carries `NiStringExtraData "Prn"` (for example BotC's ARC: `Chest_Rear_Skin`) is a rigid,
  unskinned model that the game hangs on that skeleton bone when it is worn. NifSkope, Outfit Studio and earlier
  versions of this viewer ignore the tag and show the model at the origin in the bone's axes: at the feet,
  sideways. The viewer now loads the skeleton and hangs the model on the bone, in the current pose (it follows
  animations) or at rest. Skinned shapes in such a file are unaffected, as in the game.
- **Refraction** (SF1 Refraction, e.g. the ARC's magnetic field, stealth-boy domes): such a shape is no longer
  drawn as a lit surface (its diffuse slot holds a normal map, hence the yellow-green). It is drawn last and shows
  the finished scene behind it, shifted by its normal map (in view space) x Refraction Strength (animated by
  lighting controller variable 0) x vertex alpha, then resolved again. It casts no shadow. The game's exact offset
  formula was not traced, so the amount of bending is an approximation.
- The "Drop a .nif" hint shows only while files are dragged over the page and clears itself when the drag ends
  elsewhere, leaves the window or the window loses focus (it used to stick).
- Scene rows use eye icons (shown / hidden) instead of checkboxes. The Animation panel sums up each animated
  model in one line ("8 moving parts, 24 material animations"); the full controller list is in its tooltip.

Default scene (2026-10-06):
- On start-up (no saved scene to restore) the viewer opens the male body in the Vault 111 suit with the Player
  record's default look, in the relaxed idle, on the pre-war Sanctuary street (`PrewarSanctuaryExt01`, 3x3),
  Clear weather at 15:30, seen three-quarter front.
- Why that street: eleven candidate places were loaded and timed in the viewer (3x3, frame time with the GPU
  synchronised). The pre-war street was the only one that is clean, bright and iconic with a smooth floor at its
  COC marker, at 620 draws / 8.3 ms (Oberland Station 293 / 6.8 ms but drab; Starlight Drive-In 1,665 / 13.1 ms;
  Vault 111 outside, Spectacle Island and the pre-war house put the character in bushes, a wreck or indoors).
- Why 15:30 Clear: at that spot the afternoon sun lights the character's front; 09:00 backlights it, noon lights it
  from above, Overcast and Misty flatten the colours. For backpacks, use the 3/4 back view and turn the sun with
  the sun-direction slider.
- **Default look:** the reference bodies wear the hair and facial-hair head parts of the Player record (male:
  Hair01 + hairline + Beard01) and of Nora (female: HairLong01 + hairline), read from the load order (`NPC_` PNAM
  -> `HDPT` type 3 / 4 with their HNAM extra parts). FO4 hair colours (`CLFM` CNAM) are a remapping index: the row
  of the hair material's greyscale-to-palette gradient (`haircolor_lgrad_d.dds`): WarmBlack 0.675, CoolBrown 0.644.

Studio UI (2026-10-06):
- A slim menu bar: **File** (Import .nif, Save screenshot, Save settings, Load settings, Reset settings), **View**
  (layouts Studio / Compact / Viewport only, sidebar on the right, info overlay, key hints, fold / unfold all) and
  **Help** (Controls, About). The game folder and archive count sit dimmed on the right of the bar.
- Every panel folds by its title. The sidebar edge drags to resize it (260 to 620 px).
- Settings are kept in the browser as they change (`lightbox.settings.v1`): layout, folded panels, render options,
  weather, hour, sun direction, time speed, body, outfit, CBBE, pose, playback speed, cell radius. The start-up
  scene opens with the saved body and then puts the saved weather and hour back. Save settings writes them to a
  `.json` file, Load settings applies one, Reset settings clears them and reloads with the defaults. Loaded models
  and the cell are not settings (the live-update snapshot keeps those across reloads).

Outfits (2026-10-06): the reference has three outfit buttons: Vault Suit, Road Leathers and the Radstag Hide
Outfit (Armor_Wastelander_01_GlovesA, outfit + gloves with their own fitted hands). The third was chosen by counting
how many base NPCs in Fallout4.esm + DLC wear each body outfit through their default outfits (levelled lists split
evenly): Radstag Hide Outfit 82, BOS Uniform 81.5, Undershirt & Jeans 74.6, Flannel Shirt and Jeans 71.6, Road
Leathers 68. The Male / Female button pictures show the bodies in the Vault suit.

Enable parents and soft particles (2026-10-06):
- A reference's starting state now follows its enable parent (XESP): off when the parent starts disabled, flipped
  when it is set to the opposite of its parent, as the game does. Sanctuary showed five huge dusty-mist effects (and
  the pre-war street 106 objects) that the game only switches on for events; they hang off an initially disabled
  EnableMarker. Parents outside the loaded area count as enabled.
- Effect shaders fade by their soft depth where they near the solid scene behind them (engine-notes §11.8: alpha x
  sat((scene depth - fragment depth) / Soft Falloff Depth)), using the opaque pass's depth resolved to a texture.
- The default location is now Sanctuary after the war (Clear 10:00); Sanctuary 2077 is the second button.

Compact sidebar (2026-10-06): the body-replacer toggle (e.g. CBBE) is a tiny checkbox at the feet of the body's
card; "Import .nif" sits in the Reference title row; sun shadows and the studio floor are two icon toggles at the end
of the sun-direction row (the studio floor is the flat ground shown without a cell, so it is greyed out while a cell
is loaded); location buttons are 44 px tall.

Locations (2026-10-06): six shortcut buttons in the World section (`web/js/places.js`). Each loads its place at
3x3, puts the character at a chosen spot facing a camera that frames it, and sets the weather and hour that light it
well. Picked from twenty places measured in the viewer (draws / frame time at 3x3, a clean floor at the spot,
something worth seeing behind):

| Button | Cell | Light | Shot | Draws / frame |
| --- | --- | --- | --- | --- |
| Sanctuary 2077 (default) | PrewarSanctuaryExt01 | Clear 15:30 | three-quarter front on the street | 620 / 8.3 ms |
| Sanctuary | SanctuaryExt | Clear 10:00 | the ruined houses behind | 1,673 / 11.2 ms |
| Red Rocket | RedRocketExt | Clear 10:00 | on the forecourt, the station behind | 1,444 / 11.9 ms |
| Starlight | StarlightDriveInExt | Clear 15:30 | the Starlight sign behind, front-lit | 1,456 / 9.4 ms |
| Tenpines Bluff | TenPinesBluff | Clear 10:00 | the bluff against the sky | 432 / 7.0 ms |
| Oberland | OberlandStation | Clear 10:00 | the pump and the station yard | 368 / 6.6 ms |

Turned down: Sunshine Tidings and Nordhagen Beach (a broken-looking dark ground at the spot), Kingsport Lighthouse
(the lighthouse hides behind a ridge from the spawn), the pre-war Vault 111 interior (too dark at the elevator),
Vault 111 outside, Spectacle Island, the pre-war house (bushes, a wreck, indoors). The button pictures are rendered
once from the user's own install by a small background renderer after the start-up scene is up (about 35 s for all
six, one place's textures on the GPU at a time) and kept in the browser (`lightbox.placethumbs.v1`).

Live update (2026-10-06):
- An open page checks `/api/version` (server start id + newest file time under `web/`) every 1.5 s. When either
  changes and then stays put for one more check, the page saves its scene, reloads and restores it: body and
  outfit, models loaded from the game files (with plugin material swaps), the cell, weather, hour, sun direction,
  pose and camera. Files dropped in from outside Data must be dropped in again.
- `tools/restart_lightbox.ps1` restarts the server after a server-side change: it stops only the Lightbox server
  listening on the port (and its Start Lightbox.bat window) and starts the bat again with `--no-browser`; the open
  page reloads itself.

UI round 4 (2026-10-06): the Scene and World search boxes sit in their section's title row (results float
under the whole row); sections run Scene, World, Reference, Environment, Animation, Camera & image, From a plugin,
Compare, Shapes & materials, Log. The cell status shows the object count (models and skipped counts on hover).

UI round 3 (2026-10-06):
- **Scene** is the first section: the mesh search and the list of loaded models together.
- **Body pose** starts in the relaxed idle. It is an icon slider like the weather one: bind pose, relaxed idle, walk, jog, run, sprint. The
  idle follows the body (male or female clip).
- **Clip search** works like the mesh search: clip name, tags read from the folders (Human / Power Armor /
  creature, movement, weapon, furniture, melee, unarmed, paired, DLC, Female, Sneak) and a category icon. Clips
  for the human body come first. Creature, Power Armor and first-person clips are dimmed, because the body won't
  follow them.
- Play / pause and restart are icon buttons next to the speed slider. Checkboxes are drawn by the page: grey
  when unticked, amber with a check mark when ticked.
- `web/js/animtags.js` turns clip paths into tags; `IconSlider` (`web/js/widgets.js`) drives both icon sliders.

UI and performance pass (2026-10-05):
- **UI:** search results float under the box, each showing the file name, tags read from its folders and a
  "wear" button; reference buttons Male / Female / Vault Suit with previews rendered from the user's own files;
  a weather slider with an icon per weather; an hour slider with ticks and a Pip-Boy-style clock; imported files
  are tagged "imported".
- **Performance** (the picture is unchanged):
  - the view redraws only when something changes: camera, settings, weather, animation, eye adaptation or
    textures arriving; a still scene uses no GPU;
  - the eye-adaptation luminance is read back asynchronously (fenced pixel-pack buffer), with no per-frame stall;
  - the shadow map is kept until the sun, the bounds or the geometry change;
  - shared uniforms are set once per program per frame;
  - skinning palettes and poses are recomputed only when the pose changes.

Performance pass (2026-10-06), aimed at laptops without a dedicated GPU. Measured at 1920 x 1080 on an RTX 3080 Ti
/ i7-13700K, milliseconds per frame (median), before -> after:

| Scene | CPU | GPU | Draw calls |
| --- | --- | --- | --- |
| Studio (character) | 0.4 -> 0.3 | 2.86 -> 0.41 | 10 -> 11 |
| Sanctuary 3x3, idle animation | 7.1 -> 1.6 | 5.64 -> 2.84 | 908 -> 421 |
| Sanctuary 3x3, orbiting | 8.5 -> 1.9 | 7.06 -> 2.88 | 1601 -> 554 |
| Game mode, walking (incl. probes) | 5.7 -> 2.5 | 4.48 -> 2.84 | 556 -> 308 |
| Vault 111 interior (24 lights, fog) | 9.4 -> 2.4 | 8.06 -> 4.78 | 2214 -> 1033 |

- Every draw is instanced: the model matrix is a per-instance attribute, so all copies of a cell object take one
  call. Per-frame values live in one uniform block, material values in a block slot per shape (uploaded only when a
  value changes), bone palettes in a block per skinned shape; textures and render state are only set when they
  differ. Shader variants without skinning and without discard (opaque shaders keep early depth rejection).
- Draw order: the character first, solid objects nearest first, then alpha-tested ones and the landscape, then the
  sky (only uncovered pixels run it; its colour by elevation comes from a lookup strip built when the weather
  changes), then solid shapes that do not write depth (hair cards; drawn before the sky they vanished wherever the
  sky was behind them, fixed 10-06), decals, and blended effects sorted far to near (neighbouring copies of one
  model share a call).
- Shadows: the cell map is kept until the sun moves or the view moves past a 128-texel step (it used to be drawn
  again every frame the character animated or walked); the character map is small and fast. Filtered (hardware)
  comparisons: 9 taps instead of 25, smoother edges.
- Eye adaptation runs on the GPU (a 1 x 1 target the tonemap reads): no frame waits for a read-back any more (that
  wait cost 3-4 ms a frame). The HUD's exposure numbers are read back about once a second.
- Game mode: the ground, wall and camera probes of a frame are drawn side by side and read back once (one wait for
  the GPU process instead of three); a coarse grid of the cell's objects limits what each probe draws; no probes
  outside a cell.
- Vertex data in the NIF's own formats (half-float positions and UVs, byte normals, 16-bit indices): about half
  the memory and download of float arrays, same values.
- Dynamic resolution, only while the camera is being moved on a GPU that cannot keep 40 fps: the scene is drawn
  into part of its targets (down to 60 %) and scaled up; the next still frame is full resolution. It backs off by
  itself when a smaller picture does not help (the CPU is the limit).
- Server: built scenes are kept (gzipped, about 160 MB) while their files are unchanged, so reopening a place or
  reloading the page skips parsing; archived textures are cached by the browser, loose ones are checked again on
  every load (an edited texture shows at once).
- Render targets of an old size are released on resize (screenshots and window resizes used to leave them behind).
- Regression check: seven fixed scenes rendered before and after, compared pixel by pixel. Studio, refraction and
  interior shots match within shadow-edge noise; cell shots differ where the wider cell shadow map now covers
  porches and eaves the old one cut off, and where decal ground cover no longer fights with the ground.

Selection, in-game names and the Simple scene (2026-10-06):
- **Click to select:** a single left click (no drag) picks the model under the cursor, a character-group model or one
  placed cell object (a 1 x 1 id render under the cursor). Its visible edges get a faint green outline, drawn over
  the finished picture so it looks the same in any light, and the HUD shows its file name (and the base EDID for a
  cell object) above the weather line. A click on nothing clears it. Dragging works as before.
- **Search by in-game name:** the mesh search also matches the names the game shows for armour and clothing (every
  ARMO's FULL name and EDID mapped to its world model and armatures), so "synth chest" finds the synth torso meshes;
  results show that name with the file beside it.
- **Studio is the start-up scene:** no cell, the character on the studio floor facing the 10:00 Clear sun. The place
  grid is four wide: Studio top left, Simple bottom left.
- **Simple:** a small scene built for the viewer, `scenes/LightboxSimple.esp` (written by
  `tools/build_simple_cell.py`): a scrap shack, a rusted sedan, a fence, a mailbox, a street lamp, shrubs, dried
  grass and dead trees around a studio-floor clearing, about 50 Fallout4.esm objects (no assets of its own). One
  interior cell flagged Show Sky / Use Sky Lighting / Sunlight Shadows, which the viewer lights with the weather like
  an exterior (Clear, 08:30: warm sun from the camera's right), plus a COC marker for the character. It loads in
  about half a second. The server adds `scenes\*.esp` after the game's load order; nothing goes into Data.
  `tools/check_clean.py` accepts only plugins in scenes/ that hold nothing but a cell and placed references.
- **HUD:** the information box and the key hints share one bottom bar; when the view is too narrow for both, the
  key hints move above it instead of covering it.
- **The loaded cell is a layer:** a row at the top of the World section like the Scene's (its in-game name, its
  EditorID or exterior grid, the object count; details on hover): the eye shows or hides the whole cell (objects,
  landscape, water, placed lights; the character stays), the X unloads it. While a cell loads, a large progress
  bar sits over the top left of the view instead of a thin one in the panel.

Vault 111 report (2026-10-06, Bman's screenshots; each checked against the game's own data):
- **Green swirls on the floor:** the ripple under each ceiling drip (`WaterSplashDrips.nif`) is a refraction shape
  whose diffuse slot holds a normal map. Cell objects never went through the refraction pass (only the character's
  did), so the normal map was drawn as colour. Now they bend the picture behind them like the ARC's field.
- **Decal shimmer:** the screenshot predates the decal depth bias of the performance pass. Measured on the floor
  labels (exactly coplanar with the floor): in 30 views from 60 to 2,400 units, grazing to steep, the floor won no
  label pixel.
- **Light on interiors (the black and see-through fins):** the viewer used the 24 lights nearest the camera; Vault
  111 has 817 and a surface could lose most of the ones reaching it (at one fin post 4 of 7), and lights popped in
  and out as the camera moved. Placed lights are now clustered: every light reaching a surface lights it, as in
  the game. With that the references' own light adjustments matter and are read: XLIG fade (815 of the 817 lights
  carry one, e.g. -0.95 = nearly off) and FOV, spotlights lit only inside their cone (FOV from the record; the
  cone points along the reference's +X axis: inferred from the ceiling spots, whose rotation (0, 270, 0) then
  points straight down), Non Specular, Ambient Only and Off By Default flags. Cost in Vault 111 at 1080p: about
  1.5 ms more GPU. The fins themselves are single-sided in the NIF and in the game's precombined copy: from behind
  they are not drawn, in the game either.
- **Geometry out of place:** checked object by object against the game's precombined meshes for the cell (the
  merged geometry the game actually draws, decoded from `Fallout4 - Geometry.csg`): the wall module's geometry is
  identical to its NIF and its placement matches the Creation Kit's transform exactly. The two screenshots show
  neighbouring tanks (the fin post sits on the left of one and the right of the next). Real differences found and
  fixed on the way: material swaps of placed objects (a STAT's MODS or the reference's XMSP; 287 objects in Vault
  111, e.g. the blue cryo pipes that were brass, the mist and glow brightness variants, the prewar house colours),
  and the marker rule: objects are skipped by the Is Marker record flag, not by "marker" in the model path (that hid
  the BlackPlane blockers the game draws, and the Railroad's Freedom Trail signs).

## Cloth physics (experimental, 2026-10-06, in 1.1.0)

Bman: "Let's recreate havok". Havok itself is closed and cannot ship, so the viewer reads the data the game hands
Havok and runs its own solver on it. Nothing here comes from Havok's code; every rule below was read off the data.

**The data.** A worn NIF's `BSClothExtraData` block is a u32 length + a Havok 2014 packfile (`server/havok.py`, the
read-only half of the keychain tools' hkpack.py with layouts from Fallout4.exe's member tables; four layouts added:
compressible links, bone planes, gather-some-vertices). Every vanilla cloth (158 blocks in the clothes / armour
outfits; `tools/cloth_check.py` runs the checks on any install, 178 with mods, 0 problems) has a "Simulate" state
`ObjectSpaceSkinPN > MoveParticles > Simulate > SimpleMeshBoneDeform` and an "Animate" state without the solver.
Seven operator types, six constraint types, capsules and tapered capsules. Decoding rules (`server/cloth.py` docstring):
column-major matrices, boneFromSkinMesh = inverse(rest world), packed vectors `(int16 << 16) * float(w << 16)`,
control bytes 0..3 = 4..1-bone blocks, cloth bone = `[A-G, B-G, (A-G)x(B-G), G] x local` (reproduces every rest bone
to 0.002 units), skin buffer vertices != particle numbers in 69 files (mapped by MoveParticles and the Animate
state's copy / gather), several skin buffers in one cloth (the Institute lab coat).

**Measured, not documented anywhere:**
- Standard / compressible links store stiffness / (1/massA + 1/massB): x that sum = 1.000 for 143 of 178 cloths and
  0.95 for 33 small pouches, never more. Read raw, coats stretched 37 % on average while running.
- Bend stiffness: weights `++--` (edge A-B, wings C-D), each sign summing to 1; stiffness negative and divided by
  sum(w^2/mass) (x that = -0.66 median); `useRestPoseConfig` on everywhere, so the rest vector is taken from the rest
  pose (in an edge / normal / binormal frame). The stored scalar restCurvature matched no formula tried.
- `collisionTolerance` (up to 14 units) is a detection margin: added to the capsule radius it blew skirts outward.
- Stretch links (tethers, 0.9-1.0) and local-range stiffness (0.8-1.0) are stored as they are.

**The solver** (`web/js/cloth.js`): world space (playerRoot x pose), a fixed 60 Hz frame (the game steps cloth per
frame) split into the cloth's substeps (1-4) and solve iterations (1 in almost all vanilla cloth: soft, as the
keychain showed in game); pinned particles follow the skinned mesh, interpolated across substeps; transfer motion
hands a speed-ramped fraction of the transfer bone's (COM / Chest / Pelvis / Root) translation and rotation to all
particles (both positions: no velocity); Verlet with damping `exp(-d t)` (d = 1.0 must still let pouches move, which
rules out "fraction lost per second"); constraint sets and collisions (-1) in the cloth's own execution order;
cloth bones orthonormalised (polar decomposition) so a stretched triangle turns the bone without shearing the mesh;
teleports (> 120 units or 1.2 rad in a frame) put the cloth back on the body. Not solved yet: hclVolumeConstraintMx
(13 cloths). Cost: 0.01-1.3 ms per frame (414 particles at most).

**Treadmill.** The pose buttons play walk / jog / run / sprint in place; Havok's damping acts on world velocities,
so in game a running coat trails behind. While an in-place clip plays (not in game mode, which moves the character
for real) the solver's world moves forward at game mode's MOVT speeds (walk 90, run / jog 350.9, sprint 500 units/s),
eased over 0.3 s, and is re-centred every 20,000 units.

**Renderer.** `addModel` builds a Cloth per decoded block; `updateCloth(dt)` runs after the pose (dt = animation time,
0 while paused: the cloth stops with the body); the cloth bones go back to model space and override the bind pose in
the bone palettes (before this, cloth bones stayed in the bind pose while the body animated: coat tails did not
follow the legs). A settled cloth with a still body does not step or redraw. Captures (`tools/capture.py`) let the
cloth hang for 3 s first (`"cloth": false` in a spec skips it). Animation > cloth physics turns the solver off (the
Animate state: cloth follows the body).

**Checked so far:** every male / unisex vanilla cloth (46 meshes) stands and runs in the browser without a NaN or a
run-away particle; the Silver Shroud coat hangs, swings and trails as expected by eye. **Not yet:** comparison with
in-game footage (Bman records the reference list in `..\NifViewer_PhysicsRef`); the solver's damping, transfer and
stiffness model are the parts that footage will calibrate.

**Shimmer on moving packs** (Bman, same evening: "shadows ... flickering, along with other parts of the backpack ...
also on reflective shiny surfaces like the metal clips"). Measured on the Vault-Tec pack in the idle pose, the pose
stepped in 1/240 s increments, flicker = per-pixel second difference of luminance (motion is linear between steps,
flicker is not); the renderer is deterministic (the same time twice differs by 0):
- A regression from the cloth: the solver stepped at a fixed 60 Hz while the body animates at the display's rate,
  so cloth bones juddered against the body (max jerk 0.15-0.37 units against the chest's 0.06) and their shadows
  flickered; exact 60 Hz frames also skipped and doubled steps (float rounding). Now each cloth bone is kept
  relative to the transfer bone at the last two steps and shown blended between them on the body as it is in that
  frame (`keepLocal` / `compose`): max jerk 0.067 at 60 Hz and 0.029 at 144 Hz, the chest's own 0.058 / 0.017. The
  solver still steps at 60 Hz (what the footage will be compared with).
- The hot pixels were the metal (EnvironmentMap material, specular mult 1.98, smoothness 0.8, a 128 px cube):
  highlights up to exponent 2048 and a mirror-sharp cube lookup alias as the part moves. The game hides this with
  TAA. Option "smooth shiny highlights" (on, saved with the settings): specular anti-aliasing (Tokuyoshi & Kaplanyan
  2019: Blinn-Phong as roughness^2 = 2/(n+2), plus min(2 x screen-space normal variance, 0.18)) and the environment
  cube's mip never sharper than the reflection's own sweep across a pixel. Flicker on the buckles 8.2 -> 5.7 levels
  per frame up close; a still frame is unchanged by eye.
- Shadows: casters drawn with a slope-scaled depth offset, against self-shadow patterns that crawl on moving surfaces.
  (A second measure, lookups moved 1-3 texels along the vertex normal, was removed on 2026-10-07: Bman found black
  blotches on the sunlit side of the Vault suit; the suit's normals do not follow its surface everywhere, so lookups
  landed inside the body. Bisected against 1.0.1 on a fixed pose; it had measured no gain here anyway.)
- Left: bright edges of polished parts still alias a little under MSAA, because the samples are averaged in HDR
  before tone mapping and WebGL2 has no per-sample resolve. A temporal filter like the game's TAA would remove it
  (and be closer to the game's default look): done the same evening, below.

**TAA** (Bman: "Adding TAA?! ... the view could use some aliasing"). FO4's default anti-aliasing; settings.taa +
settings.msaa (Camera & image > Anti-aliasing: TAA + MSAA x4 (default), TAA alone (msaa 1 = no multisampling, as
the game), MSAA x4 alone).
- Jitter: the drawing projection is shifted by Halton (2, 3) offsets, 8 per cycle (`projR`); picking, the motion
  vectors and the sky reprojection use the plain matrices.
- Motion vectors: the mesh vertex shader outputs this frame's and last frame's clip position without jitter
  (Frame block `uCurViewProj` / `uPrevViewProj`, per-draw `uPrevDelta` = last playerRoot x inverse(this one) for
  the player group, last frame's bone palette in a second uniform block `BonesPrev` per skinned shape, synced once
  after each palette change). Lit, landscape and effect shaders write motion (xy) and coverage (a = 1) to a second
  MSAA attachment (RGBA16F); the sky, decals, blended layers and refraction are drawn with that attachment off.
  The resolve averages both, so motion / coverage is the covered samples' own motion even on an edge.
- TAA_FS: 3x3 neighbourhood mean / spread in tone-compressed YCoCg (c / (1 + max c)); motion of the fastest
  neighbour; the sky (coverage 0) reprojected by the camera rotation only; history read with a 5-tap Catmull-Rom;
  variance clipping (gamma 2 for still pixels, 1 for moving ones); per-pixel history age in the history's alpha:
  still pixels average up to 16 frames evenly, moving ones about 8 (floor 10 % of the newest); a pixel clipped
  far from its history starts over. Off-screen history and resizes / render-scale changes reset.
- Still scenes: `taaStill` counts frames with nothing changed (signature + geomVersion); needsFrame keeps drawing
  until 16, then the picture is a 16-sample supersample and nothing is redrawn. Cloth reports a change only when
  its shown bones change (compose key), else a still scene never settled. Screenshots draw 18 still frames first.
  Thumbnails (thumbs.js, one renderer for many bodies) keep TAA off.
- Measured (Vault-Tec pack, idle, pose stepped 1/240 s, 1280 x 960): flicker on the hot pixels 0.37 (TAA) / 0.31
  (TAA + MSAA) of MSAA's; a converged still frame changes 0.1 levels on average (75 of 1.2 M pixels > 10); running
  coat and game-mode run through Sanctuary without visible ghost trails; Sanctuary 1080p 4.0 ms/frame (MSAA) vs
  5.5 ms (TAA). The whole frame's frame-to-frame change is 1.35x MSAA's: low-amplitude jitter residue spread
  thinly instead of sparkles in a few places.
- On the way: LAND_FS is built by text replaces on LIGHTING_FS; the specular-AA edit of the env lookup made two of
  them miss (the landscape then read a cube sampler on a 2D unit, and once a removed statement turned the next
  declaration into an if body). A check now logs any replace that misses; both output locations are explicit.

## 1.2.0 (2026-10-11)

1.1.1 never shipped on its own: 1.2.0 is the first update after 1.1.0 and contains it (mod manager install, the trimmed
runtime, the taskbar button, MSAA for old settings), plus collision and physics (see "Collision and physics" below).

Bman: "could we make it compatible with mod manager download button? like wrap it in fomod" and, on hearing the main
zip held ~1,560 files, "WHAT?". Then (via the video session) the window's own taskbar button. No change to what the
viewer draws.

**Taskbar button** (Bman's screenshot: his pinned `FO4 Lightbox.exe` and, next to it, the running window under the
Edge logo). An Edge / Chrome `--app` window carries the browser's AppUserModelID, so Windows groups it with Edge. The
launcher now stamps the window's property store (`SHGetPropertyStoreForWindow`, which works on another process's
window) with `System.AppUserModel.RelaunchCommand` (the launcher exe), `RelaunchDisplayNameResource` ("FO4
Lightbox"), `RelaunchIconResource` (the exe's icon) and, last, `System.AppUserModel.ID` = `FO4Lightbox.Viewer`; the
launcher process takes the same ID (`SetCurrentProcessExplicitAppUserModelID`), so splash, window and a pin of the
window share one button. Which windows: the visible unowned top-level windows of the browser process the launcher
started (if that process handed the window to a browser already running on the profile: the window still titled
"FO4 Lightbox"), right after the window appears, every 250 ms for 5 s, then every 2 s while the launcher waits for
the window to close; `Activate()` (Open with hand-over) stamps the window it brings to the front. Stamping is
idempotent: a window that already has the ID is left alone. No icon is forced on the window: Edge shows the page's
favicon (the same cube) and would put it back. A split second of the Edge button remains at start-up, and a pin of
the exe made before 1.2.0 has no ID: unpin it and pin the running window (README). The properties stay on the
window until Edge destroys it (the launcher cannot clear them first; a few strings). Checked cross-process with a
hidden window in a second process (written, read back through a fresh property store, second stamp left alone);
the taskbar itself is for Bman to see.

**MSAA by default, for old settings too** (Bman, via the video session; the change is that session's, in
`main.js`). The code default was already MSAA x4, but settings saved by the 10-06 dev builds held `"aa":"taa"`.
`collectSettings` now saves `aaV: 2` next to `aa`, and `applySettings` takes the saved `aa` only when `aaV >= 2`, else
MSAA: an old TAA resets once, a TAA picked from now on stays.

**Mod manager install.** Both zips now hold a `fomod` folder next to `FO4 Lightbox` (written by `build_release.py`,
`fomod()`): `ModuleConfig.xml` has one `requiredInstallFiles` entry, folder `FO4 Lightbox` to `Tools\FO4 Lightbox`.
A FOMOD can only install inside Data, so Vortex and MO2 put the viewer in `Data\Tools\FO4 Lightbox`, as BodySlide is
installed; unpacked by hand, the zip gives the same folder as before plus the small `fomod` folder. Inside Data the
viewer is never read as game data: its loose-file scans only walk the asset folders (`meshes`, `textures`, ...), and
MO2's index only its INDEXED top folders. To keep "writes nothing to the game folder" true there:
- Python's caches of the viewer's own modules go to `%LOCALAPPDATA%\FO4 Lightbox\pycache` (`sys.pycache_prefix`,
  set at the top of `server/app.py`, and in the two tools that import server modules) instead of `__pycache__` next
  to the code. The bundled runtime's modules ship compiled, so it writes no caches at all.
- `game_path.txt` (the folder typed into the console when the game isn't found) moved from the viewer's folder to
  `%LOCALAPPDATA%\FO4 Lightbox`, the file the launcher already used; the old location is still read.
- Checked by a simulated install (scratch `FakeGame\Data\Tools\FO4 Lightbox`, trimmed runtime): a server run that
  served the page and loaded the weather left the install's files exactly as they were; the cache went to
  `%LOCALAPPDATA%`.
Found from where it's installed: `fo4paths._own_install()` (the game whose `Data` holds the viewer, tried after
`--game` / `FO4_DATA` and before the registry) and `mo2.home_instance()` (the MO2 instance whose `mods` folder holds
it, added to the instances found even when MO2 didn't start the viewer). Not run through MO2's virtual Data: it reads
MO2's profiles itself, so MO2 users start `FO4 Lightbox.exe` from the mod's folder (README).

**The bundled Python, trimmed.** 1.1.0's runtime was the whole standard library and the whole numpy package, each
module as source plus compiled cache: 1,470 of the main zip's 1,564 files (the viewer itself is 58). 1.2.0 ships only
what the viewer can import, each module as one lone `.pyc` where its `.py` would be (Python imports those without
the source; tracebacks show no source lines for stdlib frames). `build_release.py` `runtime_modules()` picks them:
- Every import statement in the shipped scripts (`RUNTIME_ROOTS`), followed through the standard library and numpy,
  imports inside functions included (a rarely used code path still finds its module). Skipped: `if __name__ ==
  '__main__':` blocks (heapq's self-test alone pulled in doctest, pdb, asyncio, multiprocessing, the test suite and
  setuptools: 467 modules instead of 187) and `if TYPE_CHECKING:` blocks; in `numpy/__init__.py` only module-level
  imports count (its function-level ones are the lazy `np.fft`, `np.ma`, `np.f2py` ... attributes).
- Plus what Python and `import numpy, numpy.random` load at start-up, and then, until nothing new turns up, whatever
  importing all of the kept modules loads: compiled modules import Python modules from C code (`_ctypes` needs
  `ctypes._layout`, numpy's core needs `numpy._core._exceptions`), which no import statement shows.
- Plus `RUNTIME_EXTRA`: the codecs the viewer names in strings and Python's defaults, and `numpy.random` (the mesh
  particle emitters use `np.random.default_rng`).
- Minus `RUNTIME_DROP`: modules imported only behind `try: ... except ImportError` for what the viewer never does
  (HTTPS: `ssl` with OpenSSL's DLLs, 6 MB; `.bz2` / `.xz` / `.zst` archives; OpenSSL hashes, where hashlib falls back
  to the ones built into Python) and site.py's interactive console and `help()`.
Result (Python 3.14.3, numpy 2.4.3): 212 standard library modules, 8 extension modules, 99 numpy modules, 355 runtime
files; the main zip 414 files and 17.5 MiB (1.1.0: 1,564 files, 27.3 MiB), 420 files and 18.6 MiB with the physics engine. The build checks the staged runtime in an
environment without any other Python: every module it holds imports, every `np.<name>` the viewer's code uses
resolves, `server/app.py --help` runs.

## 1.1.0 (2026-10-07)

1.0.1 never shipped on its own: 1.1.0 is the first update after 1.0.0 and contains it (MO2, launcher, reload options).
Cloth physics and TAA ship **experimental and off by default** (MSAA x4 stays the default look, as in 1.0.x); smooth
shiny highlights and everything else are stable.

**Review.** Five reviewers (shaders, TAA, cloth solver, cloth decoding, performance / GL state) read the cloth / shimmer
/ TAA work, then a sceptic per area tried to refute each finding: 32 findings, 25 verified (the 7 cloth-solver ones
were fixed after offline measurement instead). Fixed:
- Cloth decoding (server/havok.py, cloth.py): array sizes bounded by the data, every index and solver count checked
  (`_check`), no NaN / Infinity into the scene JSON (JSON.parse rejects it: the model would not load at all), zero-
  length bend edges. A cloth that fails is logged (`cloth N: failed: ...`) and dropped; the mesh always loads. Fuzz
  (27,803 damaged blobs): 0 bad decodes, 0 hangs (was ~1,500 and 109). Trapper outfit: particles the Animate state does
  not place are matched to their skinned vertex at rest (140 -> 0 unplaced). Cloths that drive none of the NIF's meshes
  are dropped (52 in this install). tools/cloth_check.py counts dropped cloths.
- Cloth solver (web/js/cloth.js): converging polar decomposition (77 cloths had bone spikes, now 0); the bend
  constraint fades out when its two wings fold past ~90-130 degrees (the mean normal flips and threw particles through
  the fold) and acts at half the stored strength, on positions and last positions alike (no energy pumped in); the
  still test looks at what is shown (particles of cloth bones, or cloth-bone motion < 0.01 per step); particles with no
  path to a pin or the body are carried on the body (Lorenzo's outfit fell for ever); display blend from the step
  before the last after multi-step frames (60 Hz judder); paused pose changes re-pin the cloth; the treadmill comes
  back when the character stops; per-clip treadmill speed (searched clips, leaving game mode). Measured over all 178
  cloths: idle jitter > 0.05 in 4 (was 16), never settling in the bind pose 13 (was 28), no NaN.
- TAA: rigid parts moved by node animation or a Prn bone get their own previous placement (per draw uPrevDelta =
  prevW x inverse(W)): the ARC / GECK packs and fans no longer smear; a "reactive" flag (outVel.z) for shapes whose UV
  offset / scale / alpha changed (flipbooks such as the Rad Warden dial): TAA trusts the new frame there; 16 Halton
  positions; 1.1 s of refinement after a change seen from a still camera (16 frames left 36 % of the old picture);
  Screenshot button and captures settle 18 still frames; shots above 1x with TAA use TAA alone (half the memory); no
  jitter on the selection outline; place thumbnails without TAA; one velocity resolve per frame.

**Cell objects keep their root (Bman's Red Rocket report).** A floating road slab: its NIF (RoadASkirtIntTRamp01) has
a 180-degree rotation on its root node, and the game ignores a root node's transform for placed references (the
precombined copies in the game's files match the reference without it to 0.0 units, with it 600+ units off). 322
vanilla models carry a root transform (doors, catwalks, posters, curbs; ~18,000 placements). The cell loader asks for
`nif?...&placed=1`, which resets the root's local transform (scene.build_scene placed).

**Reload textures & materials, before / after** (Bman: "manually reload the material/texture after updating, then have
a before/after button"). R or File > Reload textures & materials: `/api/tags` returns each file's tag (a loose file's
size and date, an archive's own stamp after re-indexing a repacked one); scene answers carry `deps` (the tags of the
NIF and materials they were built from); textures keep their ETag. Only what changed is read again: a texture gets a
new copy under every option it is used with (`reloadTexture`; the old one is "retired"), a material is applied with
all its textures at once (`applyMaterial`, no half-textured frame), a changed NIF replaces the model in place. The
previous look is the model's "before" twin: its shapes with the old material and textures sharing geometry, bones and
placement (`twinShapes`), or the whole old model when the NIF changed (posed every frame through `liveModels`). The
main pass tags draw items before / after / both and runs its sequence twice, each scissored to its side of the split
(`compare.split`); B held shows only before; "keep the original" pins the first look. Closing the bar frees the twins'
material slots, the old models' buffers and the retired textures nothing else uses. Tested with copies of the
Lamplighter pack in a scratch Mod Organizer 2 mod (texture recolour, material swap, re-export): no GL errors, frees
measured.

**Not in 1.1.0:** merging the window's title bar into the toolbar. In an Edge / Chrome `--app` window the title bar
is the browser's; the page can take it over only when Lightbox runs as an *installed* web app (Window Controls
Overlay: tested, `navigator.windowControlsOverlay.visible` is false in an `--app` window), or in a window of our own
(WebView2: Microsoft's SDK libraries would ship in the zip). Both are options for a later version.

## Direction: a "cinematic" renderer (Bman, 2026-10-07)

"We ARE making this into a 'cinematic' mode. We should try and recreate the rendering system as much as possible, as
close as possible." What Lightbox already does (the game's materials, weather, imagespace, lighting maths, TAA) is the
base; the goal is the picture the game would show, frame for frame. Next, by visible gain for the work:
1. **Ambient occlusion (SSAO).** Done 2026-10-07: the game's SAO, see "Ambient occlusion" below.
2. **Projected decals** (grime, blood, paint on walls and floors, BGSD / decal references). Interiors look too clean
   without them.
3. **Shadows of placed lights**, at least for photos (the game shadows a few spot / omni lights per view). Could be a
   "photo" quality setting first if it costs too much while orbiting.
4. **God rays / light shafts** (the game's sun and interior volumetrics), then fog volumes.
5. **Particles** (dust motes, steam, fire, the charm smoke): a NiParticleSystem reader; the largest piece of work.
6. Checks on the way: spotlight direction (ref +X vs the fixture's own beam, see the charm photo notes), night levels.

## Ambient occlusion (2026-10-07, in 1.1.0)

Bman: "You're working on ambient occlusion now." The first item of the cinematic roadmap. The game's SAO was read off
its shaders first (a research pass over the private disassembly; maths and constants in engine-notes §21). Its two
findings that matter: the occlusion multiplies the deferred surfaces' **whole** lit colour (not just the ambient
light), and its footprint is a fixed 100 x R / z texels at half resolution, far smaller than the 108-unit radius
suggests (a first version that used the true radius came out almost invisible: darkest 0.79).

- Passes (renderer.ambientOcclusion, before the lit scene): a depth pre-pass of the solid and alpha-tested surfaces
  (the main pass's instances, matrices and TAA jitter, so it lines up per pixel; effect shapes and blended surfaces
  left out, as the game draws them after its occlusion), SAO_FS at half resolution (10 samples, 7 turns, the game's
  bias terms), SAO_BLUR_FS across and down (the game's 7 taps and depth cut). The lit shaders multiply the lit colour
  by it before fog where the material is a deferred surface in the game (material block mDebug.y: solid,
  alpha-tested, decal, landscape).
- Settings from the user's own INI files (server fo4paths.sao_settings, sent with /api/status; Fallout4_Default.ini
  then Fallout4.ini, Prefs, Custom). Camera & image > ambient occlusion (as the game), on by default like the game;
  View debug "ambient occlusion" shows the buffer.
- Footprint scaled with the render height / 1080: the game's at 1080p, the same look at any size.
- Measured: Vault-Tec Regional HQ: contact shadows under the terminal, fan and chair, corners and the clock rim
  (buffer down to 0); worn packs darken where they meet the back. Sanctuary 1080p: +1.5 to 3 ms per frame (the
  depth pre-pass draws the geometry a second time). No GL errors with TAA, MSAA, 2x renders, the before / after
  split and the thumbnails.
- Not done: the G-buffer normal (normal-map detail in the occlusion), the depth pyramid for wide samples, the
  in-game history (the TAA, when on, smooths the same noise). No in-game reference shot with SSAO on exists yet
  (calibration G_effects_noon was never taken): a check against the game is pending.

## Release package

`FO4 Lightbox.exe` (1.0.1, Bman: "make it seem like a professional grade tool"): a small launcher compiled at release
time from `launcher/Launcher.cs` with the C# compiler that ships with Windows (.NET Framework 4, C# 5: no
interpolated strings, no `?.`), with the icon from `launcher/make_icon.py`. It shows a splash, starts
`runtime\python.exe -X utf8 -u server\app.py --no-browser --port 8765 --exit-when-idle 180` with no console window
(output in `%LOCALAPPDATA%\FO4 Lightbox\server.log`), waits until `/api/version` answers, and opens the page in Edge
(else Chrome) app mode with its own profile (`%LOCALAPPDATA%\FO4 Lightbox\browser`, `--disable-sync`: a fresh Edge
profile otherwise signs in with the Windows account and opens a sync page). Closing the window stops the server; a
viewer already answering on the port is reused (another window, the second launcher exits); a busy port moves to the
next free one; "Fallout 4 was not found" in the server output brings up a folder picker (kept in
`%LOCALAPPDATA%\FO4 Lightbox\game_path.txt`, `--choose-game` asks again). `--exit-when-idle` stops the server when no
page has polled for that long (a minimised page still polls about once a minute). Only the main zip carries the exe:
the zip without Python stays free of executables. Tested from an extracted zip: start in 3.8 s, the window titled FO4
Lightbox, closing it ended launcher, Edge and server within 0.5 s with no leftover processes; a second start reused the
server; idle stop after 6 s with `--exit-when-idle 6`. Not code-signed: SmartScreen may warn on first runs (README).

Splash (Bman: "a DOPE loading screen, like Photoshop"): the artwork is original and drawn in code
(`launcher/splash/splash.html`: canvas + CSS: the lit cube, sun rays and a lens streak, the time-of-day arc, a
perspective floor with the cube's shadow and reflection, dust, grain; the "Light**box**" wordmark), rendered to
`launcher/splash.png` (1600 x 1000, transparent around the card so its shadow is soft) by `launcher/make_splash.py`
in headless Edge, and embedded in the exe (the PNG itself is not in the zips). The launcher shows it as a layered
window (per-pixel alpha: rounded corners, shadow), fades it in and out, and draws the live strip itself: the status
line (old line fades out sliding up, the new one slides in), the version, and the progress bar (amber gradient, glow,
a sweeping highlight, a bright head). The bar follows the real steps: Python started, the server's "N archives, M
archived files indexed" line, `/api/version` answering, `/api/ready` (weather, world, meshes), the window appearing;
between steps it creeps a little toward the next so it never looks stuck. The start-up runs on a worker thread so the
splash animates at ~60 fps. Measured on Bman's PC (two 4K screens at 150 %): splash 1200 x 750, centred on the screen
with the cursor; Python at 0.4 s, archives indexed 0.9 s, cells 1.4 s, the viewer's window at 2.4 s. A hidden check
mode renders one frame to a PNG: `FO4 Lightbox.exe --render-splash out.png 0.6 "status text"`.

1.0.1 (2026-10-06, a Nexus report: "when I start it via MO2, it constantly re-reads the cell, saying the game files
changed"): the change checks compared a file's size and date asked by name (os.stat) with the ones read through an
open handle when it was indexed. On a plain disk they agree; under Mod Organizer 2's virtual Data folder they need
not (Python 3.12+ asks Windows by name through GetFileInformationByName, which a virtual file system may answer
differently or not at all), so every check saw a change and the page reloaded forever. Now every check reads through a
handle like the reads do (fileshare.stamp), existence checks fall back to opening the file (fileshare.exists: files
that only exist in the virtual folder), archive lists compare without case, the console names the files that changed,
the same files read again 4 times within 30 s pause the automatic checks (shown on the page; File > Reload game files
resumes; real edits such as mods toggled in MO2 name other files and do not count), and View > "Reload when game files
change" off turns automatic reloads into a notice with a Reload button. Tested by simulating the disagreement (the
guard paused after 4 rebuilds, none while paused) and with a scratch plugin saved while the page was open; not yet
tested under MO2 itself.

Native Mod Organizer 2 (1.0.1): the viewer no longer needs MO2's virtual folder at all. `server/sources.py` defines a
source (game folder, roots, plugins.txt, INI folder, top-level file lookup, loose index); `server/mo2.py` implements it
for an MO2 profile from MO2's own files, checked against MO2 2.5.2's source (instancemanager.cpp, settings.cpp,
profile.cpp, organizercore.cpp fileMapping, game_bethesda creationgameplugins.cpp):

- Instances: `%LOCALAPPDATA%\ModOrganizer\<name>\ModOrganizer.ini` (global), `ModOrganizer.ini` next to
  `ModOrganizer.exe` (portable, `portable.txt`), found also through the nxm handler (`HKCU\Software\Classes\nxm`,
  `nxmhandler.ini` / `downloadhandler.ini`), the parent processes (MO2's Run button) or usvfs + MO2's folder on PATH,
  and folders the user added (Mods menu, `--mo2`; kept in `%LOCALAPPDATA%\FO4 Lightbox\settings.json`). Only
  instances whose `gamePath\Data\Fallout4.esm` exists count (Stock Game copies included).
- `ModOrganizer.ini` is QSettings INI: `@ByteArray(...)` holds UTF-8 bytes (`\xNN` escapes), backslashes doubled,
  `%BASE_DIR%` in the `[Settings]` folders (defaults: mods, profiles, overwrite under base_directory).
- `modlist.txt`: highest priority first; `+`/no prefix enabled, `-` disabled, `*` unmanaged (already in Data);
  separators and `*backup*` folders never enabled. Data, then the enabled mods from low to high, then Overwrite;
  `skip_file_suffixes` (`.mohidden`) and `skip_directories` (`.git`) left out.
- The profile's `plugins.txt` (ANSI code page; primary plugins and Fallout4.ccc ones left out, fo4paths adds them),
  and its own `fallout4.ini` / `fallout4custom.ini` when `settings.ini` LocalSettings is on (default: on).
- Only the mods and Overwrite are indexed (meshes, textures, materials, strings; measured 16,727 files in 0.32 s on
  the dev PC, disk cache warm);
  Data stays live as in game-folder mode, the mods' files winning over it. The profile's modlist.txt / plugins.txt /
  settings.ini are watched: a change in MO2 re-reads the profile ('mod list' in the console). Files added to a mod's
  folder appear on File > Reload game files (MO2 itself also needs a refresh for those).
- Start-up pick: `--source` / `--mo2`, the MO2 that started the viewer, the user's last choice, MO2's current
  instance when its selected profile has mods enabled (an MO2 set up once and left empty does not count), else the
  game folder. `/api/sources` lists them, `/api/source?id=` switches (new VFS, cell index, caches dropped,
  `source_epoch` in the data version, the page reloads with its scene), `/api/source/add?path=` adds a folder.
- Tested on a synthetic setup (scratch only: global instance with a moved base directory, portable one with a
  non-ASCII profile name, priority overrides, disabled mod, separator, `.mohidden` file and folder, plugin + BA2
  inside a mod, an archive listed in the profile's own INI, a mod list edited while running) and on this PC's own
  untouched MO2 2.4.4 instance; not yet with a large real mod list.


`python tools/build_release.py` (Windows, run with a python.org Python 3.14 that has numpy installed) writes into
`..\NifViewer_Release\`:

- `FO4_Lightbox_<version>.zip`: the viewer plus `runtime\`, a trimmed copy of that Python (python.exe and its DLLs,
  the standard library as a plain `Lib` folder with hash-checked compiled caches, numpy without its tests) and a
  `python3XX._pth` that isolates it from any other Python on the PC. `runtime\BINARIES.txt` lists every .exe / .dll /
  .pyd with its SHA-256, Authenticode signer and origin; numpy's files are checked against numpy's own RECORD hashes
  and the build stops if one differs.
- `FO4_Lightbox_<version>_without_Python.zip`: the same viewer without `runtime\` (Python 3.10+ with numpy needed).
- `SHA256SUMS.txt`.

Only the files in the script's INCLUDE list ship; anything else in the project is reported. The build runs the
clean check on the project and on the staged copy, refuses archives inside the release, and starts the bundled
runtime with no Python on PATH (imports + `server/app.py --help`).

Nexus (2026-10-06): the first upload with the runtime was quarantined by the automated checks (executables; the
standard library was then a zip inside the zip). The stdlib is now a folder; files with executables still need
Nexus's manual review (email support with the BINARIES.txt facts and the source links). The file without Python
passed at once. Tested before release: the extracted zip on an empty user profile with no Python on PATH (game found
via the registry, 21 API checks, page and cells in Edge), the zip without Python on Python 3.10 + numpy 2.2.6, and
the next-gen install (BA2 v7/v8).

## Credits and thanks

FO4 Lightbox stands on the work of a lot of generous people: modders who mapped Fallout 4's file formats and gave their tools away, researchers who published the methods it draws with, and players who tried it and told us what broke. Thank you, every one of you.

This section, the README's, Help > About and the Nexus page draft are written by `python tools/credits.py` from one list: add or change credits there.

### Modding tools and file formats

- **The [NifTools](https://github.com/niftools) team**: [nif.xml](https://github.com/niftools/nifxml), the community's map of the NIF format that Lightbox's mesh reader follows, and [NifSkope](https://github.com/niftools/nifskope). Thanks also to jonwd7 for NifSkope's Fallout 4 renderer, and to hexabits and Candoran2 for its [development builds](https://github.com/hexabits/nifskope).
- **ousnius**: [BodySlide and Outfit Studio](https://github.com/ousnius/BodySlide-and-Outfit-Studio), the [nifly](https://github.com/ousnius/nifly) NIF library and the [Material Editor](https://github.com/ousnius/Material-Editor), whose BGSM / BGEM layouts Lightbox's material reader follows.
- **Bad Dog**: [PyNifly](https://github.com/BadDogSkyrim/PyNifly). Its Fallout 4 animation reader ships unchanged inside Lightbox, so the reference body can play any HKX clip, and PyNifly is what Lightbox's NIF reader was checked against. Its documented Havok collision layouts are what Lightbox's collision reader follows.
- **Dagobaking**: the spline decompression of Fallout 4 animations (skyrim-fo4-animation-conversion) that PyNifly's reader is based on.
- **PredatorCZ**: [HavokLib](https://github.com/PredatorCZ/HavokLib), the Havok format library underneath that decompression.
- **ElminsterAU, Sharlikran, Zilav, Hlp and the xEdit team**: [xEdit](https://github.com/TES5Edit/TES5Edit) / [FO4Edit](https://www.nexusmods.com/fallout4/mods/2737). Lightbox's plugin, weather and cell readers were checked against its record definitions, value by value.
- **fo76utils**: the [NifSkope fork](https://github.com/fo76utils/nifskope) and [fo76utils](https://github.com/fo76utils/fo76utils). Their open Fallout 4 shader was the cross-check for Lightbox's materials and shader animation.
- **MANOLOV02**: [Nif Explorer](https://www.nexusmods.com/fallout4/mods/108129), [FO4_Base_Library](https://github.com/MANOLOV02/FO4_Base_Library), [Wardrobe Manager](https://www.nexusmods.com/fallout4/mods/94884) and [NPC Manager](https://www.nexusmods.com/fallout4/mods/105008). Their documented findings on the game's image space and weather records were a valuable cross-check.
- **The [Mod Organizer 2](https://www.modorganizer.org/) team** ([source](https://github.com/ModOrganizer2/modorganizer)): Lightbox reads your MO2 profile straight from its files.
- **The [OpenMW](https://openmw.org/) team**: their open engine documents how this engine family moves the sun across the sky.
- **Julian Thomas and the OpenFO4 contributors**: [OpenFO4](https://github.com/julianthomas04/OpenFO4). Their open engine pointed Lightbox at placed objects' colour remapping, interior lighting-template inheritance and the light records' shading switches.

### Rendering research

Each one written fresh from the published method:

- **John Hable**: the filmic "Uncharted 2" tonemap curve the game uses ([Filmic Tonemapping Operators](https://filmicworlds.com/blog/filmic-tonemapping-operators/), 2010).
- **Morgan McGuire, Michael Mara and David Luebke**: [Scalable Ambient Obscurance](https://research.nvidia.com/publication/2012-06_scalable-ambient-obscurance) (2012), the game's default ambient occlusion.
- **Brian Karis**: [High-Quality Temporal Supersampling](https://advances.realtimerendering.com/s2014/) (SIGGRAPH 2014), the temporal anti-aliasing.
- **Marco Salvi**: [An Excursion in Temporal Supersampling](https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf) (GDC 2016), the variance clipping that keeps TAA from ghosting.
- **Matt Pettineo**: [Catmull-Rom filtering in a few bilinear taps](https://gist.github.com/TheRealMJP/c83b8c0f46b63f3a88a5986f4fa982b1), the sharp history read of the TAA.
- **Yusuke Tokuyoshi and Anton Kaplanyan**: [Improved Geometric Specular Antialiasing](https://doi.org/10.1145/3306131.3317026) (I3D 2019), the "smooth shiny highlights" option.
- **Ola Olsson, Markus Billeter and Ulf Assarsson**: [Clustered Deferred and Forward Shading](https://research.chalmers.se/en/publication/161725) (HPG 2012), how thousands of placed lights light a cell.
- **Matthias Müller, Bruno Heidelberger, Marcus Hennix and John Ratcliff**: [Position Based Dynamics](https://diglib.eg.org/items/deb0a7a1-2ddf-496f-889a-fe0df1feeb73) (2006), the method of the cloth solver.
- **The classics the game's own shading is built from**: [Oren-Nayar](https://en.wikipedia.org/wiki/Oren%E2%80%93Nayar_reflectance_model) diffuse (1994), [Blinn-Phong](https://en.wikipedia.org/wiki/Blinn%E2%80%93Phong_reflection_model) (1977) and [Cook-Torrance](https://en.wikipedia.org/wiki/Specular_highlight#Cook%E2%80%93Torrance_model) (1982) highlights, [Schlick's Fresnel](https://en.wikipedia.org/wiki/Schlick%27s_approximation) (1994), [Kajiya-Kay](https://history.siggraph.org/learning/rendering-fur-with-three-dimensional-textures-by-kajiya-and-kay) hair (1989), [Henyey-Greenstein](https://en.wikipedia.org/wiki/Henyey%E2%80%93Greenstein_phase_function) (1941) and [Rayleigh](https://en.wikipedia.org/wiki/Rayleigh_scattering) scattering, [shadow mapping](https://en.wikipedia.org/wiki/Shadow_mapping) (Lance Williams, 1978) with percentage-closer filtering (Reeves, Salesin and Cook, 1987), [Halton](https://en.wikipedia.org/wiki/Halton_sequence) jitter (1960) and [Catmull-Rom](https://en.wikipedia.org/wiki/Catmull%E2%80%93Rom_spline) splines (1974).

### Bug reports

- **NeinGaming**: found Lightbox's first real bug (the endless reload under Mod Organizer 2) and suggested a manual reload. Both made it into 1.1.0.
- **stalkerVlad1**: found that the animation search gave no sign of life (an empty box opened nothing, a failed search stayed silent). Fixed in 1.1.0.
- **MONSTERaider**: found that the first start of 1.2.0 and 1.3.0 could stop the viewer's server under its open window (it then waited on "Loading reference" for ever), and that the window's browser cache grew past 5 GB. Both fixed in 1.3.1.

### Made by

- **Bman**: the idea, the direction and every design call, plus hours of in-game calibration screenshots, so Lightbox is measured against the real game instead of eyeballed. Made for Backpacks of the Commonwealth.
- Written with **Claude** (Anthropic).

### Where they are used

- `server/vendor/anim_fo4.py`: PyNifly's reader (Bad Dog), unchanged; spline decompression after Dagobaking and PredatorCZ's HavokLib.
- `server/fo4nif.py`: nif.xml (NifTools) block layouts; checked against PyNifly / nifly.
- `server/materials.py`: the Material Editor's BGSM / BGEM field order (ousnius).
- `server/esm_weather.py`, `server/esm_world.py`: FO4Edit 4.1.5f definitions (`FO4Export -q raw`) and FO4Dump's decoded output (the xEdit team).
- `server/mo2.py`, `server/sources.py`: Mod Organizer 2.5's file formats.
- `server/havok.py`, `server/cloth.py`, `web/js/cloth.js`: Fallout 4's Havok 2014 cloth data, run by a position-based solver (Müller et al.).
- `web/js/shaders.js`: Hable tonemap; SAO (McGuire, Mara, Luebke); TAA (Karis, Salvi, Pettineo's Catmull-Rom read); specular anti-aliasing (Tokuyoshi, Kaplanyan); light shafts (Henyey-Greenstein, Rayleigh); the game's BRDF terms (Oren-Nayar, Blinn-Phong, Cook-Torrance, Schlick, Kajiya-Kay).
- `web/js/renderer.js`: clustered placed lights (Olsson, Billeter, Assarsson); Halton jitter; shadow maps with percentage-closer filtering.
- `docs/engine-notes.md` Section 25: the sun path, after OpenMW's documented model.
- `server/esm_world.py` (`_color_remap`, `_inherit_lighting`), `web/js/world.js` / `web/js/shaders.js` (the LIGH shading switches): features OpenFO4 pointed at, written fresh and checked against Fallout4.esm (engine-notes Section 28).
- `docs/prior-art.md` (not shipped): the study of Nif Explorer / FO4_Base_Library (MANOLOV02), the fo76utils NifSkope fork and Outfit Studio.

## Licence

GPL-3.0 (see `LICENSE`); required by and in keeping with PyNifly's HKX reader in `server/vendor/`. The viewer contains
no Bethesda data.

## Projected decals (2026-10-07, in 1.1.0)

Cell viewer: placed TXST references with decal data (DODT) are drawn as projected decals: grime, blood, scorch marks,
puddles, ground blends (Vault 111 has 540, Sanctuary 51, Red Rocket 42). Camera & image > "projected decals" turns
them off.
- Server (esm_world._decal): DODT sizes (one per reference between min and max, seeded by the FormID) times the
  reference's XPDD (width, height scale); depth = DODT depth; material = the MNAM BGSM (scene.bgsm_fields) or TX00
  diffuse, TX01 normal, TX07 _s; DODT colour tints; without the No Subtextures flag (0x08) the texture is a 2 x 2
  atlas and each reference shows one quarter.
- Box: centred on the reference, width along its X, depth along +Y (the projection direction), height along Z.
  Measured in Vault 111: decal references sit on their surface (median offset 0, quartiles +-0.15 depth), so a box
  reaching only forward would miss about a quarter of them. Checked visually: wall drips run downward, canopy
  stains project upward, floor decals down.
- Renderer: after the solid cell and landscape, the cell's depth is resolved; each decal box is drawn by its back
  faces, depth test GEQUAL; DECAL_FS (the lit body, LIGHTING_BODY) rebuilds the surface position from depth
  camera-relative (world coordinates of 100 000 made the reconstructed normal noisy: a white glare on puddles), the
  face normal from neighbours, decal normal map on top, AO applies. Surfaces turned away get nothing, edge-on ones
  fade. Alpha-tested surfaces and the character are drawn after the decals and take none. BGSM Multiplicative
  decals (DST_COLOR x ZERO, e.g. GrimeSubtle01) darken by their colour.
- Cost: about 0.3 ms GPU at 1080p in Vault 111.
- Open: DODT flag bits 0x20 / 0x40 and parallax decals (0x01) not handled; whether XPRM (a box on about 10 000
  decal references) overrides the size is unverified; one Sanctuary blood splatter floats 81 units above the road
  and shows nothing (depth 20). The game builds placed decals as geometry decals at load (executable strings); the
  screen-space projection here gives the same placement but flat face normals on curved surfaces.

## Shadows from placed lights (2026-10-07)

Cell viewer: the lights the game marks as shadow-casting (spot 0x400, hemisphere 0x800, omni 0x1000) cast shadows.
Camera & image > "shadows from placed lights" turns them off. The game's maths and the viewer's choices are in
engine-notes Section 23.
- **Server:**
  - esm_world._light adds `falloff` (cone exponent), `near` (near clip, XLIG override) and `shadow_bias` (XLIG,
    unused);
  - fo4paths.shadow_settings reads iShadowMapResolution, uiShadowFilter, flocalShadowMapHalveEveryXUnit and
    fShadowDistance from the user's INI files (`/api/status` light_shadows, main.js -> renderer.lsParams).
- **Renderer:**
  - updateLightShadows (each frame, before the scene) chooses up to LS_MAX = 8 lights nearest the camera (in view,
    within fShadowDistance). Each gets a run of layers in one DEPTH_COMPONENT16 array (LS_LAYERS = 48, 1024 per
    side): 6 cube faces, or 1 for a spotlight.
  - drawLightLayer draws a layer again when its key changes: cellVersion, plus the character's state when its sphere
    is in that face. Casters are the cell's solid and alpha-tested lit shapes within the light's reach (cached per
    cellVersion), the landscape, and the character.
  - LSHADOW_FS writes distance / radius as the depth and discards anything nearer than the near clip.
- **Light grid:** now 5 texels per light. The 5th holds the cone falloff exponent, "shadow spotlight" and the shadow
  slot. The LightShadows uniform block (binding 4) holds each slot's first layer, layer count, 1/radius and filter
  radius, plus each layer's light-relative view-projection.
- **Lookup:** LIGHTING_BODY, `#if LIGHT_SHADOWS`: the lit and decal programs, not the landscape (all 16 units are in
  use there). One face per pixel (major axis), then 4 taps (2 x 2) or 16 (4 x 4) depending on the filter radius, on
  sampler2DArrayShadow (unit LS_UNIT = 8, a 2D-array binding beside the landscape's 2D one).
- **Spotlights** (all of them) now use the game's cone formulas with the light's falloff exponent, instead of the
  earlier smoothstep over the outer tenth.
- **Cost:** about 0 to 3 ms at 1080p with 1 to 3 shadowed lights in view (Vault 111, Vault 75). Drawing all the maps
  of 3 lights again takes one ~17 ms frame. Memory: 96 MB once a shadow-casting light is in view.
- **Checked:**
  - Vault 111: chair, lamp-pole and character shadows from a placed omni light; the gear door's mechanism under its
    spotlight; no seams on the floor under the omni light, no acne.
  - Vault-Tec Regional HQ and Vault 75 load with no GL errors.
- **Open:**
  - the bias units of XLIG;
  - how many lights the game shadows at once;
  - the exact r of the shadow-spot cone;
  - hemisphere lights use a full cube.

## Light shafts (god rays) (2026-10-07)

Cell viewer, outdoors: the weather's god rays (GDRY). Camera & image > "light shafts (god rays)"; View > "light
shafts" shows them alone. Maths and calibration in engine-notes Section 24.
- **Data:** the weather sample already carried `god_rays` (blended GDRY fields). weather.js turns it into
  env.godRays (intensity, air / fwd / back = colour x scale, gF / gB = the phases).
- **Renderer.godRays** (after the main pass and refraction, before TAA):
  - the scene depth is resolved;
  - GODRAYS_FS marches into grA (half resolution, RGBA16F; alpha holds the ray's distance for the depth-aware
    filters);
  - GODRAYS_BLUR_FS blurs across and down;
  - GODRAYS_APPLY_FS adds the result to hdr (blend ONE, ONE).
- **Sun visibility:** a third sun shadow map (SHADOW_SIZE[2], unit 2 in the shafts program). The cell map covers only
  the view's middle (+-900 units at close range), so without the far map no building beyond it shaded the air.
- **grParams:** scale 8e-5 per unit (calibrated on NVIDIA's in-game Ultra / Off images), maxDist 20000, 32 steps.
- **Checked:**
  - Concord, Sanctuary (clear 08:30-17:00, foggy 11:00): the glow around the sun; buildings near the sun veiled;
    shaded near facades unchanged (as in the reference); mild haze away from the sun; none at night (None_Rays).
- **Open:**
  - the engine's own scale;
  - whether the scene behind the haze is attenuated in game;
  - spotlight and interior shafts (LIGH WGDR, CELL XGDR): **added the same day**.
- **Spotlight shafts:**
  - Server: esm_world._light returns `god_rays` (the light's GDRY fields + `near` from DATA +52); GDRY is now
    indexed (OTHER_TYPES).
  - world.js stores it as light.gr.
  - renderer.godRaySpots picks up to 4 in view, nearest first.
  - GODRAYS_FS marches each one's sphere segment (24 steps: attenuation, the §23 cone, lightShadow1 = one comparison
    in the light's map, the larger near clip).
  - spotGain 50 (calibration).
  - The spot-cone and light-shadow GLSL moved into LIGHT_FNS, shared by the lit shaders and the shafts.
  - Checked: Institute Advanced Systems (three ceiling cones; the character's shadow cuts one).
  - Open: Vault 111's door spot (blocked by the closed door, as designed); the Old Corner Bookstore's beams stop at
    window glass (its BGSM casts shadows).

## Game-matched camera (2026-10-07)

`lightboxDev.gameCamera({x, y, z, pitch, heading, fov = 80, eye = 120})` puts the orbit camera exactly where the
game's first-person camera is:
- x / y / z come from `player.getpos` (the feet), pitch from `getangle x` and heading from `getangle z`.
- The orbit target is 10 units ahead, with no pan.
- It also sets the FOV slider.

Measured against GameDriver shots in Sanctuary (engine-notes Section 25): within 0.5 px at 1600x900. Use it with
`R.fixedSize = [1600, 900]` (a 16:9 game window) for side-by-side or blink comparisons.

First result: the sun disc at 10:00 sits about 9 deg lower and 12 deg further south than the viewer's shadow-fitted
sun. Still open: whether the game's light follows the disc.

## Sun disc vs light (2026-10-08)

The game draws the visible sun disc on a different path than the light that casts shadows. Around noon the disc is
about 12 degrees higher; the measurements are in engine-notes Section 25.
- `weather.js` `sunDiscDirection(hour, rise, set, az)` interpolates the measured disc table (symmetric about solar
  noon, scaled to the climate's day length); past the horizon it keeps sinking, so no disc shows at night.
- `envFromWeather` sets `env.sunDiscDir`.
- The sky pass uses `env.sunDiscDir || env.sunDir` for the disc and its glare. Shading, shadows and light shafts
  keep `env.sunDir`.
- Check: on the 10-07 Sanctuary game shot (10:00) the disc lands within about 2 degrees.

## Particles (2026-10-08)

Simplified particle systems, in opened meshes and in cells (engine-notes Section 26). Camera & image >
"particles" (saved with the settings).
- **Server:** `fo4nif.py` parses NiParticleSystem, NiPSysData, the emitters and modifiers in PSYS_MODIFIERS and the
  controllers in PSYS_CTLRS (`_used` lets a checker compare bytes read with the block size). `scene.py`
  `scene_particles` turns each system into what the browser needs:
  - material, modifiers sorted by order, atlas frames, aspect;
  - controllers, with birth-rate channels taken from a controller sequence when the controller's own interpolators
    are blends;
  - mesh-emitter points sampled on the faces in NIF root space.
- **Browser:** `particles.js` `ParticleSim` holds the particles in typed arrays: update (birth, forces, age) and build
  (camera-facing quads: positions, flipbook uvs, colour bytes).
  - **Renderer:** `newPsys` makes a dynamic vertex buffer per system; `updateParticles` runs once per frame before
    culling.
  - **In a cell:** effects within PSYS_RANGE (5000) of the camera, the PSYS_MAX_CELL (40) nearest. A system coming
    into play is run ahead up to PSYS_WARM (3 s), and its cell object's own animation plays (fire barrel flames).
  - **Drawing:** the quads join the blended list.
  - **Material:** `fxMaterial` slot 31 marks particles for EFFECT_FS (palette rows from the vertex colour).
  - **TAA:** particles are reactive.
- **Checked:**
  - Every vanilla particle mesh builds without errors (1,657 systems).
  - Fire (small, medium, wall), the steam vent, floating dust, electrical sparks and the fire barrel were viewed.
  - Concord costs about 0.2 ms.
- **Open:** comparison with in-game frame sequences; wind; collisions (drip splashes); cell animation for effect
  objects without particles.

## Search boxes: no more silent failures (2026-10-08)

A Nexus report (stalkerVlad1, 1.0.0): "How do I add animations? The search window won't open." The clip search
worked, but it failed silently in three ways: an empty box opened nothing (it needs 2 letters, and said nothing); a
failed search showed nothing; and the list could open below the visible part of the sidebar. (Under Mod Organizer 2,
1.0.0 also reloaded the page every few seconds, wiping the box; fixed in 1.1.0.)
- Clicking or focusing the empty clip box shows a hint with examples (idle, walk, run, sneak, sit, reload, wave)
  that search with one click.
- A failed clip or mesh search says why in the list.
- The clip list scrolls into view whenever it opens or changes.

## Distant land, light shafts recalibrated, Vault 111 fixes (2026-10-08)

Found while matching a GameDriver shot at the Vault 111 platform for the Nexus comparison image (engine-notes
section 27, and section 24 for the calibration).
- **Distant land (LOD):**
  - `world.js loadLod` runs after a cell's models when the cell is an exterior with a worldspace.
  - It places the worldspace's terrain chunks (`.btr`, at the chunk corner) and object chunks (`.bto`, world space)
    as one-instance templates flagged `lod`: level-4 terrain to 12 cells, level-4 objects to 8, level-8 terrain to 32.
  - The server's `cut` parameter (`/api/nif?...&cut=x0,y0,x1,y1`, scene.py `build_scene(cut=...)`) drops triangles
    wholly inside the loaded cells (or the level-4 square), so nothing is drawn twice and no cracks open.
  - LOD batches cast no shadows and are not probed (stood on).
  - Camera & image > distant land (`settings.lod`) shows or hides them; an exterior opened with it off loads none.
  - Cost at Sanctuary: about 725k triangles, about 1 ms at 1080p.
- **Light shafts:**
  - GR_PARAMS now carries per-lobe shares (air 0, forward 0.3, back 0.15), the back lobe turned towards the sun
    (backSign -1) and lit air to 4000 units.
  - These come from a fit to the game's `gr on` / `gr off` difference in six views (GameDriver
    runs/20261008_122050_gr_ab_v111): RMS error 4 of 255, was 25.
  - Before, the air ahead of any view away from the sun turned white.
- **Particles:** emitters driven by controller sequences use the sequence an untouched object plays (the first
  idle / loop / default / special one, as the renderer), not any looping one. Oxygen tanks no longer spray: their
  `stage2loop` plays only once they are shot.
- **Vault 111's elevator:**
  - scene.py END_STATE_HIDDEN hides its `m_SkyDome`, which the intro's ride up switches off for good.
  - Open: the elevator platform shows lowered, and skeleton corpses stand in their bind pose (ragdoll data, XRGD).
- **Tools (dev only):**
  - The 8784 test page took the game frames through `/api/devsave`.
  - A SIFT + reprojection solve found the game's third-person camera: 117 units behind the player, 39 to the right,
    at eye height, FOV 70 (`fDefaultWorldFOV`); see the GameDriver README.

## The window title says what is open (2026-10-08)

In the launcher's window, Edge's title bar and Lightbox's menu bar both read "FO4 Lightbox". The Windows title bar
only takes plain text in the system font, so the styled logo stays in the menu bar (Bman prefers it; hiding it was
tried and taken back), and the title bar now says what is open instead (main.js `updateTitle`, called from
refreshModels, renderCellLayer and markPlace):
- the scene's models by file name (`vaulttecm.nif`, more than one: `vaulttecm.nif +1`), a plugin record by its
  in-game name (`Combat Armor Chest Piece`); the reference body is not counted;
- then the place or cell (`· Sanctuary`, `· Red Rocket`); the studio is left out;
- nothing open: `FO4 Lightbox`.
The same title shows in the taskbar preview and Alt+Tab, which tells two Lightbox windows apart. A merged title bar
(WebView2 or Window Controls Overlay) was considered and dropped: too much work for a cosmetic gain.

## Ambient occlusion at the game's strength (2026-10-08)

Bman's report: with AO on, the ARC backpack's fan glow went dark, much darker than in game. A matched in-game A/B
(GameDriver; engine-notes §21, Calibration) showed the game's SAO darkens about half as much as the viewer did, on the
glow and on ordinary surfaces alike. renderer AO_GAIN = 0.5 scales the INI intensity; the pack housing, a pillar base
and rubble now match the game within 0.01. Measured in one scene only.

2026-10-09, reported from the ARC session: a fine screen-door pattern on the reactor glow deep in the fan, gone with
AO off. The game's blur takes every second texel, so odd and even texels were never averaged together (the game's
history buffer does that, the viewer has none). SAO_BLUR_FS now spreads the game's kernel over the texels in between
(engine-notes §21); the fine pattern's strength fell by about 70 % with the mean darkness unchanged. Emission darkened
by AO is the game's behaviour (§21: the composite multiplies the whole lit colour, measured on this very fan).

## Plain backgrounds: NifSkope black, Outfit Studio grey (2026-10-08)

Bman: a background like NifSkope's black or Outfit Studio's grey, picked in the World panel (two slim buttons either
side of the places), with NifSkope's grid and a toggle for it.
- **Colours, read from this PC's tools:** NifSkope 2.0 Dev 7 Settings/Render/Colors/Background (registry) is 0 0 0;
  Outfit Studio, the BodySlide install Bman's shortcut opens, Config.xml ColorBackground is 149 149 149 (the newer
  BodySlide3 install has 210).
- **Grid and axes, measured on NifSkope's own window:**
  - Lines every 128 units at white 0.2 (display 51 on black), one line between each pair at white 0.1 (25).
  - The grid is 1024 units out from the centre.
  - X / Y / Z axes in red / green / blue in a corner box min(width / 10, 125) px.
- **How:**
  - The Studio scene is drawn as usual, so exposure and light stay its own, but the sky and the floor leave the HDR
    target's alpha at 0. Every blend keeps "over" coverage in alpha (setBlend: blendFuncSeparate ... ONE,
    ONE_MINUS_SRC_ALPHA).
  - TONEMAP_FS puts the backdrop (plus the grid, ray to the floor plane, fwidth lines) where the resolved alpha is 0.
    Edge pixels have the sky / floor behind them taken out (the mean of nearby background pixels) and are mixed into
    the backdrop by their coverage.
  - The axes are drawn last, in the bottom-left box. Exact values checked: 0 0 0, 149 149 149, grid line 51; also
    under TAA (coverage from the frame's own resolve).
- **Notes:**
  - The floor (and so the character's shadow on it) is hidden, as in NifSkope.
  - The view info moves right while the axes show.
  - The models keep Lightbox's lighting, not NifSkope's.
- Settings: world.backdrop / world.grid; opening a place or a cell clears the backdrop.

## Transform gizmo, and the camera on outfit changes (2026-10-08)

- **Camera:** choosing another body or outfit kept reframing the camera (setReference called frameCamera('three')
  every time). It now frames only when a reference body appears where there was none, outside a cell, with no model
  open.
- **Gizmo** (web/js/gizmo.js), after Outfit Studio's, at Bman's request:
  - Arrows move along an axis; rings turn about it; a cube on each axis stretches along it; the black middle cube
    scales evenly. Ctrl snaps to 1 unit, 15 degrees and 5 %.
  - It shows on the selected model (click), in the character's own axes (X red, Y green, Z blue).
  - Selecting any part of the reference body moves the whole body.
  - It is drawn on a 2D canvas over the view (#gizmo, no pointer events). Handles are hit-tested in screen space:
    cubes, arrow heads, rings, then the arrow shafts.
  - Drags follow the mouse ray: the closest point on the axis line, or the angle in the ring's plane; a ring seen
    edge on turns by the sideways mouse motion.
- **The transform:** renderer.setModelXform(model, xf) keeps xf = {t, r, s, c} and model.xform =
  T(c + t) R S T(-c) in character space. playerWorld() applies it, so drawing, shadows, picking, the selection outline,
  blended sorting and the model's particles all follow.
  - View only: nothing is written to the NIF.
  - The Scene row's ↺ button clears it; the HUD's selection line shows it; a live reload keeps it.

## Optimization pass and quality tiers (2026-10-09)

Bman asked for a full optimization pass with "ideally zero visual quality difference", mainly for performance:
"make sure it runs decently on all pcs".

### Method
The pass was built in a git copy (`Documents\Fallout4_Mod_Projects\NifViewer_Opt`, not shipped).
- A regression harness (`harness/lbx.py`, README there) renders 42 deterministic shots covering every feature:
  - AO and the ARC fan cavity;
  - backdrops and the grid;
  - the gizmo;
  - cloth;
  - god rays, distant LOD, particles and placed-light shadows;
  - interiors with decals;
  - game mode.
- It also runs sequence checks: toggles off and on, hour round trips, place A → B → A, gizmo moves and resets, and
  resizes must all give back the reference picture.
- Shots are taken at 1280 × 720. The time, particles and template order are pinned by an injected script, never by
  the app.
- Runs of the same code differ only in a few dozen pixels by 1/255 (depth-texture reads round differently between
  presented frames: ANGLE / D3D11). The harness keeps the per-pixel minimum of 8 grabs and a measured noise floor.
- Six packages were each built on their own branch. Every commit had to pass the pixel diff. They were merged in this
  order: server, load-client, shader-alu, shadow-caches, static-view-reuse, idle-fastpath.
- Result on a strong GPU (the RTX 3080 Ti): pixel-identical except in 2 of 42 shots. There, ≤ 0.009 % of pixels
  differ by 1/255 and one anti-aliased edge pixel by 5/255. This is the same class of rounding the noise floor
  describes; it moves between runs and is invisible.

### Bit-exact speed-ups (same pictures, less work)
- **Server:** the same answers, byte for byte, from much less work:
  - file opens per cell went from thousands (nearly all failing loose-override probes) to 1-28;
  - cell answers are 3-5x faster (Sanctuary 1.6 s → 0.6 s);
  - mesh search while typing went from about 0.13 s to under 8 ms;
  - the version poll is 89 → 19 ms;
  - concurrent misses of one scene build it once;
  - small archived files are cached per BA2.
  - Fixes:
    - stale scenes after a source switch;
    - dependency tags taken at read time;
    - browser-cached files kept across a restart;
    - the static path check;
    - listings held under the global lock.
- **Loading (client):**
  - base64 decoded natively;
  - weather samples applied in order;
  - place lookups and the last 3 cell answers memoised;
  - distant LOD starts with the last model requests;
  - shader programs finished on first use;
  - unused textures evicted (sweepTextures, budget per quality tier);
  - races fixed (reference body, worn items, clips).
  - Leaks fixed: whole-twin particles, compare object URLs, stale LOD templates and the probe grid.
- **Shadows:**
  - distant LOD and non-caster placements no longer redraw the sun maps or light layers;
  - new casters are drawn into the existing maps (LEQUAL depth composition: the same nearest depth in any order);
  - light layers that include the character start from a pooled copy of their static casters;
  - parked light layers are kept in an LRU;
  - cube lights get 6-aligned layer groups (no all-layer resets);
  - the far map draws only casters within the shafts' reach;
  - the cell and far maps are made on first use.
- **Static view:**
  - the cell's culled and sorted draw lists are reused while the view stays;
  - the cell's AO depth pre-pass is cached and only the character is redrawn on a copy;
  - the SAO blur reads the occlusion pass's linear depth (MRT) and skips open sky;
  - redundant instance-pointer setup is skipped;
  - the Frame UBO is filled with bufferSubData.
- **Shaders:**
  - the light loop skips facing-away and zero-attenuation lights before their pows and shadow taps;
  - multiplicative decals return before lighting;
  - sun PCF runs only where the sun adds light;
  - spot shafts test the cone first;
  - the shafts reuse the blended pass's depth resolve.
- **Idle:**
  - frames during the eye-adaptation tail run only adapt + tonemap;
  - the gizmo overlay is repainted only when it changes;
  - bone palettes are rebuilt only when their inputs change;
  - pose sampling makes no temporaries;
  - game-mode depth probes reuse a box's depth while the cell is unchanged.

### Quality tiers (web/js/quality.js)
Measured weak-PC problems (WARP, the Microsoft Basic Render Driver, standing in for a very slow GPU):
- video memory first: Sanctuary held 1.55 GB of textures, and nothing was ever freed;
- the idle clip drawing full-resolution frames for ever;
- dynamic resolution that never engaged below 8 fps;
- seconds of input lag from frames queued behind the GPU;
- screenshots whose single frame took longer than Windows' GPU reset limit (TDR, about 2 s);
- no recovery from a context loss.

The tiers:
- **Ultra** is the renderer exactly as before: every knob holds the old value. High, Medium and Low trade detail:
  - texture cap at upload: none / 1024 / 512;
  - unused-texture budget;
  - device-pixel-ratio cap;
  - MSAA 4 / 2 / off;
  - SAO samples, shaft steps and shadowed lights;
  - a frame cap while only an animation moves (60 / 30 / 30);
  - a render scale while anything moves, full again when still;
  - an output scale for the whole picture (0.85 / 0.7);
  - frames queued to the GPU.
- **Auto:** the tier comes from the GPU's name (classify). The governor then steps down one tier when the median GPU
  frame time stays over the tier's budget for 4 s; frames while a place loads don't count. It never steps up; a reload
  starts again from the name.
  - A GeForce RTX / Radeon RX 5700-class GPU is Ultra, so a strong PC is unchanged. The 3080 Ti harness at Auto passes.
- **Every tier:**
  - frames in flight are limited with fences (WARP input lag 1.6 s → 0.1-0.2 s);
  - a GPU reset reloads the page with the scene put back (Auto: one tier lower for the session);
  - a screenshot's scale is lowered when its single frame would exceed the renderbuffer limit or the tier's pixel
    budget.
- Measured on WARP (Studio, idle clip playing, 1580 × 1053): Ultra 5.6 fps, Medium 9.0, Low 13.4.
- Sanctuary's textures, measured: Ultra 1,551 MB, Medium 1,010 MB, Low 431 MB.
- View > Quality chooses by hand; the HUD names the tier when it is not Ultra.

## Even light (2026-10-10)

Bman asked for "full" even lighting like Outfit Studio or NifSkope as an option. The bulb button in the World
panel's cell-radius row sets settings.evenLight: renderer.env then returns evenEnv() in place of the weather's env
(which is kept and comes back unchanged). evenEnv: one white light from the camera, a little above it (its direction
set each frame from the eye), the same grey ambient on all six ambient rows, no shadows (noShadows), no AO, no light
shafts (no godRays), no fog, LUTs or tint, and a fixed exposure (aeMin = aeMax). Materials draw as always. It works on
its own or with the black / grey backdrops; in cells the placed lights still add their light. Saved with the World
settings (world.evenLight).

## Open with: .nif files from Explorer (2026-10-10)

FO4 Lightbox.exe takes a .nif path (a double-click, Windows' Open with). The launcher hands it to the server
(/api/open) and, when a page asked lately (/api/opens, about once a second, with its title), restores and brings
that window to the front by its title (Edge / Chrome app windows carry the page title) instead of opening a second
one; otherwise it starts the viewer as usual and the new page takes the file once started (items of the last 2
minutes). The page puts the file in place of the loaded models (the body and what it wears stay):
- a file the game sees at its own game path (loose in Data or in a Mod Organizer 2 mod: open_target checks that
  the VFS resolves that path to this very file) opens by that path, with its materials and textures;
- any other file (an export folder) is read like a dropped file (/api/openfile), textures from the game.
File > Open .nif files with Lightbox (open_with) adds or removes HKCU\Software\Classes entries: the ProgID
FO4Lightbox.nif, .nif\OpenWithProgids and Applications\FO4 Lightbox.exe (this user, no admin). Windows leaves
the default app to the user (Open with > Always use this app).

## Right-click menu, and a server that survives sleep (2026-10-10)

- A right click on the view (no drag: a right drag still pans) selects like a left click, then main.js
  openCtxMenu offers Hide .nif and Delete .nif for the selected model (Hide body / Delete body for any part of the
  reference body, as its Scene row does). Delete takes the model out of the scene only. #ctxMenu reuses .mdrop.
- Bman saw "127.0.0.1 refused to connect" now and then. The server stops itself when no page has asked for 180 s
  (--exit-when-idle); after the PC slept, the first check after waking counted the sleep and stopped it before the
  page could ask, and the launcher took that stop as the end. Now exit_when_idle does not count time this thread
  spent far past its tick (the PC was asleep), and the launcher starts the server again on the same port while its
  window is open (up to 5 times): the page sees a new boot, reloads and puts the scene back.

## Single shapes (2026-10-10)

- Alt+click (left or right) selects the one shape under the cursor: renderer.pick reports the shape it hit, the
  selection is {kind: 'shape', model, shape}, selectionDraws outlines that shape alone, the HUD names it
  (file › shape), the right-click menu adds Hide shape. The gizmo stays for whole models (it moves files, not
  shapes). A plain click selects the whole .nif again.
- The Scene list: a ▸ before each .nif row opens small rows for its shapes (an eye each, the triangle count; a
  click on the name selects the shape). An Alt+clicked shape opens its .nif's rows and lights its own.
- Showing or hiding a shape bumps geomVersion as well as version, so the character's shadow maps follow.

## Menu, outline and panel touches (2026-10-10)

- The right-click menu has Reset (as the Scene row's ↺; greyed out unless the model was moved, turned or scaled).
- An Alt+clicked shape: its .nif keeps the usual outline, the shape is drawn last in a lighter, stronger green
  (selectionDraws marks it hi).
- The browser's own right-click menu is off everywhere but text fields.
- The side panel's contents need 300 px (measured: below it slider values were cut off). Narrower, down to 140 px,
  #side gets CSS zoom = width / 300, so everything shrinks instead; dragged past 115 px (the splitter lights up)
  it closes, keeping its last width for #showSide.
- Second round (Bman): the fit counts the panel's scrollbar (sideZoom: width < 300 + scrollbar + 4), so nothing is cut
  off with a scrollbar showing. The narrowest is no longer fixed: on each drag the panel measures, at full size, the
  zoom at which every open section fits its height exactly (clientHeight / scrollHeight); it shrinks to that and
  no further, and a few pixels past it the panel dims with "Let go to hide the panel" and the splitter glows. The
  "Panels" button became a slim see-through tab with » at the view's edge. The game-hour clock lost its LCD box:
  Pip-Boy green type, a shade darker, a thin dark outline.

## Collision and physics (2026-10-11, for 1.2.0)

Bman: "do the collision and physics". Lightbox now reads each model's own Havok collision and simulates it.

- **Server**: `server/collision.py` reads the bhkPhysicsSystem behind every bhkNPCollisionObject (hk_2014 packfiles,
  through `havok.Packfile`) into plain shapes in the NIF's space and game units: convex hulls with their rounding
  radius (hknpConvexPolytopeShape / ConvexShape / CapsuleShape / SphereShape, also inside hknpScaledConvexShape) and
  triangle meshes (hknpCompressedMeshShape: quantised sections, 11-11-10 packed and 21-21-22 shared vertices, quads),
  through hknpStaticCompoundShape / hknpDynamicCompoundShape instances (rotation, translation, scale), with each
  body's motion (static / keyframed / dynamic), mass, friction, restitution and collision layer. `GET /api/collision?
  path=...[&placed=1]` (cached like scenes; placed: the root's own transform left out, as build_scene), `POST
  /api/collision` for dropped files. Offsets follow PyNifly's documented layouts; the compound instance scale and the
  scaled convex shape were read off vanilla SCOL meshes.
- **Where the shapes sit**: in the space of the node that holds the collision object. The body's own position and
  orientation in the packfile are NOT used: vanilla files carry a copy of the node's transform there, a centre, or
  nothing, and applying them moved or turned 14-20 % of the meshes twice. `tools/collision_check.py` (all vanilla
  meshes but precombined / LOD) checks every file decodes, every shape class is read, and the collision box against
  the render box. All 37,275 vanilla meshes: 26,003 carry collision, every one decodes (0 errors, no shape class left
  unread, 4.9 million triangles, 62 s); 97.5 % sit within a quarter of the model's size; the rest are real data (water planes, slab collision
  under flat sidewalks, workshop items' placement boxes, one Red Rocket wall plug whose hull is flipped in the file).
- **Engine**: Rapier 0.20.0 (`web/vendor/rapier/rapier.mjs`, Apache-2.0, the WebAssembly inlined: nothing is fetched;
  provenance in its README), loaded on first use by `web/js/physics.js`, simulating in Havok units (metres), Z up.
  - Static: the cell's landscape (one triangle mesh per cell from the LAND heights) and every placed reference's
    solid bodies as fixed bodies, nearest the character first (Sanctuary 3 x 3: 646 models, 3,222 shapes in 1.1 s;
    Vault 111 cryo: 261 models, 1,755 shapes in 0.85 s; a step costs well under 0.1 ms). Outside a cell, the Studio
    floor. Non-solid layers (water, triggers, zones, camera / pick layers, navmesh cuts) are left out.
  - Game mode (game.js `updatePhysics`): a 0.3 m x 1.8 m capsule moved by Rapier's character controller (50 degree
    slopes, 0.55 m steps, ground snapping off while airborne, pushes dropped items); the camera's wall check is a
    ray. Until the engine is loaded the old depth probes still work.
  - Items: right-click a model > Drop with physics (it falls from where it is), in game mode F throws the main model.
    The file's dynamic bodies with their mass, friction and restitution; a model without one falls as its hulls; a
    moving triangle mesh becomes its hull. The body drives the model's view transform (as the gizmo's: Reset puts
    it back, a gizmo move or Delete ends it); another place sends dropped items back.
  - The collision view (the cube button by the bulb): the cell's shapes near the view's centre in blue, the loaded
    models' own in green (they block nothing), dropped items in orange, the character's capsule; lines behind
    surfaces faint (renderer `drawCollision`, after TAA like the selection outline).
- Not yet: the cell's own clutter stays put (it is static here; moving it means moving instances), ragdolls and
  constraints are not read. (Doors: see "Doors in game mode".)

## Doors in game mode (2026-10-13)

Bman: "do ONLY doors". E in game mode works the door in reach in front of the character (the HUD shows "[E] open /
close / go through" and its EditorID). The game's DOOR records also cover display cases and levers.
- **Server:** esm_world reads XTEL on references (the destination door, and where the player appears). Placed DOOR
  items carry `door`, and load doors carry `tel` {ref, pos, rot}. `/api/door?ref=&pos=` finds the destination door's cell
  (persistent children first, kept); for an exterior it returns the grid cell under `pos`.
- **Ordinary doors:** a copy of the door model (`role: 'door'`, `fixedWorld` = the reference's matrix, renderer
  playerWorld) plays the NIF's Open / Close sequence while the placed instance is hidden
  (`renderer.hideInstance`: an impossible cull radius, flat copies and shadow maps redone). Only the collision of the
  parts the Open sequence moves (its channel nodes and everything under them) lets go
  (`physics.setRefSolid(ref, on, nodes)`), so frames and thresholds stay solid; turning off everything dropped the
  character through Vault 111's door threshold. Copies go when the cell changes.
- **Load doors:** the character stands at the XTEL spot at once, facing its way (`-rot z`, as COC markers), with game
  mode held (`game.frozen`) while the destination cell loads; then it is grounded again.
- **Checked** (Vault 111 cryo):
  - V111Door01b blocks when closed, lets the character through when open and keeps the threshold floor (walked
    through on z 0).
  - The elevator's autoload door leads to Vault111Ext, landing exactly on its marker.


## Explorer thumbnails (2026-10-16, for 1.3.0)

Bman: "thumbnails display a preview of the model in explorer". Three parts:
- **The add-on** (`launcher/thumbs/LightboxThumbs.cs`, built by `tools/build_release.py` into the main zip's
  `thumbs/LightboxThumbs.dll`, or by `launcher/thumbs/build.ps1` into `launcher/thumbs/build/` for a source copy): a
  .NET Framework COM class (IInitializeWithStream + IThumbnailProvider) in Windows' thumbnail process. It reads the
  file's bytes, posts them to the thumbnail service (`/api/thumb?size=&name=`) and turns the PNG into a 32-bit DIB with
  straight alpha (WTSAT_ARGB). It finds the service by `%LOCALAPPDATA%\FO4 Lightbox\thumbs.port` ("port pid"); when
  none answers it starts one (one start at a time: a named mutex; after a failed start, none for a minute) with the
  Python and app.py named in `HKCU\Software\FO4 Lightbox` (ThumbsPython, ThumbsApp). Through ShellExecute, so the
  service inherits none of the caller's handles (a console pipe kept the test harness waiting).
- **The service** (`app.py --thumbs`, `server/thumbsvc.py`): no console (output to `thumbs.log`), a free port, no
  weather or cell index. It joins a kill-on-close job object, so the headless Edge / Chrome it starts and all of that
  browser's processes end with it however it ends. `/api/thumb` builds the scene and queues a job; the page takes
  jobs by long poll (`/api/thumbjob`, `/api/thumbscene`) and answers `/api/thumbdone` (PNG, or an error, plus a note
  with the bounds and view for the log). It stops after 300 s without a thumbnail asked for (the page's polls don't
  count). The browser's first process hands over and exits, so the browser counts as alive while its page has polled
  in the last 45 s; a new start gets its own profile folder (a hung one would take the page over).
- **The page** (`web/thumb.html`, `web/js/thumbpage.js`): the viewer's Renderer on a detached canvas with the
  reference buttons' studio light (key light from the camera's upper left), no TAA, floor, sky or bloom, fixed
  exposure. The view: three-quarter front from above (FO4 meshes face +Y); a skinned piece behind the body above the
  hips (a backpack: bounds centre y < -5, lowest z > 40) from behind; long along Y (weapons) from the side; tall ones
  nearly level, flat ones from higher up. The camera fits the bounding box's corners in the square (94 %) and centres
  their projection. Transparency: two pictures, on a black and on a white backdrop (the tonemap lays the backdrop
  behind the models by their coverage, so the second is a tonemap pass only); coverage a = 1 - (white - black), colour
  = black / a: exact at edges, glass and hair cards. 2x supersampled up to 512 px, then a box filter on the
  premultiplied values. Prn pieces are drawn where their file puts them.
- **The side** (added 2026-10-18; `betterSide` in thumbpage.js). Many props face -Y, not +Y. Examples: the mailbox,
  the Nuka-Cola machine, the prewar radio, the teddy bear, and every display piece of the backpack rack
  (meshes\Clothes\Backpacks\BackpackDisplay\Displays).
  - When the rule isn't sure (anything but worn pieces and weapons), the view and the same view from the opposite side
    are drawn at 192 px and box-filtered to 96.
  - The side with clearly more surface detail wins: at least 1.2x the mean brightness change between neighbouring
    pixels of the model, and the model may not cover less than 0.8x as much.
  - Measured on 30 rack displays, 41 ground models and 20 vanilla props with a known front. It turned 17 displays,
    the teddy, the Nuka-Cola machine, both radios, the worn ARC and 15 ground models round, all for the better or
    the same. Nothing with a +Y front turned. 13 displays stay as they were (too close to call).
  - It adds about 30 ms per thumbnail (99 files in 8.2 s).
  - Tried and dropped the same day: choosing the angle that fills the most of the square. It picked flat, head-on
    views (the pistol muzzle-on, the rack end-on) and lost the three-quarter depth.
  - Tests: `/api/thumb?view=yaw,pitch` fixes the view, skipping the rule and the side test.
- **The switch** (`server/thumbreg.py`, File > Show .nif thumbnails in Explorer, `/api/thumbs`): the add-on has to be
  registered machine-wide (HKLM): the thumbnail process ignores per-user COM classes (REGDB_E_CLASSNOTREG, found with
  Bman's DdsThumbs). So the viewer runs thumbreg.py elevated (one UAC prompt: python.exe, signed by the PSF) and reads
  the result it writes. It copies the DLL to `Program Files\FO4 Lightbox Thumbnails\LightboxThumbs.<sha>.dll` (Explorer
  keeps it loaded: a copy in the viewer's folder would block a mod manager's update; a new build gets a new name, so
  an update never overwrites a loaded file) and registers CLSID {04c52f43-6c03-495c-ad2e-75f1d570b40a} (mscoree,
  CodeBase unescaped, both registry views) under `.nif\ShellEx` and `SystemFileAssociations\.nif\ShellEx`. A handler
  that was there before is kept in the CLSID key and put back when switched off. Each start of the viewer refreshes
  the HKCU paths while thumbnails are on, so the copy that ran last is the one the add-on starts.
- **Measured** (this PC, 256 px): first thumbnail 2.2-2.9 s (service, browser and page start), then 40-240 ms each.
  Particle-only effects, skeletons and other files without shapes get Explorer's usual icon (422).

## Tools never leave browsers behind (2026-10-16)

54 orphaned headless Edge browsers (about 4.9 GB) were found, left by capture and test runs. They leaked for two
reasons:
- Edge relaunches itself into a new process, so stopping the PID that was started misses the real browser.
- A tool stopped mid-run never reaches its clean-up.

`server/procjob.py` `end_with_me()` puts the calling process in a kill-on-close job object: everything it starts
afterwards ends with it, however it ends. The thumbnail service, `tools/capture.py` and `launcher/make_splash.py`
call it at start.

The harness, the Nexus page tools and the website shots (outside this folder) start their browsers through
`Fallout4_Mod_Projects/Tools/ProcKeeper/keep.py` instead, and a sweep catches any orphan that slips through. Details
are in that folder's README.

## Even light = the editors' look (2026-10-19)

Bman: Even light looked grey and desaturated next to Outfit Studio, especially the Vault suit's yellow. Even light
only swapped the light; the colours still went through the game's camera chain:
- linear-space lighting;
- the filmic curve at exposure 1.8;
- bloom;
- sky reflections on shiny parts.

What changed:
- **Outfit Studio's rendering, as read from its shaders.** `res/shaders/fo4_default.frag` and `.vert` in BodySlide,
  with the light settings in its Config.xml.
  - Everything is in gamma space: the texture's stored values, no decoding.
  - Five lights: ambient 0.2, a frontal light 0.2 along the view, and directional lights of 0.6 from the front left,
    0.6 from the front right and 0.85 from behind. The directional ones are fixed around the model.
  - Per light: Oren-Nayar diffuse with interreflection. The roughness is 1 - smoothness where there is a specular
    map; Lambert without.
  - Per light: a normalised-Phong specular with Schlick Fresnel (F0 0.2), plus a grazing ambient sheen.
  - The cube map is scaled by each light.
  - Finally Hable's filmic curve, divided by its value at 1 so white stays white.
  - No exposure, bloom, grading or LUT.
- **Lightbox's version** (written fresh in shaders.js: `editorLook`, `edLight`, `edDiffuse`, `srgbEncode`). When Even
  light is on (`uClusterI.w` > 0.5), the lit shaders (meshes, cell batches, decals; the landscape without the cube
  map) use it instead of the game formulas.
  - The texture's stored value comes back from the GPU's sRGB decode exactly (`srgbEncode`).
  - The sum is written back as linear (^2.2). TONEMAP_FS (`uEditor`) turns it into gamma again and applies the
    editor's curve, so effects and the sky pass the same way, without exposure.
  - The rig turns with the character: `uClusterI.w` = 1 + the player heading. The editor lights a model that faces
    it; Lightbox turns the character (the Studio faces him toward the sun).
- **Measured** against Bman's Outfit Studio screenshot (Vault 111 suit, front, the same grey background), medians:

  | | Blue | Yellow | Yellow, brightest 10 % |
  | --- | --- | --- | --- |
  | Lightbox | 82, 101, 134 | 197, 167, 93 | 244, 214, 119 |
  | Outfit Studio | 82, 100, 132 | 190, 170, 89 | 233, 208, 116 |
  | Old Even light | | too grey to count as yellow | |

- **Regression:** the full 42-shot harness run (`ed_before` from the 1.3.0 build, `ed_after` live) shows every shot
  within 1/255. None of them uses Even light, so the game look is untouched.
- **Not mimicked:** Outfit Studio's material specular colour (Lightbox doesn't pass it) and its environment mask
  texture (Lightbox uses the specular map instead, which is the editor's own fallback). The skin tint stays (the
  editor shows raw skin textures).

## 1.3.1 (2026-10-25)

- **The launcher kept the server under an open window.** `launcher/Launcher.cs` used to stop the server as soon as
  the Edge process it started exited. Edge hands its window to another process of its own and exits at once on a
  fresh profile (a first start) and when it already runs on the profile: the page then hung on "Loading reference…"
  (MONSTERaider's 1.3.0 report). Reproduced in a scratch profile with the 1.3.0 logic: the server was gone a minute
  after a first start, window still open. Now "the window is open" = that process alive, or a visible app window of
  any Edge / Chrome process whose command line names the viewer's profile (WMI, `ProfilePids`); ordinary browser
  windows (" - Microsoft Edge") don't count. The server stops 8 s after the last one closes. Tested: first start on
  a fresh profile, a start with Edge already running on the profile, a normal start; each kept the server up for
  the minute the window was open and stopped it 8-9 s after the close. Found by the Darkroom session.
  - The launcher reads `%LOCALAPPDATA%` from the environment (the server does too), so a test can point both at a
    scratch folder.
- **Browser cache capped at 512 MB** (`--disk-cache-size`); the 1.3.0 report had 5 GB. Edge trims a bigger cache
  at start (tested: 186 MB to 5 MB with a 20 MB cap).
- **Colour remapping (MODC), lighting templates, LIGH shading switches:** engine-notes Section 28.
- **Mesh search names every placeable** (`esm_world.model_names`, NAMED_TYPES): furniture, containers, doors,
  activators, weapons, misc items, terminals... by their FULL name; built with the first search (0.4 s).
- **Cell search source chips** (`pluginChip` in main.js): official add-ons by their store names on a blue chip
  (Automatron, Far Harbor, Nuka-World, the workshops, Creation Club), mods amber, Fallout4.esm grey.
- **More folder words for the search tags** (`pathtags.js` WORDS, from Darkroom: the 80 most common unsplit folder
  names across 41k placeable bases), e.g. "Light | Fixtures", "Modern | Domestic".
- **Interiors seen from outside:** the surround is near-black (`env.voidColor`, drawn after the tonemap like a
  plain backdrop, without the grid). Making the sky black instead let the eye adaptation brighten the room.
- **Hover tip in cells:** the mouse resting 110 ms on a placed object names it (EditorID · type · FormID, file).
  The pick reads back from the GPU, so it never runs per move.
- **Placed armour draws** (`esm_world._expand`): an ARMO's MODL entries are the 4-byte ARMA FormIDs of its addon
  list, so a placed armour (BotC's A.R.C. in Sigma's display case) was dropped. Its world model is MOD2, else MOD4,
  with MO2S / MO4S as its material swaps. Reported by the Location - Bunker session.
- Regression (42 shots) against the build before these: only the interior shots differ, in a few pixels of void.
