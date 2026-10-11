"""Turn a parsed FO4 NIF into the JSON scene the browser renders: node hierarchy, shapes (skinned shapes are posed
into the NIF's own bind pose here), one resolved material per shape (BGSM/BGEM when present, else the NIF's own
shader values) and the controller chains with their keys."""
import base64

import numpy as np

from fo4nif import Nif, SHAPE_TYPES, NODE_TYPES, SHADER_CTRL, PSYS_MODIFIERS
from materials import read_material
from vfs import norm
from cloth import scene_cloth

SF1 = dict(specular=0, skinned=1, vertex_alpha=3, greyscale_color=4, greyscale_alpha=5, use_falloff=6, envmap=7,
           rgb_falloff=8, cast_shadows=9, model_space_normals=12, refraction=15, eye_envmap=17, hair=18,
           skin_tint=21, own_emit=22, decal=26, dynamic_decal=27, external_emittance=29, soft_effect=30, ztest=31)
SF2 = dict(zwrite=0, no_fade=3, double_sided=4, vertex_colors=5, glow_map=6, tint=9, premult_alpha=19,
           aniso_lighting=21, skew_spec_alpha=22, alpha_test=25, gradient_remap=26, effect_lighting=30)


def flags(v, table):
    return {k: bool(v >> b & 1) for k, b in table.items()}


def b64(a, dtype):
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode('ascii')


def _unorm8(a):
    """unit-vector components -1..1 -> bytes (value / 255 x 2 - 1 reads them back), padded to 4 per vertex"""
    q = np.clip(np.round((np.asarray(a, np.float64) + 1.0) * 127.5), 0, 255)
    if q.ndim != 2:
        return q
    out = np.empty((len(q), 4), np.float64)            # (np.c_ made the same float64 array, ~30 us slower per call)
    out[:, :q.shape[1]] = q
    out[:, q.shape[1]:] = 255
    return out


def put_compact(s, g, pos, nrm, du, dv, skin):
    """Vertex arrays in the formats the NIF stores them (what the game reads), described in s['fmt']."""
    fmt = s['fmt'] = {'nrm': 'u8x4'}
    if 'raw_position' in g:
        s['position'], fmt['pos'] = b64(g['raw_position'], '<f2'), 'f2x4'
    else:
        s['position'], fmt['pos'] = b64(pos, '<f4'), 'f4x3'
    small = len(pos) < 65536
    s['indices'], fmt['idx'] = b64(g['indices'], '<u2' if small else '<u4'), 'u16' if small else 'u32'
    if 'raw_uv' in g:
        s['uv'], fmt['uv'] = b64(g['raw_uv'], '<f2'), 'f2x2'
    elif 'uv' in g:
        s['uv'], fmt['uv'] = b64(g['uv'], '<f4'), 'f4x2'
    if 'raw_normal' in g:
        s['normal'] = b64(g['raw_normal'], 'u1')
    elif nrm is not None:
        s['normal'] = b64(_unorm8(nrm), 'u1')
    if du is not None:
        if 'raw_tangent' in g and 'raw_normal' in g:
            # FO4 keeps the bitangent's x in the position's w (a half float), y in the normal's w, z in the tangent's w
            bx = np.clip(np.round((np.asarray(du[:, 0], np.float64) + 1.0) * 127.5), 0, 255)
            d = np.empty((len(bx), 4), np.float64)
            d[:, 0], d[:, 1], d[:, 2], d[:, 3] = bx, g['raw_normal'][:, 3], g['raw_tangent'][:, 3], 255
            s['dpdu'] = b64(d, 'u1')
            s['dpdv'] = b64(g['raw_tangent'], 'u1')
        else:
            s['dpdu'], s['dpdv'] = b64(_unorm8(du), 'u1'), b64(_unorm8(dv), 'u1')
    if skin:
        fmt['w'] = 'u16x4'


def _strip_root(p, top):
    """Vanilla files sometimes keep Bethesda's absolute build path (c:\\projects\\fallout4\\build\\pc\\data\\...);
    the game resolves them relative to Data, so cut at the last 'data\\' or at the resource folder."""
    p = norm(p)
    i = p.rfind('\\data\\')
    if i >= 0:
        p = p[i + 6:]
    elif ':' in p:
        j = p.find(top + '\\')
        if j >= 0:
            p = p[j:]
    return p if p.startswith(top + '\\') else top + '\\' + p


def tex_path(p):
    return _strip_root(p, 'textures') if p else ''


def mat_path(p):
    return _strip_root(p, 'materials')


def alpha_from_property(ap):
    """NiAlphaProperty flags -> dict (blend on/src/dst, test on/func/ref)."""
    if not ap:
        return dict(blend=False, src=6, dst=7, test=False, test_func=4, ref=128)
    f = ap['alpha_flags']
    return dict(blend=bool(f & 1), src=(f >> 1) & 0xF, dst=(f >> 5) & 0xF, test=bool(f & 0x200),
                test_func=(f >> 10) & 0x7, ref=ap['threshold'])


