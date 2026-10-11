# Vendored third-party code

`anim_fo4.py` - Fallout 4 HKX skeleton / hkaSplineCompressedAnimation reader, copied unchanged from PyNifly
(https://github.com/BadDogSkyrim/PyNifly, `io_scene_nifly/hkx/anim_fo4.py`, Copyright (c) Bad Dog, GPL-3.0).
Its spline decompression is based on Dagobaking's skyrim-fo4-animation-conversion, itself based on
PredatorCZ/HavokLib (GPL-3.0). Used here only to read animation clips from the user's own game install at run time.
Because of this file, FO4 Lightbox is distributed under the GPL-3.0.
