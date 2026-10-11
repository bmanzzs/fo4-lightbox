"""Read-only Fallout 4 material files: BGSM (lighting) and BGEM (effect).

Field order follows ousnius' Material Editor (BaseMaterialFile / BGSM / BGEM Deserialize). Vanilla FO4 files are
version 1-2; later versions (FO76) are decoded as far as the same layout reaches.
"""
import struct


class R:
    def __init__(self, b):
        self.b, self.i = b, 0

    def u32(self):
        v = struct.unpack_from('<I', self.b, self.i)[0]
        self.i += 4
        return v

    def f(self):
        v = struct.unpack_from('<f', self.b, self.i)[0]
        self.i += 4
        return v

    def u8(self):
        v = self.b[self.i]
        self.i += 1
        return v

    def bool(self):
        return bool(self.u8())

    def s(self):
        n = self.u32()
        v = self.b[self.i:self.i + n]
        self.i += n
        return v.rstrip(b'\x00').decode('latin-1')

    def col(self):
        return [self.f(), self.f(), self.f()]


def _base(r, m):
    m['version'] = v = r.u32()
    tile = r.u32()
    m['tile_u'], m['tile_v'] = bool(tile & 2), bool(tile & 1)
    m['uv_offset'] = [r.f(), r.f()]
    m['uv_scale'] = [r.f(), r.f()]
    m['alpha'] = r.f()
    m['alpha_blend'] = [r.u8(), r.u32(), r.u32()]          # enabled, source, destination (NiAlphaProperty enums)
    m['alpha_test_ref'] = r.u8()
    m['alpha_test'] = r.bool()
    m['zwrite'], m['ztest'] = r.bool(), r.bool()
    m['ssr'], m['wet_ssr'] = r.bool(), r.bool()
    m['decal'], m['two_sided'], m['decal_no_fade'], m['non_occluder'] = r.bool(), r.bool(), r.bool(), r.bool()
    m['refraction'], m['refraction_falloff'] = r.bool(), r.bool()
    m['refraction_power'] = r.f()
    if v < 10:
        m['env_mapping'] = r.bool()
        m['env_mask_scale'] = r.f()
    else:
        m['depth_bias'] = r.bool()
    m['grayscale_to_palette_color'] = r.bool()
    if v >= 6:
        m['mask_writes'] = r.u8()
    return v