def _swap(mp, swaps, m):
    """Material swap (MSWP) from a plugin record: original material -> replacement (+ colour remap index)."""
    sw = (swaps or {}).get(mp)
    if not sw:
        return mp
    m['swapped_from'] = mp
    if sw.get('remap') is not None:
        m['remap_index'] = sw['remap']
    return mat_path(sw['new'])


def bgsm_fields(bg):
    """A read BGSM (materials.read_material) -> the lit material fields the viewer uses (also for decal texture sets
    whose material is a BGSM, esm_world._decal)."""
    ab = bg['alpha_blend']
    return dict(
        textures=dict(diffuse=tex_path(bg['tex_diffuse']), normal=tex_path(bg['tex_normal']),
                      smoothspec=tex_path(bg['tex_smoothspec']), greyscale=tex_path(bg['tex_greyscale']),
                      envmap=tex_path(bg.get('tex_envmap', '')), glow=tex_path(bg.get('tex_glow', '')),
                      inner=tex_path(bg.get('tex_inner', '')), wrinkles=tex_path(bg.get('tex_wrinkles', ''))),
        alpha=dict(blend=bool(ab[0]), src=ab[1], dst=ab[2], test=bg['alpha_test'], ref=bg['alpha_test_ref'],
                   value=bg['alpha']),
        two_sided=bg['two_sided'], zwrite=bg['zwrite'], ztest=bg['ztest'], decal=bg['decal'],
        uv_offset=bg['uv_offset'], uv_scale=bg['uv_scale'], tile_u=bg['tile_u'], tile_v=bg['tile_v'],
        specular_enabled=bg['specular_enabled'], specular_color=bg['specular_color'],
        specular_mult=bg['specular_mult'], smoothness=bg['smoothness'], fresnel_power=bg['fresnel_power'],
        env_mapping=bg.get('env_mapping', False), env_mask_scale=bg.get('env_mask_scale', 1.0),
        greyscale=bg['grayscale_to_palette_color'], greyscale_scale=bg['grayscale_to_palette_scale'],
        emit_enabled=bg['emit_enabled'], emit_color=bg.get('emit_color', [0, 0, 0]), emit_mult=bg['emit_mult'],
        glowmap=bg['glowmap'], external_emittance=bg['external_emittance'],
        model_space_normals=bg['model_space_normals'], skin_tint=bg['skin_tint'], hair=bg['hair'],
        hair_tint=bg['hair_tint'], rim_lighting=bg.get('rim_lighting', False), rim_power=bg.get('rim_power', 2),
        backlight_power=bg.get('backlight_power', 0), subsurface=bg.get('subsurface', False),
        # engine-notes §3/§4: backlight power and subsurface (wrap) rolloff feed the sun diffuse terms
        backlight=bg.get('backlight_power', 0.0) if bg.get('backlighting') else 0.0,
        wrap=bg.get('subsurface_rolloff', 0.0) if bg.get('subsurface') else 0.0,
        wet=dict(spec_scale=bg['wet_spec_scale'], spec_power=bg['wet_spec_power_scale'],
                 min_var=bg['wet_spec_minvar'], envmap_scale=bg.get('wet_envmap_scale', 0),
                 fresnel_power=bg['wet_fresnel_power'], metalness=bg['wet_metalness']),
        root_material=bg['root_material'])


