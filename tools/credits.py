"""FO4 Lightbox's credits, kept in one place and written into everything that shows them:

    python tools/credits.py

rewrites the "Credits and thanks" section of README.md and docs/DEVELOPMENT.md, the credits in Help > About
(web/index.html) and, when it exists next to the project, the Nexus description draft (BBCode:
../NifViewer_Release/nexus_description.txt, or nexus_page.md where it lived up to 1.1.0). Edit the lists below, never
the generated sections. Every link was checked on 2026-10-07.
"""
import html
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEXUS = [os.path.join(os.path.dirname(ROOT), 'NifViewer_Release', n) for n in ('nexus_description.txt', 'nexus_page.md')]
NEXUS_CREDITS = '[size=5][b][color=#e8b04a]Credits'

INTRO = ("FO4 Lightbox stands on the work of a lot of generous people: modders who mapped Fallout 4's file formats "
         "and gave their tools away, researchers who published the methods it draws with, and players who tried it "
         "and told us what broke. Thank you, every one of you.")

GROUPS = [
    ('Modding tools and file formats', None, [
        "**The [NifTools](https://github.com/niftools) team**: [nif.xml](https://github.com/niftools/nifxml), the "
        "community's map of the NIF format that Lightbox's mesh reader follows, and "
        "[NifSkope](https://github.com/niftools/nifskope). Thanks also to jonwd7 for NifSkope's Fallout 4 renderer, "
        "and to hexabits and Candoran2 for its [development builds](https://github.com/hexabits/nifskope).",
        "**ousnius**: [BodySlide and Outfit Studio](https://github.com/ousnius/BodySlide-and-Outfit-Studio), the "
        "[nifly](https://github.com/ousnius/nifly) NIF library and the "
        "[Material Editor](https://github.com/ousnius/Material-Editor), whose BGSM / BGEM layouts Lightbox's "
        "material reader follows.",
        "**Bad Dog**: [PyNifly](https://github.com/BadDogSkyrim/PyNifly). Its Fallout 4 animation reader ships "
        "unchanged inside Lightbox, so the reference body can play any HKX clip, and PyNifly is what Lightbox's "
        "NIF reader was checked against. Its documented Havok collision layouts are what Lightbox's collision "
        "reader follows.",
        "**Dagobaking**: the spline decompression of Fallout 4 animations (skyrim-fo4-animation-conversion) that "
        "PyNifly's reader is based on.",
        "**PredatorCZ**: [HavokLib](https://github.com/PredatorCZ/HavokLib), the Havok format library underneath "
        "that decompression.",
        "**ElminsterAU, Sharlikran, Zilav, Hlp and the xEdit team**: [xEdit](https://github.com/TES5Edit/TES5Edit) "
        "/ [FO4Edit](https://www.nexusmods.com/fallout4/mods/2737). Lightbox's plugin, weather and cell readers "
        "were checked against its record definitions, value by value.",
        "**fo76utils**: the [NifSkope fork](https://github.com/fo76utils/nifskope) and "
        "[fo76utils](https://github.com/fo76utils/fo76utils). Their open Fallout 4 shader was the cross-check for "
        "Lightbox's materials and shader animation.",
        "**MANOLOV02**: [Nif Explorer](https://www.nexusmods.com/fallout4/mods/108129), "
        "[FO4_Base_Library](https://github.com/MANOLOV02/FO4_Base_Library), "
        "[Wardrobe Manager](https://www.nexusmods.com/fallout4/mods/94884) and "
        "[NPC Manager](https://www.nexusmods.com/fallout4/mods/105008). Their documented findings on the game's "
        "image space and weather records were a valuable cross-check.",
        "**The [Mod Organizer 2](https://www.modorganizer.org/) team** "
        "([source](https://github.com/ModOrganizer2/modorganizer)): Lightbox reads your MO2 profile straight from "
        "its files.",
        "**The [OpenMW](https://openmw.org/) team**: their open engine documents how this engine family moves the "
        "sun across the sky.",
    ]),
    ('Rendering research', 'Each one written fresh from the published method:', [
        "**John Hable**: the filmic \"Uncharted 2\" tonemap curve the game uses "
        "([Filmic Tonemapping Operators](https://filmicworlds.com/blog/filmic-tonemapping-operators/), 2010).",
        "**Morgan McGuire, Michael Mara and David Luebke**: "
        "[Scalable Ambient Obscurance](https://research.nvidia.com/publication/2012-06_scalable-ambient-obscurance) "
        "(2012), the game's default ambient occlusion.",
        "**Brian Karis**: [High-Quality Temporal Supersampling](https://advances.realtimerendering.com/s2014/) "
        "(SIGGRAPH 2014), the temporal anti-aliasing.",
        "**Marco Salvi**: [An Excursion in Temporal Supersampling]"
        "(https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf) "
        "(GDC 2016), the variance clipping that keeps TAA from ghosting.",
        "**Matt Pettineo**: [Catmull-Rom filtering in a few bilinear taps]"
        "(https://gist.github.com/TheRealMJP/c83b8c0f46b63f3a88a5986f4fa982b1), the sharp history read of the TAA.",
        "**Yusuke Tokuyoshi and Anton Kaplanyan**: [Improved Geometric Specular Antialiasing]"
        "(https://doi.org/10.1145/3306131.3317026) (I3D 2019), the \"smooth shiny highlights\" option.",
        "**Ola Olsson, Markus Billeter and Ulf Assarsson**: [Clustered Deferred and Forward Shading]"
        "(https://research.chalmers.se/en/publication/161725) (HPG 2012), how thousands of placed lights light a "
        "cell.",
        "**Matthias Müller, Bruno Heidelberger, Marcus Hennix and John Ratcliff**: [Position Based Dynamics]"
        "(https://diglib.eg.org/items/deb0a7a1-2ddf-496f-889a-fe0df1feeb73) (2006), the method of the cloth "
        "solver.",
        "**The classics the game's own shading is built from**: "
        "[Oren-Nayar](https://en.wikipedia.org/wiki/Oren%E2%80%93Nayar_reflectance_model) diffuse (1994), "
        "[Blinn-Phong](https://en.wikipedia.org/wiki/Blinn%E2%80%93Phong_reflection_model) (1977) and "
        "[Cook-Torrance](https://en.wikipedia.org/wiki/Specular_highlight#Cook%E2%80%93Torrance_model) (1982) "
        "highlights, [Schlick's Fresnel](https://en.wikipedia.org/wiki/Schlick%27s_approximation) (1994), "
        "[Kajiya-Kay](https://history.siggraph.org/learning/rendering-fur-with-three-dimensional-textures-by-kajiya-and-kay) "
        "hair (1989), [Henyey-Greenstein](https://en.wikipedia.org/wiki/Henyey%E2%80%93Greenstein_phase_function) "
        "(1941) and [Rayleigh](https://en.wikipedia.org/wiki/Rayleigh_scattering) scattering, "
        "[shadow mapping](https://en.wikipedia.org/wiki/Shadow_mapping) (Lance Williams, 1978) with "
        "percentage-closer filtering (Reeves, Salesin and Cook, 1987), "
        "[Halton](https://en.wikipedia.org/wiki/Halton_sequence) jitter (1960) and "
        "[Catmull-Rom](https://en.wikipedia.org/wiki/Catmull%E2%80%93Rom_spline) splines (1974).",
    ]),
    ('Bug reports', None, [
        "**NeinGaming**: found Lightbox's first real bug (the endless reload under Mod Organizer 2) and suggested a "
        "manual reload. Both made it into 1.1.0.",
        "**stalkerVlad1**: found that the animation search gave no sign of life (an empty box opened nothing, a "
        "failed search stayed silent). Fixed in 1.1.0.",
    ]),
    ('Made by', None, [
        "**Bman**: the idea, the direction and every design call, plus hours of in-game calibration screenshots, so "
        "Lightbox is measured against the real game instead of eyeballed. Made for Backpacks of the Commonwealth.",
        "Written with **Claude** (Anthropic).",
    ]),
]

