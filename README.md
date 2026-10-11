# FO4 Lightbox (Nif Viewer)

See a mesh the way Fallout 4 renders it, without loading the game.

Lightbox reads your own Fallout 4 install and draws a NIF with the game's materials, weather, time of day,
imagespace and lighting maths. Open any mesh, wear it, drop it into a real cell and walk around in it.

Version 1.1.0 · Windows 10 / 11 · GPL-3.0 · no F4SE · nothing goes into your game folder

## Run it

1. Extract the zip anywhere outside `Data`, for example `Documents\FO4 Lightbox`.
2. Double-click **FO4 Lightbox.exe**. It finds Fallout 4, starts the viewer in the background and opens it in its own
   window. Close the window to quit.
3. Type in the Scene search (`backpack`, `combat armor`), click a result, or drop any `.nif` onto the view.

- **Python is included** (`runtime\`: Python 3.14 + numpy). Nothing to install.
- **"Windows protected your PC"?** The launcher is new and not code-signed yet, so Windows SmartScreen may warn the
  first time. Click **More info**, then **Run anyway**. Its source is `launcher\Launcher.cs`; every executable file
  is listed with its checksum in `runtime\BINARIES.txt`. `Start Lightbox.bat` starts the same viewer without it.
- **Game not found?** It asks for your Fallout 4 folder once and remembers it. To pick another install later, start
  `FO4 Lightbox.exe --choose-game`.
- **Window:** Edge or Chrome in app mode (WebGL2). Without either, it opens your default browser; Firefox is
  untested.
- **Game versions:** reads both the 1.10.163 archives and the next-gen ones.
- **Mod Organizer 2:** found by itself. Lightbox reads your MO2 profile straight from MO2's own files: the game's
  Data with the profile's enabled mods laid over it in priority order, Overwrite on top, the profile's plugin list
  and INI files. MO2 doesn't need to be running and nothing of it is changed. The **Mods** menu switches between the
  game folder and each MO2 profile; your choice is kept. A portable MO2 that isn't found can be added there
  (**Add a Mod Organizer 2 folder…**), or started with `--mo2 "D:\Modding\MO2"`. Running Lightbox from MO2's
  executables list also works: it then opens the profile MO2 has selected.
- **Vortex** deploys into `Data`, so the game folder already shows your mods.
- Starting it twice opens another window on the running viewer. Only this PC can connect to it.

## Features

**Looks like the game**
- Weather, sun, ambient light, fog and imagespace come from your load order, for any hour of the day.
- Lighting, specular, reflections, tonemap, bloom, eye adaptation and colour LUTs follow the game's own maths.
- Ambient occlusion as the game draws it (its SAO, with the settings from your own Fallout4.ini): objects sit on the
  floor and on the body, corners and gaps darken (Camera & image > ambient occlusion).
- Cell viewer: the decals placed in a cell (grime, blood, scorch marks, puddles, paint) lie on the walls and floors,
  and the lights the game marks as shadow-casting cast shadows, with the shadow quality of your own Fallout4Prefs.ini
  (Camera & image > projected decals, shadows from placed lights).
- Light shafts (god rays) outdoors, from your weather and hour: the glow around the sun, haze over sunlit air and
  shafts where buildings and trees shade it (Camera & image > light shafts).
- Distant land: the worldspace's terrain and object LOD past the loaded cells (hills, tree lines, far buildings), as
  the game draws it beyond its loaded area (Camera & image > distant land).
- Particles: fire, smoke, steam, sparks, embers, drips and dust, from each effect's own emitters, flipbooks and colour
  and size curves, in opened meshes and in cells (the nearest effects to the camera). A simplified simulation, close
  to the game rather than identical (Camera & image > particles).
- BGSM / BGEM materials with every texture slot, glow, alpha, two-sided, greyscale palettes and skin tint.
- Textures go to the GPU in their original compressed format.
- Checked against in-game frames taken at a known spot, hour and camera: clear noon is within 0.1 EV of the game,
  and the light shafts within a few levels (of 255) in six directions.

**Models**
- Any NIF from loose files or BA2 archives, in the game's load order, or a file dropped from anywhere.
- Search by file name or by the in-game name of armour and clothing.
- Reference bodies: male or female, bare or in the Vault 111 suit, Road Leathers or Radstag Hide.
  A loose CBBE body is detected and can be switched on.
- Worn items hang where the game hangs them (skin weights or the `Prn` bone).
- Animated shader controllers and NIF sequences play (glow pulses, flicker, moving parts).
- Transform gizmo, after Outfit Studio's: click a model to select it, then drag an arrow to move it, a ring to turn
  it, a coloured cube to stretch it along that axis or the black cube to scale it (Ctrl snaps). Selecting the
  reference body moves the whole body. View only: the NIF is not changed; the Scene list's ↺ button undoes it.
- Cloth physics (experimental, off by default: Animation > cloth physics): coats, skirts, dangling pouches and
  keychains swing with the body. The game's own cloth data (Havok cloth in the NIF) is run by Lightbox's own solver;
  walk, run and sprint poses move the cloth as if the character were really travelling. Off, the cloth follows the
  body as in the game's Animate state.
- Shapes & materials panel: shader flags, material values and every texture with its size and format.

**Animation**
- Every HKX clip in your install: search it, play it, pause it, change its speed.
- One-click poses: bind pose, relaxed idle, walk, jog, run, sprint.

**World**
- Any cell from your load order, interior or exterior, mods included (1 cell, 3×3 or 5×5).
- Placed objects with their material swaps, landscape with blended ground layers, water planes.
- Every placed light, with its colour, radius, spotlight cone and flags.
- Shortcut buttons for seven places and an empty studio floor.
- Plain backgrounds, the slim buttons either side of the places: NifSkope's black or Outfit Studio's grey, exact on
  screen, with NifSkope's floor grid and corner axes (the grid button turns them off). The light and exposure stay the
  Studio's; a place or a cell brings the sky back.
- Game mode: walk, run, sprint, jump and fly through the cell in third person, at the game's speeds.

**From a plugin**
- Pick an armour record: Lightbox loads what the game would load. That's the armature, the male or female model,
  OMOD variants and material swaps.
- Each file shows where it comes from: a loose file with its date, or the archive.

**Workflow**
- Never locks your files: the Creation Kit, FO4Edit and archive tools can save while it runs.
- Saved plugins and repacked archives are read again by themselves and the scene reloads. To reload by hand
  instead, turn off View > Reload when game files change; File > Reload game files does it on demand.
- With Mod Organizer 2, a mod switched on or off (or moved) in MO2 is picked up the same way, and each loose file
  shows which mod it comes from. Files newly added to a mod's folder appear after Mods > Read the mods again.
- Screenshots at 1×, 2× or 3× resolution.
- Before / after: edit a texture or material (or re-export the mesh), press R and only the files that changed are
  read again; the camera, pose, hour and weather stay. The previous look stays as "before": drag the line across the
  view, hold B to see only "before", or keep the original to compare several saves with the first look. Works with
  loose files, repacked archives and Mod Organizer 2 mods; screenshots of the split get Before / After labels.
- Moving polished parts (buckles, clips) don't sparkle: Camera & image > smooth shiny highlights does in one frame
  what the game's TAA does over several. A still frame looks the same either way.
- Anti-aliasing: MSAA ×4 (the default), or TAA, the game's own default, with or without MSAA (experimental: Camera &
  image > Anti-aliasing). With TAA a still picture refines itself into a 16-sample supersample, screenshots included;
  moving edges, thin straps and shiny parts stop crawling.
- Compare panel: drop an in-game screenshot over the view (onion skin, difference, split) and sample both.
- Studio, Compact and Viewport layouts. Settings are kept in your browser and can be saved to a file.
- `tools\capture.py` renders a model or an armour record to PNGs without opening a window, for scripted reviews.
- Single shapes: Alt+click one in the view, or open a .nif's shapes with the ▸ in the Scene list (small rows, an
  eye each).
- Right-click a model in the view: Hide .nif, Reset (undo the gizmo) or Delete .nif (out of the scene; the file is never touched).
- Open .nif files from Explorer: File > Open .nif files with Lightbox adds it to Windows' Open with list (tick
  "Always use this app" once for double-clicks). An open window takes the file and comes to the front.
- Even light (the bulb in the World panel): one light from the camera and flat ambient, like NifSkope and Outfit
  Studio, so every part is lit wherever you look.
- A still scene uses no GPU. View > Quality (Auto by default) keeps weaker PCs usable: laptop graphics and 2-4 GB
  cards get smaller textures, less anti-aliasing and a lower resolution while something moves; a strong GPU keeps
  full quality.

## What it's for

- Check a new armour or backpack on the body under real game light before you launch the game.
- See glow, emissive and controller animations at night, in fog, in the Glowing Sea.
- Confirm what your plugin actually loads: the right model, variant and material swap.
- Check object placement in a cell after a CK or FO4Edit save, without restarting anything.
- Walk a cell in third person to judge scale, lighting and clipping.
- Play any animation clip with your item worn to look for clipping.
- Take consistent mod-page shots with the same weather, hour and camera every time.

## Controls

| Input | Action |
| --- | --- |
| drag | look around |
| right drag, Shift + drag | pan |
| wheel | zoom |
| W A S D, Q / E | fly, down / up (Shift: faster) |
| click | select a model (outline + file name) |
| G | game mode: W A S D move, Space jump (hold to fly), Shift sprint, Caps Lock walk, G or Esc leave |
| R | reload the textures, materials and meshes that changed on disk (before / after) |
| B (hold) | show "before" while comparing |
| Alt + click | colour sample (with a compare screenshot: both, and the EV difference) |
| Drag a gizmo handle | move / turn / stretch / scale the selected model (Ctrl snaps: 1 unit, 15°, 5 %) |

The full list is under Help > Controls.

## Known limits

- Not drawn yet: grass, real water, cloud layers, the farthest LOD (mountains past 32 cells), NPCs and creatures.
- Skeleton corpses stand in their bind pose (the game lays them out from the reference's ragdoll data).
- Particles are simplified: no collisions (drips do not splash), no spawning on death, no wind, and effects that the
  game starts from a script play on a loop. In a cell, the 40 nearest effects within about 70 m run.
- Placed lights: up to 8 shadow-casting lights at once (nearest the camera), and their shadows do not fall on the
  landscape.
- Night is the least accurate setting: the ground about 1 EV too bright, the sky about 1 EV too dark.
- Spotlight directions are taken from how the lights are placed in the data, not checked against the game.
- Cloth physics (experimental) is Lightbox's own solver on the game's cloth data, not Havok itself: close, not
  identical, and not yet compared with the game. A few outfits still shiver slightly at rest. Volume constraints (in
  about a dozen coats) are not solved yet; cloth on objects placed in a cell (flags, nets) does not move; no wind.
- TAA (experimental): fast-moving parts can leave a faint trail; transparent effects are not motion-tracked.
- So far tested on one PC (NVIDIA graphics, Edge). Reports from AMD and Intel graphics are welcome.
- Mod Organizer 2 support follows MO2 2.5's file formats and is checked on test setups, not yet on a big real mod
  list: reports welcome. Files added by MO2 plugins such as Root Builder are not followed.

## Options

```
FO4 Lightbox.exe [--game DIR] [--choose-game] [--source game|mo2] [--mo2 DIR [--profile NAME]] [--port 8765] [--plugin FILE]
Start Lightbox.bat [--game DIR] [--source game|mo2] [--mo2 DIR [--profile NAME]] [--port 8765] [--no-browser] [--plugin FILE]
```

- `--game DIR`: your Fallout 4 folder (the one holding `Data`). `--choose-game`: ask for it again.
- `--source game`: read the game folder as it is; `--source mo2`: read Mod Organizer 2's current profile.
- `--mo2 DIR`: a Mod Organizer 2 folder (portable install or instance) to read; `--profile NAME`: which profile.
- `--port N`: another local port.
- `--plugin FILE`: also read a plugin that is not enabled, after the load order (preview a work in progress).
- `Start Lightbox.bat` runs the viewer in a console window and opens it in your default browser.

Headless capture: `runtime\python.exe tools\capture.py --help`.

## Your files

- Read only: nothing is written into the game folder, ever. No plugins, no F4SE, nothing to install in the game.
  Mod Organizer 2's folders are only read too.
- Nothing from Bethesda ships with Lightbox. Meshes, textures, materials, weather, cells and animations are read
  from your own install while it runs.
- The server listens on `127.0.0.1` only. Lightbox writes only to its own folder (Python's cache files) and to
  `%LOCALAPPDATA%\FO4 Lightbox` (the window's browser profile with your settings, `server.log`, `settings.json`
  with the Mods choice, and `game_path.txt` if it had to ask where the game is).

## Credits and thanks

FO4 Lightbox stands on the work of a lot of generous people: modders who mapped Fallout 4's file formats and gave their tools away, researchers who published the methods it draws with, and players who tried it and told us what broke. Thank you, every one of you.

### Modding tools and file formats

- **The [NifTools](https://github.com/niftools) team**: [nif.xml](https://github.com/niftools/nifxml), the community's map of the NIF format that Lightbox's mesh reader follows, and [NifSkope](https://github.com/niftools/nifskope). Thanks also to jonwd7 for NifSkope's Fallout 4 renderer, and to hexabits and Candoran2 for its [development builds](https://github.com/hexabits/nifskope).
- **ousnius**: [BodySlide and Outfit Studio](https://github.com/ousnius/BodySlide-and-Outfit-Studio), the [nifly](https://github.com/ousnius/nifly) NIF library and the [Material Editor](https://github.com/ousnius/Material-Editor), whose BGSM / BGEM layouts Lightbox's material reader follows.
- **Bad Dog**: [PyNifly](https://github.com/BadDogSkyrim/PyNifly). Its Fallout 4 animation reader ships unchanged inside Lightbox, so the reference body can play any HKX clip, and PyNifly is what Lightbox's NIF reader was checked against.
- **Dagobaking**: the spline decompression of Fallout 4 animations (skyrim-fo4-animation-conversion) that PyNifly's reader is based on.
- **PredatorCZ**: [HavokLib](https://github.com/PredatorCZ/HavokLib), the Havok format library underneath that decompression.
- **ElminsterAU, Sharlikran, Zilav, Hlp and the xEdit team**: [xEdit](https://github.com/TES5Edit/TES5Edit) / [FO4Edit](https://www.nexusmods.com/fallout4/mods/2737). Lightbox's plugin, weather and cell readers were checked against its record definitions, value by value.
- **fo76utils**: the [NifSkope fork](https://github.com/fo76utils/nifskope) and [fo76utils](https://github.com/fo76utils/fo76utils). Their open Fallout 4 shader was the cross-check for Lightbox's materials and shader animation.
- **MANOLOV02**: [Nif Explorer](https://www.nexusmods.com/fallout4/mods/108129), [FO4_Base_Library](https://github.com/MANOLOV02/FO4_Base_Library), [Wardrobe Manager](https://www.nexusmods.com/fallout4/mods/94884) and [NPC Manager](https://www.nexusmods.com/fallout4/mods/105008). Their documented findings on the game's image space and weather records were a valuable cross-check.
- **The [Mod Organizer 2](https://www.modorganizer.org/) team** ([source](https://github.com/ModOrganizer2/modorganizer)): Lightbox reads your MO2 profile straight from its files.
- **The [OpenMW](https://openmw.org/) team**: their open engine documents how this engine family moves the sun across the sky.

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

### Made by

- **Bman**: the idea, the direction and every design call, plus hours of in-game calibration screenshots, so Lightbox is measured against the real game instead of eyeballed. Made for Backpacks of the Commonwealth.
- Written with **Claude** (Anthropic).

## Licence

GPL-3.0 (`LICENSE`). The source is included: `server\` (Python) and `web\` (JavaScript, GLSL).
`runtime\` holds the Python 3.14 runtime (PSF licence) and numpy (BSD licence); their licences are in `runtime\`.
How it works, what is measured and what is approximated: `docs\DEVELOPMENT.md`, `docs\engine-notes.md`,
`docs\weather-notes.md`.