def lighting_material(nif, sh, ap, vfs, log, swaps=None):
    f1, f2 = flags(sh['sf1'], SF1), flags(sh['sf2'], SF2)
    m = dict(kind='lighting', shader_type=sh['shader_type_name'], sf1=sh['sf1'], sf2=sh['sf2'], flags1=f1, flags2=f2,
             vertex_colors=f2['vertex_colors'], vertex_alpha=f1['vertex_alpha'], skinned=f1['skinned'])
    name = sh.get('name', '')
    bg = None
    if name.lower().endswith('.bgsm'):
        mp = _swap(mat_path(name), swaps, m)
        m['material_path'] = mp
        try:
            bg = read_material(vfs.read(mp))
            m['material_source'] = vfs.source(mp)
        except FileNotFoundError:
            log.append(f'material not found: {mp} (using the NIF shader values)')
        except Exception as e:
            log.append(f'material unreadable: {mp}: {e}')
    texset = nif.blocks[sh['texture_set']].get('textures', []) if sh['texture_set'] >= 0 else []
    texset = texset + [''] * (10 - len(texset))
    if bg and bg['kind'] == 'bgsm':
        m['source'] = 'bgsm'
        m.update(bgsm_fields(bg))
    else:
        m['source'] = 'nif'
        a = alpha_from_property(ap)
        a['value'] = sh['alpha']
        m.update(
            textures=dict(diffuse=tex_path(texset[0]), normal=tex_path(texset[1]), glow=tex_path(texset[2]),
                          greyscale=tex_path(texset[3]), envmap=tex_path(texset[4]), envmask=tex_path(texset[5]),
                          inner=tex_path(texset[6]), smoothspec=tex_path(texset[7]), wrinkles=tex_path(texset[8])),
            alpha=a, two_sided=f2['double_sided'], zwrite=f2['zwrite'], ztest=f1['ztest'], decal=f1['decal'],
            dynamic_decal=f1['dynamic_decal'],
            uv_offset=sh['uv_offset'], uv_scale=sh['uv_scale'], tile_u=bool(sh['clamp'] & 2),
            tile_v=bool(sh['clamp'] & 1),
            specular_enabled=f1['specular'], specular_color=sh['specular_color'],
            specular_mult=sh['specular_strength'], smoothness=sh['smoothness'], fresnel_power=sh['fresnel_power'],
            env_mapping=f1['envmap'], env_mask_scale=sh.get('envmap_scale', 1.0),
            greyscale=f1['greyscale_color'], greyscale_scale=sh['greyscale_scale'],
            emit_enabled=f1['own_emit'], emit_color=sh['emissive_color'], emit_mult=sh['emissive_mult'],
            glowmap=f2['glow_map'], external_emittance=f1['external_emittance'],
            model_space_normals=f1['model_space_normals'], skin_tint=f1['skin_tint'], hair=f1['hair'],
            hair_tint=sh.get('tint_color', [1, 1, 1]), rim_lighting=False, rim_power=sh['rimlight_power'],
            backlight_power=sh.get('backlight_power', 0), subsurface=False,
            backlight=sh.get('backlight_power', 0.0), wrap=0.0,
            wet=sh['wet'], root_material=sh.get('wet_material', ''))
    # refraction (SF1 bit 15, or the BGSM's Refraction): a lit shape the game draws as a screen-space distortion of
    # what lies behind it; strength = the NIF's Refraction Strength (lighting controller variable 0 animates it)
    m['refraction'] = bool(f1['refraction'] or (bg and bg.get('refraction')))
    m['refraction_strength'] = (sh.get('refraction') or ((bg or {}).get('refraction_power') or 0.0)) if m['refraction'] else 0.0
    if sh['shader_type'] in (5, 6) and 'tint_color' in sh:
        m['tint_color'] = sh['tint_color']
    if m.get('remap_index') is not None:          # MSWP colour remapping index picks the palette row
        m['greyscale_scale'] = m['remap_index']
    return m


def effect_material(sh, ap, vfs, log, swaps=None):
    f1, f2 = flags(sh['sf1'], SF1), flags(sh['sf2'], SF2)
    m = dict(kind='effect', sf1=sh['sf1'], sf2=sh['sf2'], flags1=f1, flags2=f2,
             vertex_colors=f2['vertex_colors'], vertex_alpha=f1['vertex_alpha'], skinned=f1['skinned'])
    name = sh.get('name', '')
    bg = None
    if name.lower().endswith('.bgem'):
        mp = _swap(mat_path(name), swaps, m)
        m['material_path'] = mp
        try:
            bg = read_material(vfs.read(mp))
            m['material_source'] = vfs.source(mp)
        except FileNotFoundError:
            log.append(f'material not found: {mp} (using the NIF shader values)')
        except Exception as e:
            log.append(f'material unreadable: {mp}: {e}')
    if bg and bg['kind'] == 'bgem':
        m['source'] = 'bgem'
        ab = bg['alpha_blend']
        m.update(
            textures=dict(base=tex_path(bg['tex_base']), greyscale=tex_path(bg['tex_greyscale']),
                          envmap=tex_path(bg['tex_envmap']), normal=tex_path(bg['tex_normal']),
                          envmask=tex_path(bg['tex_envmask'])),
            alpha=dict(blend=bool(ab[0]), src=ab[1], dst=ab[2], test=bg['alpha_test'], ref=bg['alpha_test_ref'],
                       value=bg['alpha']),
            two_sided=bg['two_sided'], zwrite=bg['zwrite'], ztest=bg['ztest'], decal=bg['decal'],
            uv_offset=bg['uv_offset'], uv_scale=bg['uv_scale'], tile_u=bg['tile_u'], tile_v=bg['tile_v'],
            env_mapping=bg.get('env_mapping', False), env_mask_scale=bg.get('env_mask_scale', 1.0),
            greyscale_color=bg['grayscale_to_palette_color'], greyscale_alpha=bg['grayscale_to_palette_alpha'],
            base_color=bg['base_color'] + [1.0], base_color_scale=bg['base_color_scale'],
            falloff_enabled=bg['falloff_enabled'], falloff_color=bg['falloff_color_enabled'], falloff=bg['falloff'],
            lighting_influence=bg['lighting_influence'], effect_lighting=bg['effect_lighting'],
            soft=bg['soft_enabled'], soft_depth=bg['soft_depth'], blood=bg['blood_enabled'])
    else:
        m['source'] = 'nif'
        a = alpha_from_property(ap)
        a['value'] = 1.0
        m.update(
            textures=dict(base=tex_path(sh['source_texture']), greyscale=tex_path(sh['greyscale_texture']),
                          envmap=tex_path(sh['envmap_texture']), normal=tex_path(sh['normal_texture']),
                          envmask=tex_path(sh['envmask_texture'])),
            alpha=a, two_sided=f2['double_sided'], zwrite=f2['zwrite'], ztest=f1['ztest'], decal=f1['decal'],
            dynamic_decal=f1['dynamic_decal'],
            uv_offset=sh['uv_offset'], uv_scale=sh['uv_scale'], tile_u=bool(sh['clamp'] & 2),
            tile_v=bool(sh['clamp'] & 1),
            env_mapping=f1['envmap'], env_mask_scale=sh['envmap_scale'],
            greyscale_color=f1['greyscale_color'], greyscale_alpha=f1['greyscale_alpha'],
            base_color=sh['base_color'], base_color_scale=sh['base_color_scale'],
            falloff_enabled=f1['use_falloff'], falloff_color=f1['rgb_falloff'], falloff=sh['falloff'],
            lighting_influence=sh['lighting_influence'] / 255.0, effect_lighting=f2['effect_lighting'],
            soft=f1['soft_effect'], soft_depth=sh['soft_depth'], blood=False)
    return m