# where each one is used, for developers (DEVELOPMENT.md only)
IN_CODE = [
    "`server/vendor/anim_fo4.py`: PyNifly's reader (Bad Dog), unchanged; spline decompression after Dagobaking and "
    "PredatorCZ's HavokLib.",
    "`server/fo4nif.py`: nif.xml (NifTools) block layouts; checked against PyNifly / nifly.",
    "`server/materials.py`: the Material Editor's BGSM / BGEM field order (ousnius).",
    "`server/esm_weather.py`, `server/esm_world.py`: FO4Edit 4.1.5f definitions (`FO4Export -q raw`) and FO4Dump's "
    "decoded output (the xEdit team).",
    "`server/mo2.py`, `server/sources.py`: Mod Organizer 2.5's file formats.",
    "`server/havok.py`, `server/cloth.py`, `web/js/cloth.js`: Fallout 4's Havok 2014 cloth data, run by a "
    "position-based solver (Müller et al.).",
    "`web/js/shaders.js`: Hable tonemap; SAO (McGuire, Mara, Luebke); TAA (Karis, Salvi, Pettineo's Catmull-Rom "
    "read); specular anti-aliasing (Tokuyoshi, Kaplanyan); light shafts (Henyey-Greenstein, Rayleigh)"
    "; the game's BRDF terms (Oren-Nayar, Blinn-Phong, Cook-Torrance, Schlick, Kajiya-Kay).",
    "`web/js/renderer.js`: clustered placed lights (Olsson, Billeter, Assarsson); Halton jitter; shadow maps with "
    "percentage-closer filtering.",
    "`docs/engine-notes.md` Section 25: the sun path, after OpenMW's documented model.",
    "`docs/prior-art.md` (not shipped): the study of Nif Explorer / FO4_Base_Library (MANOLOV02), the fo76utils "
    "NifSkope fork and Outfit Studio.",
]