def read_bgsm(data):
    r = R(data)
    if data[:4] != b'BGSM':
        raise ValueError('not a BGSM file')
    r.i = 4
    m = {'kind': 'bgsm'}
    v = _base(r, m)
    m['tex_diffuse'], m['tex_normal'], m['tex_smoothspec'], m['tex_greyscale'] = r.s(), r.s(), r.s(), r.s()
    if v > 2:
        m['tex_glow'], m['tex_wrinkles'], m['tex_specular'], m['tex_lighting'], m['tex_flow'] = \
            r.s(), r.s(), r.s(), r.s(), r.s()
        if v >= 17:
            m['tex_dfalpha'] = r.s()
    else:
        m['tex_envmap'], m['tex_glow'], m['tex_inner'], m['tex_wrinkles'], m['tex_displacement'] = \
            r.s(), r.s(), r.s(), r.s(), r.s()
    m['editor_alpha_ref'] = r.bool()
    if v >= 8:
        m['translucency'] = r.bool()
        m['translucency_thick'] = r.bool()
        m['translucency_mix_albedo'] = r.bool()
        m['translucency_subsurface_color'] = r.col()
        m['translucency_transmissive_scale'] = r.f()
        m['translucency_turbulence'] = r.f()
    else:
        m['rim_lighting'] = r.bool()
        m['rim_power'] = r.f()
        m['backlight_power'] = r.f()
        m['subsurface'] = r.bool()
        m['subsurface_rolloff'] = r.f()
    m['specular_enabled'] = r.bool()
    m['specular_color'] = r.col()
    m['specular_mult'] = r.f()
    m['smoothness'] = r.f()
    m['fresnel_power'] = r.f()
    m['wet_spec_scale'] = r.f()
    m['wet_spec_power_scale'] = r.f()
    m['wet_spec_minvar'] = r.f()
    if v < 10:
        m['wet_envmap_scale'] = r.f()
    m['wet_fresnel_power'] = r.f()
    m['wet_metalness'] = r.f()
    if v > 2:
        m['pbr'] = r.bool()
        if v >= 9:
            m['custom_porosity'] = r.bool()
            m['porosity'] = r.f()
    m['root_material'] = r.s()
    m['aniso_lighting'] = r.bool()
    m['emit_enabled'] = r.bool()
    if m['emit_enabled']:
        m['emit_color'] = r.col()
    m['emit_mult'] = r.f()
    m['model_space_normals'] = r.bool()
    m['external_emittance'] = r.bool()
    if v >= 12:
        m['lum_emittance'] = r.f()
    if v >= 13:
        m['adaptive_emissive'] = r.bool()
        m['adaptive_exposure'] = [r.f(), r.f(), r.f(), r.f()]
    if v < 8:
        m['backlighting'] = r.bool()
    m['receive_shadows'], m['hide_secret'], m['cast_shadows'] = r.bool(), r.bool(), r.bool()
    m['dissolve_fade'], m['assume_shadowmask'], m['glowmap'] = r.bool(), r.bool(), r.bool()
    if v < 7:
        m['env_window'], m['env_eye'] = r.bool(), r.bool()
    m['hair'] = r.bool()
    m['hair_tint'] = r.col()
    m['tree'], m['facegen'], m['skin_tint'], m['tessellate'] = r.bool(), r.bool(), r.bool(), r.bool()
    if v < 3:
        m['disp_bias'], m['disp_scale'], m['tess_pn_scale'], m['tess_base'], m['tess_fade'] = \
            r.f(), r.f(), r.f(), r.f(), r.f()
    m['grayscale_to_palette_scale'] = r.f()
    if v >= 1:
        m['skew_specular_alpha'] = r.bool()
    m['_complete'] = r.i == len(data)
    return m


def read_bgem(data):
    r = R(data)
    if data[:4] != b'BGEM':
        raise ValueError('not a BGEM file')
    r.i = 4
    m = {'kind': 'bgem'}
    v = _base(r, m)
    m['tex_base'], m['tex_greyscale'], m['tex_envmap'], m['tex_normal'], m['tex_envmask'] = \
        r.s(), r.s(), r.s(), r.s(), r.s()
    if v >= 11:
        m['tex_specular'], m['tex_lighting'], m['tex_glow'] = r.s(), r.s(), r.s()
    if v >= 21:
        m['tex_glass_roughness'], m['tex_glass_dirt'] = r.s(), r.s()
    if v >= 10:
        if v >= 21:
            m['glass_enabled'] = r.bool()
            if m['glass_enabled']:
                m['glass_fresnel_color'] = r.col()
                m['glass_refraction_scale'] = r.f()
                m['glass_blur_scale'] = r.f()
                if v >= 22:
                    m['glass_blur_scale_factor'] = r.f()
        m['env_mapping'] = r.bool()
        m['env_mask_scale'] = r.f()
    m['blood_enabled'] = r.bool()
    m['effect_lighting'] = r.bool()
    m['falloff_enabled'] = r.bool()
    m['falloff_color_enabled'] = r.bool()
    m['grayscale_to_palette_alpha'] = r.bool()
    m['soft_enabled'] = r.bool()
    m['base_color'] = r.col()
    m['base_color_scale'] = r.f()
    m['falloff'] = [r.f(), r.f(), r.f(), r.f()]           # start angle, stop angle, start opacity, stop opacity
    m['lighting_influence'] = r.f()
    m['envmap_min_lod'] = r.u8()
    m['soft_depth'] = r.f()
    if v >= 11:
        m['emit_color'] = r.col()
    if v >= 15:
        m['adaptive_exposure'] = [r.f(), r.f(), r.f()]
    if v >= 16:
        m['glowmap'] = r.bool()
    if v >= 20:
        m['effect_pbr_specular'] = r.bool()
    m['_complete'] = r.i == len(data)
    return m


def read_material(data):
    if data[:4] == b'BGSM':
        return read_bgsm(data)
    if data[:4] == b'BGEM':
        return read_bgem(data)
    raise ValueError('unknown material file')