def key_list(kt, keys):
    return dict(type=kt, keys=[[k[0], k[1], k[2], k[3]] for k in keys])


def interp_json(nif, idx):
    if idx < 0:
        return None
    b = nif.blocks[idx]
    t = b['type']
    if t == 'NiFloatInterpolator':
        d = nif.blocks[b['data']] if b['data'] >= 0 else None
        return dict(kind='float', value=b['value'], keys=key_list(d['key_type'], d['keys']) if d else None)
    if t == 'NiPoint3Interpolator':
        d = nif.blocks[b['data']] if b['data'] >= 0 else None
        return dict(kind='point3', value=b['value'], keys=key_list(d['key_type'], d['keys']) if d else None)
    if t in ('NiBoolInterpolator', 'NiBoolTimelineInterpolator'):
        d = nif.blocks[b['data']] if b['data'] >= 0 else None
        return dict(kind='bool', value=b['value'], keys=key_list(d['key_type'], d['keys']) if d else None)
    if t == 'NiTransformInterpolator':
        out = dict(kind='transform', translation=b['translation'], rotation=b['rotation'], scale=b['scale'])
        if b['data'] >= 0:
            d = nif.blocks[b['data']]
            out['rot_type'] = d['rot_type']
            out['rot_keys'] = d['rot_keys']
            out['xyz_keys'] = [key_list(*k) for k in d['xyz_keys']] if d['xyz_keys'] else None
            out['trans_keys'] = key_list(d['trans_type'], d['trans_keys'])
            out['scale_keys'] = key_list(d['scale_type'], d['scale_keys'])
        return out
    return dict(kind='unsupported', type=t)


# ---------------------------------------------------------------------------------------------------- particles
# What the browser's simplified particle simulation (web/js/particles.js) needs from each NiParticleSystem: its
# material, emitters, forces, colour / size curves, atlas frames and the controllers that set the birth rate.
# Modifiers it does not simulate (LOD, spawn, bomb, colliders, inherit velocity) are left out.
PSYS_KEEP = {
    'NiPSysBoxEmitter': ('box', ('speed', 'speed_var', 'declination', 'declination_var', 'planar', 'planar_var',
                                 'color', 'radius', 'radius_var', 'life', 'life_var', 'object', 'size')),
    'NiPSysGravityModifier': ('gravity', ('object', 'axis', 'strength', 'force_type', 'world_aligned', 'decay')),
    'NiPSysDragModifier': ('drag', ('object', 'axis', 'percentage')),
    'NiPSysRotationModifier': ('rotation', ('speed', 'speed_var', 'angle', 'angle_var', 'random_sign')),
    'BSPSysSimpleColorModifier': ('color', ('fade_in', 'fade_out', 'keys', 'colors')),
    'BSPSysSubTexModifier': ('subtex', ('start', 'start_fudge', 'end', 'loop_start', 'loop_start_fudge', 'fps',
                                        'fps_fudge')),
    'BSPSysScaleModifier': ('scale', ('scales',)),
    'BSWindModifier': ('wind', ('strength',)),
}
for _t, _k in (('NiPSysCylinderEmitter', 'cylinder'), ('NiPSysSphereEmitter', 'sphere')):
    PSYS_KEEP[_t] = (_k, PSYS_KEEP['NiPSysBoxEmitter'][1])
PSYS_KEEP['NiPSysMeshEmitter'] = ('mesh', PSYS_KEEP['NiPSysBoxEmitter'][1][:-2])
PSYS_PARAM_CTLR = {'NiPSysEmitterSpeedCtlr': 'speed', 'NiPSysEmitterInitialRadiusCtlr': 'radius',
                   'NiPSysEmitterLifeSpanCtlr': 'life', 'NiPSysGravityStrengthCtlr': 'strength'}