LINK = re.compile(r'\[([^\]]+)\]\(([^)\s]+)\)')
BOLD = re.compile(r'\*\*(.+?)\*\*')


def to_html(s):
    out, pos = [], 0
    for m in LINK.finditer(s):
        out.append(html.escape(s[pos:m.start()], quote=False))
        out.append('<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>'
                   % (html.escape(m.group(2)), html.escape(m.group(1), quote=False)))
        pos = m.end()
    out.append(html.escape(s[pos:], quote=False))
    return BOLD.sub(r'<b>\1</b>', ''.join(out))


def to_bb(s):
    return BOLD.sub(r'[b]\1[/b]', LINK.sub(r'[url=\2]\1[/url]', s))


def markdown(heading='##', sub='###', dev=False):
    lines = [f'{heading} Credits and thanks', '', INTRO, '']
    if dev:
        lines += ['This section, the README\'s, Help > About and the Nexus page draft are written by '
                  '`python tools/credits.py` from one list: add or change credits there.', '']
    for title, intro, items in GROUPS:
        lines += [f'{sub} {title}', '']
        if intro:
            lines += [intro, '']
        lines += [f'- {it}' for it in items] + ['']
    if dev:
        lines += [f'{sub} Where they are used', ''] + [f'- {it}' for it in IN_CODE] + ['']
    return '\n'.join(lines)


def about_html():
    h = ['  <h4>Credits and thanks</h4>', f'  <p class="thanks">{to_html(INTRO)}</p>']
    for title, intro, items in GROUPS:
        h.append(f'  <h5>{html.escape(title)}</h5>')
        if intro:
            h.append(f'  <p class="cnote">{to_html(intro)}</p>')
        h.append('  <ul class="credits">')
        h += [f'    <li>{to_html(it)}</li>' for it in items]
        h.append('  </ul>')
    return '\n'.join(h)


def bbcode():
    b = ['[size=5][b][color=#e8b04a]Credits and thanks[/color][/b][/size]', to_bb(INTRO), '']
    for title, intro, items in GROUPS:
        b.append(f'[b]{title}[/b]')
        if intro:
            b.append(to_bb(intro))
        b.append('[list]')
        b += [f'[*]{to_bb(it)}' for it in items]
        b += ['[/list]', '']
    return '\n'.join(b).rstrip('\n')


def rw(path, fn):
    """Rewrite a file through fn, keeping its line endings; report whether anything changed."""
    s = open(path, encoding='utf-8', newline='').read()
    crlf = '\r\n' in s
    t = fn(s.replace('\r\n', '\n'))
    if crlf:
        t = t.replace('\n', '\r\n')
    if t != s:
        open(path, 'w', encoding='utf-8', newline='').write(t)
    print('updated  ' if t != s else 'unchanged', path)


def section(text, start_re, end):
    """(start, stop) of the block that begins at the line matching start_re and runs up to the text end."""
    m = re.search(start_re, text, re.M)
    return m.start(), text.index(end, m.end())


CSS_OLD = '.mbox p { margin: 5px 0; }'
CSS_NEW = ('.mbox p { margin: 5px 0; }\n'
           '.mbox a { color: var(--accent); text-decoration: none; } .mbox a:hover { text-decoration: underline; }\n'
           '.mbox h5 { margin: 12px 0 2px; font-size: 12px; color: var(--text); }\n'
           '.mbox .thanks { color: var(--text); } .mbox .cnote { color: var(--dim); font-size: 12px; margin: 2px 0; }\n'
           '.mbox ul.credits { margin: 2px 0 4px; padding-left: 18px; font-size: 12px; }\n'
           '.mbox ul.credits li { margin: 3px 0; }')


def main():
    def md(dev):
        def f(s):
            i, j = section(s, r'^## Credits( and thanks)?$', '## Licence')
            return s[:i] + markdown(dev=dev) + '\n' + s[j:]
        return f
    rw(os.path.join(ROOT, 'README.md'), md(False))
    rw(os.path.join(ROOT, 'docs', 'DEVELOPMENT.md'), md(True))

    def about(s):
        if CSS_NEW not in s:
            assert s.count(CSS_OLD) == 1, 'the About styles moved: update CSS_OLD'
            s = s.replace(CSS_OLD, CSS_NEW)
        a = s.index('<template id="tplAbout">')
        b = s.index('</template>', a)
        k = s.index('  <h4>Credits', a, b)
        return s[:k] + about_html() + '\n' + s[b:]
    rw(os.path.join(ROOT, 'web', 'index.html'), about)

    def nexus(s):
        i, j = section(s, r'^\[size=5\]\[b\]\[color=#e8b04a\]Credits', '[size=5][b][color=#e8b04a]License')
        return s[:i] + bbcode() + '\n\n' + s[j:]
    for p in NEXUS:                            # Bman's Nexus drafts, outside the project (not shipped): the one
        if os.path.exists(p) and NEXUS_CREDITS in open(p, encoding='utf-8').read():   # that holds the credits
            rw(p, nexus)
            break


if __name__ == '__main__':
    main()