def _mesh_points(nif, par, blocks, mode, n=256, seed=1):
    """Emission points (and outward normals) on a mesh emitter's shapes, in the NIF's root space: random points on
    the faces (area-weighted, mode 3: nearly every vanilla mesh emitter), face centres (1) or vertices (0, 2)."""
    rng = np.random.default_rng(seed)
    P, N = [], []
    for bi in blocks:
        b = nif.blocks[bi] if 0 <= bi < nif.nblocks else {}
        g = b.get('geometry')
        if (not g or not len(g['indices'])) and b.get('bound') and b['bound'][3] > 0:
            # a placeholder without vertices (the game puts an actor's own mesh there, e.g. a Sentry Bot's body):
            # points on its bounding sphere, facing out
            d = rng.normal(size=(n, 3))
            d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
            W = nif.world(bi, par)
            c = np.asarray(b['bound'][:3]) @ W[:3, :3].T + W[:3, 3]
            s = float(np.linalg.norm(W[:3, 0])) or 1.0
            P.append(c + d * b['bound'][3] * s); N.append(d @ W[:3, :3].T / s)
            continue
        if not g or not len(g['indices']):
            continue
        pos = g['position'].astype(np.float64)
        if b.get('skin', -1) >= 0 and 'weights' in g:               # skinned: the NIF's bind pose
            sk = nif.blocks[b['skin']]
            bd = nif.blocks[sk['data']] if sk.get('data', -1) >= 0 else None
            if bd and len(bd['skin_to_bone']) == len(sk['bones']):
                mats = np.stack([nif.world(bn, par) @ s2b for bn, s2b in zip(sk['bones'], bd['skin_to_bone'])])
                w = g['weights'].astype(np.float64)
                w = w / np.maximum(w.sum(1, keepdims=True), 1e-8)
                M = np.einsum('vk,vkij->vij', w, mats[np.minimum(g['bone_index'], len(mats) - 1)])
                pos = np.einsum('vij,vj->vi', M[:, :3, :3], pos) + M[:, :3, 3]
        else:
            W = nif.world(bi, par)
            pos = pos @ W[:3, :3].T + W[:3, 3]
        tri = g['indices'].astype(np.int64)
        a, b2, c = pos[tri[:, 0]], pos[tri[:, 1]], pos[tri[:, 2]]
        fn = np.cross(b2 - a, c - a)
        area = np.linalg.norm(fn, axis=1)
        fn = fn / np.maximum(area[:, None], 1e-9)
        if mode == 3 and area.sum() > 0:
            k = rng.choice(len(tri), size=n, p=area / area.sum())
            u, v = rng.random(n), rng.random(n)
            flip = u + v > 1
            u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
            P.append(a[k] + (b2[k] - a[k]) * u[:, None] + (c[k] - a[k]) * v[:, None]); N.append(fn[k])
        elif mode == 1:
            k = rng.choice(len(tri), size=min(n, len(tri)), replace=False)
            P.append((a[k] + b2[k] + c[k]) / 3); N.append(fn[k])
        else:
            vn = np.zeros_like(pos)
            for j in range(3):
                np.add.at(vn, tri[:, j], fn)
            vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-9)
            k = rng.choice(len(pos), size=min(n, len(pos)), replace=False)
            P.append(pos[k]); N.append(vn[k])
    if not P:
        return None
    P, N = np.concatenate(P)[:n], np.concatenate(N)[:n]
    return dict(points=np.round(P, 3).reshape(-1).tolist(), normals=np.round(N, 4).reshape(-1).tolist())


def _sequence_channels(nif):
    """controller block -> [(sequence, controlled block)] for the channels of the sequence an untouched object plays:
    the first one named idle / loop / default / special, the one the viewer plays too (renderer.js addModel). A fire
    barrel's emitters are driven by its 'autoLoop' sequence (their own interpolators are blends); an oxygen tank's
    spray belongs to 'stage2loop', which only plays once the tank is shot, after the quiet 'stage1loop'."""
    out = {}
    seqs = [b for b in nif.blocks if b['type'] == 'NiControllerSequence' and 'blocks' in b]
    auto = next((s for s in seqs if any(w in s['name'].lower() for w in ('idle', 'loop', 'default', 'special'))), None)
    for cb in auto['blocks'] if auto else []:
        out.setdefault(cb['controller'], []).append((auto, cb))
    return out


def _channel_interp(nif, chans, iid):
    """The first sequence channel with this interpolator ID ('BirthRate', 'EmitterActive'; '' = any): (seq, interp)."""
    for s, cb in chans:
        if (not iid or cb['interpolator_id'] == iid) and cb['interpolator'] >= 0:
            ip = interp_json(nif, cb['interpolator'])
            if ip and ip.get('kind') != 'unsupported':
                return s, ip
    return None, None


def scene_particles(nif, par, vfs, log, swaps=None):
    out = []
    chans_of = _sequence_channels(nif) if 'NiControllerSequence' in nif.block_types else {}
    for i, b in enumerate(nif.blocks):
        if b['type'] != 'NiParticleSystem' or 'error' in b:
            continue
        data = nif.blocks[b['data']] if 0 <= b['data'] < nif.nblocks else {}
        sh = nif.blocks[b['shader']] if b['shader'] >= 0 else None
        ap = nif.blocks[b['alpha']] if b['alpha'] >= 0 else None
        if sh and sh['type'] == 'BSEffectShaderProperty':
            mat = effect_material(sh, ap, vfs, log, swaps)
        elif sh and sh['type'] == 'BSLightingShaderProperty':
            mat = lighting_material(nif, sh, ap, vfs, log, swaps)
        else:
            log.append(f'particles {b["name"]}: no supported shader (not drawn)')
            continue
        mat['vertex_colors'] = mat['vertex_alpha'] = True        # particle colours ride in the vertex colours
        mods, skipped = [], set()
        for mi in b['modifiers']:
            m = nif.blocks[mi] if 0 <= mi < nif.nblocks else {}
            keep = PSYS_KEEP.get(m.get('type'))
            if not keep:
                if m.get('type') not in ('NiPSysAgeDeathModifier', 'NiPSysPositionModifier', 'NiPSysBoundUpdateModifier',
                                         'BSPSysLODModifier', 'NiPSysSpawnModifier', None):
                    skipped.add(m['type'])
                continue
            kind, fields = keep
            e = dict(kind=kind, name=m['name'], order=m['order'], active=m['active'], **{f: m[f] for f in fields if f in m})
            if kind == 'mesh':
                pts = _mesh_points(nif, par, m['meshes'], m['emission_type'], seed=mi + 1)
                if not pts:
                    log.append(f'particles {b["name"]}: mesh emitter without usable meshes')
                    continue
                e.update(pts)
            mods.append(e)
        if skipped:
            log.append(f'particles {b["name"]}: not simulated: {", ".join(sorted(skipped))}')
        ctls = []
        for c in nif.controllers_of(i):
            cb = nif.blocks[c]
            ct = cb['type']
            if ct in ('NiPSysEmitterCtlr', 'BSPSysMultiTargetEmitterCtlr') or ct in PSYS_PARAM_CTLR:
                birth = ct not in PSYS_PARAM_CTLR
                d = dict(kind='birth' if birth else PSYS_PARAM_CTLR[ct],
                         modifier=cb.get('modifier_name', ''), flags=cb['ctl_flags'],
                         frequency=cb['frequency'], phase=cb['phase'], start=cb['start'], stop=cb['stop'],
                         interp=interp_json(nif, cb.get('interpolator', -1)),
                         visibility=interp_json(nif, cb.get('visibility', -1)))
                if (d['interp'] or {}).get('kind') in (None, 'unsupported') and c in chans_of:
                    # driven by a controller sequence (blend interpolators): that sequence's channels and timing
                    s, ip = _channel_interp(nif, chans_of[c], 'BirthRate' if birth else '')
                    if ip:
                        d.update(interp=ip, flags=8 | (s['cycle_type'] << 1), frequency=s['frequency'] or 1.0,
                                 phase=0.0, start=s['start'], stop=s['stop'], sequence=s['name'])
                        if birth:
                            _, vis = _channel_interp(nif, chans_of[c], 'EmitterActive')
                            d['visibility'] = vis
                ctls.append(d)
        if not any(m['kind'] in ('box', 'cylinder', 'sphere', 'mesh') for m in mods):
            continue
        out.append(dict(block=i, name=b['name'], parent=par.get(i, -1), local=b['local'].T.reshape(-1).tolist(),
                        hidden=bool(b['flags'] & 1), shader_block=b['shader'], world_space=b['world_space'],
                        max=int(min(data.get('max', 64) or 64, 2048)), subtex=data.get('subtex', []),
                        aspect=[data.get('aspect_ratio', 1.0), data.get('aspect_flags', 0), data.get('aspect2', 1.0),
                                data.get('speed1', 0.0), data.get('speed2', 0.0)],
                        material=mat, modifiers=sorted(mods, key=lambda m: m['order']), controllers=ctls))
    return out


# Nodes a scripted animation hides for good before any save the viewer can show. Vault 111's elevator: the intro's
# ride up (sequence stage4) switches m_SkyDome off at 9 s and no earlier stage plays again, so the bind pose's sky
# dome (a backdrop for the descent) would hang over the platform. Checked against the game 2026-10-08.
END_STATE_HIDDEN = {'meshes\\interiors\\vault\\rooms\\vltelevator\\vltelevatorexterior.nif': {'m_SkyDome'}}


def build_scene(raw, vfs, name='', swaps=None, remap=None, compact=True, placed=False, cut=None):
    """remap: a palette row for greyscale-to-palette materials (an actor's hair colour).
    swaps: {normalised original material path: {'new': path, 'remap': float or None}}, from plugin material swaps.
    compact: vertex data in the NIF's own formats (half-float positions and UVs, byte normals and tangents, 16-bit
    indices; 'fmt' on each shape says which), which the browser reads as they are: about half the bytes of floats.
    False: float32 everywhere (for code here that reads the arrays back).
    cut: (x0, y0, x1, y1) in the model's own space; triangles wholly inside are left out (distant LOD chunks under the
    loaded cells, which draw that ground and those objects themselves)."""
    nif = Nif(raw)
    if placed:      # an object placed in a cell: the game puts the root where the reference says (its DATA position
        # and rotation) and ignores the root node's own transform (322 vanilla models carry one, e.g. a road T-junction
        # turned 180 degrees; checked against the game's precombined copies)
        for r in nif.roots:
            if 0 <= r < nif.nblocks and 'local' in nif.blocks[r]:
                nif.blocks[r]['local'] = np.eye(4)
    log = []
    par = nif.parents()
    gone = END_STATE_HIDDEN.get(name.replace('/', '\\').lower(), ())
    for i, b in enumerate(nif.blocks):          # the named node and everything under it
        j = i
        while gone and j >= 0 and nif.blocks[j].get('name') not in gone:
            j = par.get(j, -1)
        if gone and j >= 0 and 'flags' in b:
            b['flags'] |= 1
    nodes, shapes, controllers = [], [], []
    for i, b in enumerate(nif.blocks):
        t = b['type']
        if t in NODE_TYPES and 'local' in b:
            nodes.append(dict(block=i, name=b['name'], type=t, parent=par.get(i, -1),
                              local=b['local'].T.reshape(-1).tolist(), hidden=bool(b['flags'] & 1)))
        if 'error' in b:
            log.append(f'block {i} {t}: {b["error"]}')
    for i, b in enumerate(nif.blocks):
        if b['type'] not in SHAPE_TYPES or not b.get('geometry'):
            continue
        g = b['geometry']
        pos, nrm = g['position'].astype(np.float64), g.get('normal')
        du, dv = g.get('dpdu'), g.get('dpdv')
        skinned = b['skin'] >= 0 and 'weights' in g
        world = None
        if skinned:
            sk = nif.blocks[b['skin']]
            bd = nif.blocks[sk['data']] if sk.get('data', -1) >= 0 else None
            if not bd or len(bd['skin_to_bone']) != len(sk['bones']):
                log.append(f'{b["name"]}: skin data mismatch, shown unskinned')
                skinned = False
        skin = None
        if skinned:
            # Geometry stays in skin space; the browser skins it on the GPU with
            # bone world (bind pose from this NIF, or an animated skeleton) x skin-to-bone.
            bind = [nif.world(bn, par) for bn in sk['bones']]
            mats = np.stack([bw @ s2b for bw, s2b in zip(bind, bd['skin_to_bone'])])
            w = g['weights'].astype(np.float64)
            w = w / np.maximum(w.sum(1, keepdims=True), 1e-8)
            idx = np.minimum(g['bone_index'], len(mats) - 1)
            M = np.einsum('vk,vkij->vij', w, mats[idx])                     # bind pose, for the bounding box
            rest = np.einsum('vij,vj->vi', M[:, :3, :3], pos) + M[:, :3, 3]
            bone_names = [nif.blocks[bn]['name'] for bn in sk['bones']]
            wq = b64(np.round(w * 65535), '<u2') if compact else b64(w, '<f4')     # 16-bit normalised weights
            skin = dict(bones=bone_names, weights=wq, index=b64(idx.astype(np.uint8), 'u1'),
                        skin_to_bone=[m.T.reshape(-1).tolist() for m in bd['skin_to_bone']],
                        bind_world=[m.T.reshape(-1).tolist() for m in bind])
        else:
            world = nif.world(i, par)
            bone_names = []
            if cut and len(g['indices']):       # distant LOD: leave out what the loaded cells already draw
                wp = pos @ world[:3, :3].T + world[:3, 3]
                inside = (wp[:, 0] > cut[0]) & (wp[:, 0] < cut[2]) & (wp[:, 1] > cut[1]) & (wp[:, 1] < cut[3])
                g['indices'] = g['indices'][~inside[g['indices']].all(1)]
        ap = nif.blocks[b['alpha']] if b['alpha'] >= 0 else None
        sh = nif.blocks[b['shader']] if b['shader'] >= 0 else None
        if sh and sh['type'] == 'BSLightingShaderProperty':
            mat = lighting_material(nif, sh, ap, vfs, log, swaps)
            if remap is not None and mat.get('greyscale'):
                mat['greyscale_scale'] = remap
        elif sh and sh['type'] == 'BSEffectShaderProperty':
            mat = effect_material(sh, ap, vfs, log, swaps)
        else:
            mat = dict(kind='none')
            log.append(f'{b["name"]}: no supported shader ({sh["type"] if sh else "none"})')
        # shapes named EditorMarker / VisibilityEditorMarker are editor helpers the game never draws
        s = dict(block=i, name=b['name'], type=b['type'], parent=par.get(i, -1), skinned=skinned,
                 hidden=bool(b['flags'] & 1) or 'editormarker' in (b['name'] or '').lower(),
                 nverts=int(len(pos)), ntris=int(len(g['indices'])),
                 local=None if skinned else b['local'].T.reshape(-1).tolist(),
                 shader_block=b['shader'], bones=bone_names, material=mat, skin=skin)
        if compact:
            put_compact(s, g, pos, nrm, du, dv, skin)
        else:
            s['position'], s['indices'] = b64(pos, '<f4'), b64(g['indices'], '<u4')
            if 'uv' in g:
                s['uv'] = b64(g['uv'], '<f4')
            if nrm is not None:
                s['normal'] = b64(nrm, '<f4')
            if du is not None:
                s['dpdu'], s['dpdv'] = b64(du, '<f4'), b64(dv, '<f4')
        if 'color' in g:
            s['color'] = b64(g['color'], 'u1')
        lo, hi = (rest if skinned else pos).min(0), (rest if skinned else pos).max(0)
        if world is not None:
            corners = np.array([[x, y, z, 1] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
            wc = corners @ world.T
            lo, hi = wc[:, :3].min(0), wc[:, :3].max(0)
        s['bbox'] = [lo.tolist(), hi.tolist()]
        shapes.append(s)
    for i, b in enumerate(nif.blocks):
        t = b['type']
        if t in SHADER_CTRL or t in ('NiTransformController', 'NiVisController', 'NiAlphaController'):
            c = dict(block=i, type=t, target=b['target'], flags=b['ctl_flags'], frequency=b['frequency'],
                     phase=b['phase'], start=b['start'], stop=b['stop'], variable=b.get('variable'),
                     interp=interp_json(nif, b['interpolator']))
            if t in SHADER_CTRL:
                c['shader_kind'], c['value_kind'] = SHADER_CTRL[t]
            controllers.append(c)
    sequences = []
    for i, b in enumerate(nif.blocks):
        if b['type'] != 'NiControllerSequence' or 'blocks' not in b:
            continue
        seq = dict(block=i, name=b['name'], cycle=b['cycle_type'], frequency=b['frequency'], start=b['start'],
                   stop=b['stop'], channels=[])
        skipped = set()
        for cb in b['blocks']:
            ctl = nif.blocks[cb['controller']] if 0 <= cb['controller'] < nif.nblocks else {}
            ct = ctl.get('type', cb['controller_type'])
            ch = dict(node=cb['node_name'], controller_type=ct, interp=interp_json(nif, cb['interpolator']))
            if ct in SHADER_CTRL:
                ch['shader_block'] = ctl.get('target', -1)       # -1: the controller block did not parse
                ch['shader_kind'], ch['value_kind'] = SHADER_CTRL[ct]
                ch['variable'] = ctl.get('variable')
            elif ct not in ('NiMultiTargetTransformController', 'NiTransformController'):
                skipped.add(ct)
                continue
            if ch['interp'] is None or ch['interp'].get('kind') == 'unsupported':
                continue
            seq['channels'].append(ch)
        if skipped:
            log.append(f'sequence {b["name"]}: not played: {", ".join(sorted(skipped))}')
        sequences.append(seq)
    if shapes:
        lo = np.min([s['bbox'][0] for s in shapes if not s['hidden']] or [[0, 0, 0]], axis=0)
        hi = np.max([s['bbox'][1] for s in shapes if not s['hidden']] or [[0, 0, 0]], axis=0)
    else:
        lo = hi = np.zeros(3)
    bsx = [b.get('value') for b in nif.blocks if b['type'] == 'BSXFlags']
    # "Prn" on the root: the game hangs this (rigid, unskinned) model on that skeleton bone when it is worn; tools that
    # ignore it show the model at the origin in the bone's axes (at the feet, sideways)
    attach = None
    for r in nif.roots[:1]:
        for e in nif.blocks[r].get('extra', []) if 0 <= r < nif.nblocks else []:
            eb = nif.blocks[e] if 0 <= e < nif.nblocks else {}
            if eb.get('type') == 'NiStringExtraData' and (eb.get('name') or '').lower() == 'prn' and eb.get('value'):
                attach = eb['value']
    # Havok cloth (BSClothExtraData): the browser simulates it (cloth.py, web/js/cloth.js)
    cloth = scene_cloth(nif, log) if 'BSClothExtraData' in nif.block_types else []
    if cloth:                    # a cloth moves the meshes skinned to its cloth bones; one that drives none of them here
        skinned = {b.lower() for s in shapes if s.get('skin') for b in s['skin']['bones']}       # is not simulated
        keep = [c for c in cloth if any(c['bones'][b['bone']].lower() in skinned for b in c['cloth_bones'])]
        for c in cloth:
            if c not in keep:
                log.append('cloth %s: drives none of the meshes in this file (not simulated)' % c['name'])
        cloth = keep
    particles = scene_particles(nif, par, vfs, log, swaps) if 'NiParticleSystem' in nif.block_types else []
    return dict(name=name, nblocks=nif.nblocks, nodes=nodes, shapes=shapes, controllers=controllers,
                sequences=sequences, attach_bone=attach, cloth=cloth, particles=particles,
                bbox=[lo.tolist(), hi.tolist()], bsx=bsx[0] if bsx else None, log=sorted(set(log)),
                block_types=sorted(set(nif.block_types)))
