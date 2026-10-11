"""Read-only Fallout 4 NIF reader (version 20.2.0.7, user 12, BS version 130) for rendering.

Decodes the scene graph, BSTriShape-family geometry (vertex-descriptor driven), BSSkin, lighting/effect shader
properties, alpha properties and the controller chains the viewer can play. Unknown blocks are skipped by size,
which the FO4 header always provides. Layouts follow niftools' nif.xml for BS version 130.
"""
import struct

import numpy as np

NODE_TYPES = {
    'NiNode', 'BSFadeNode', 'BSLeafAnimNode', 'BSTreeNode', 'BSMultiBoundNode', 'BSOrderedNode', 'BSValueNode',
    'NiSwitchNode', 'NiBillboardNode', 'BSRangeNode', 'BSBlastNode', 'BSDamageStage', 'BSDebrisNode', 'NiLODNode',
    'BSMasterParticleSystem', 'NiBone', 'BSWeakReferenceNode', 'BSFaceGenNiNode', 'BSClothExtraData_Node',
}
SHAPE_TYPES = {'BSTriShape', 'BSSubIndexTriShape', 'BSMeshLODTriShape', 'BSDynamicTriShape'}
SHADER_CTRL = {
    'BSLightingShaderPropertyFloatController': ('lighting', 'float'),
    'BSLightingShaderPropertyColorController': ('lighting', 'color'),
    'BSEffectShaderPropertyFloatController': ('effect', 'float'),
    'BSEffectShaderPropertyColorController': ('effect', 'color'),
}
LIGHTING_TYPES = {0: 'Default', 1: 'EnvironmentMap', 2: 'Glow', 3: 'Parallax', 4: 'FaceTint', 5: 'SkinTint',
                  6: 'HairTint', 7: 'ParallaxOcc', 8: 'MultitextureLandscape', 9: 'LODLandscape', 10: 'Snow',
                  11: 'MultiLayerParallax', 12: 'TreeAnim', 13: 'LODObjects', 14: 'SparkleSnow',
                  15: 'LODObjectsHD', 16: 'EyeEnvmap', 17: 'Cloud', 18: 'LODLandscapeNoise',
                  19: 'MultitextureLandscapeLODBlend', 20: 'Dismemberment'}
FLT_MAX = 3.4028234663852886e38
# particle systems: the emitters and modifiers the viewer simulates (the rest are skipped: LOD, spawn, bomb,
# colliders, bound updates), and the controllers that drive them
PSYS_EMITTERS = {'NiPSysBoxEmitter', 'NiPSysCylinderEmitter', 'NiPSysSphereEmitter', 'NiPSysMeshEmitter'}
PSYS_MODIFIERS = PSYS_EMITTERS | {'NiPSysGravityModifier', 'NiPSysDragModifier', 'NiPSysRotationModifier',
                                  'BSPSysSimpleColorModifier', 'BSPSysSubTexModifier', 'BSPSysScaleModifier',
                                  'BSWindModifier', 'NiPSysAgeDeathModifier', 'NiPSysPositionModifier'}
PSYS_CTLRS = {'NiPSysEmitterCtlr', 'BSPSysMultiTargetEmitterCtlr', 'NiPSysUpdateCtlr', 'NiPSysEmitterSpeedCtlr',
              'NiPSysEmitterInitialRadiusCtlr', 'NiPSysEmitterLifeSpanCtlr', 'NiPSysGravityStrengthCtlr',
              'NiPSysModifierActiveCtlr'}
PSYS_PARSED = PSYS_MODIFIERS | PSYS_CTLRS | {'NiParticleSystem', 'NiPSysData'}

# vertex attribute flags (desc >> 44)
VA_VERTEX, VA_UV, VA_UV2, VA_NORMAL, VA_TANGENT, VA_COLORS, VA_SKINNED = 0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40
VA_EYE, VA_FULLPREC = 0x100, 0x400


_STRUCTS = {}                      # take() formats, compiled once (a cell's NIFs take ~110,000 fields)
_I4 = np.eye(4)                    # a missing transform (world(); never handed out, never written)
_I4.flags.writeable = False


class Reader:
    def __init__(self, b, o=0):
        self.b, self.o = b, o

    def take(self, fmt):
        s = _STRUCTS.get(fmt)
        if s is None:
            s = _STRUCTS[fmt] = struct.Struct('<' + fmt)
        v = s.unpack_from(self.b, self.o)
        self.o += s.size
        return v

    def u8(self): return self.take('B')[0]
    def u16(self): return self.take('H')[0]
    def u32(self): return self.take('I')[0]
    def i32(self): return self.take('i')[0]
    def f32(self): return self.take('f')[0]
    def vec(self, n): return list(self.take('%df' % n))

    def sized_str(self):
        n = self.u32()
        s = self.b[self.o:self.o + n]
        self.o += n
        return s.rstrip(b'\x00').decode('latin1')


class NifError(Exception):
    pass


class Nif:
    def __init__(self, raw):
        b = self.raw = bytes(raw)
        if not b.startswith(b'Gamebryo File Format'):
            raise NifError('not a NIF file')
        o = b.index(b'\n') + 1
        self.ver, _endian, self.user, self.nblocks = struct.unpack_from('<IBII', b, o)
        o += 13
        self.bsver, = struct.unpack_from('<I', b, o)
        o += 4
        if self.ver != 0x14020007 or self.bsver != 130:
            raise NifError('not a Fallout 4 NIF (version %08X, BS version %d)' % (self.ver, self.bsver))
        for _ in range(4):                                   # author, process script, export script, max filepath
            o += 1 + b[o]
        nt, = struct.unpack_from('<H', b, o)
        o += 2
        self.types = []
        for _ in range(nt):
            n, = struct.unpack_from('<I', b, o)
            o += 4
            self.types.append(b[o:o + n].decode('latin1'))
            o += n
        tidx = struct.unpack_from('<%dH' % self.nblocks, b, o)
        o += 2 * self.nblocks
        self.block_types = [self.types[i & 0x7FFF] for i in tidx]
        sizes = struct.unpack_from('<%dI' % self.nblocks, b, o)
        o += 4 * self.nblocks
        ns, _maxlen = struct.unpack_from('<II', b, o)
        o += 8
        self.strings = []
        for _ in range(ns):
            n, = struct.unpack_from('<I', b, o)
            o += 4
            self.strings.append(b[o:o + n].decode('latin1'))
            o += n
        ng, = struct.unpack_from('<I', b, o)
        o += 4 + 4 * ng
        self.offsets = []
        for s in sizes:
            self.offsets.append(o)
            o += s
        self.sizes = list(sizes)
        nroots, = struct.unpack_from('<I', b, o)
        self.roots = list(struct.unpack_from('<%di' % nroots, b, o + 4))
        self.blocks = [None] * self.nblocks
        for i in range(self.nblocks):
            try:
                self.blocks[i] = self._parse(i)
            except Exception as e:                           # never let one odd block sink the file
                self.blocks[i] = {'type': self.block_types[i], 'error': str(e)}

    # ---- helpers -------------------------------------------------------------------------------
    def string(self, idx):
        return self.strings[idx] if 0 <= idx < len(self.strings) else ''

    def _net(self, r, d):
        d['name'] = self.string(r.i32())
        n = r.u32()
        d['extra'] = list(r.take('%di' % n)) if n else []
        d['controller'] = r.i32()

    def _av(self, r, d):
        self._net(r, d)
        d['flags'] = r.u32()
        t = r.vec(3)
        rot = r.vec(9)
        s = r.f32()
        d['collision'] = r.i32()
        # nif.xml Matrix33 is stored row by row (m11 m12 m13 / ...): world = R @ v * s + t (checked against PyNifly)
        R = np.array(rot, dtype=np.float64).reshape(3, 3)
        M = np.eye(4)
        M[:3, :3] = R * s
        M[:3, 3] = t
        d['local'] = M

    def _keys(self, r, width):
        """NiKeyGroup<float|Vector3>: returns (interpolation type, list of (time, value, fwd, bwd, tbc))."""
        n = r.u32()
        if n == 0:
            return 0, []
        kt = r.u32()
        keys = []
        for _ in range(n):
            t = r.f32()
            v = r.vec(width)
            fwd = bwd = tbc = None
            if kt == 2:
                fwd, bwd = r.vec(width), r.vec(width)
            elif kt == 3:
                tbc = r.vec(3)
            keys.append([t, v, fwd, bwd, tbc])
        return kt, keys

    # ---- block parsers -------------------------------------------------------------------------
    def _parse(self, i):
        typ = self.block_types[i]
        r = Reader(self.raw, self.offsets[i])
        d = {'type': typ}
        if typ in NODE_TYPES:
            self._av(r, d)
            n = r.u32()
            d['children'] = list(r.take('%di' % n)) if n else []
        elif typ in SHAPE_TYPES:
            self._av(r, d)
            self._shape(r, d, typ)
        elif typ == 'BSLightingShaderProperty':
            self._lighting(r, d)
        elif typ == 'BSEffectShaderProperty':
            self._effect(r, d)
        elif typ == 'BSShaderTextureSet':
            d['textures'] = [r.sized_str() for _ in range(r.u32())]
        elif typ == 'NiAlphaProperty':
            self._net(r, d)
            d['alpha_flags'] = r.u16()
            d['threshold'] = r.u8()
        elif typ == 'BSSkin::Instance':
            d['skeleton_root'] = r.i32()
            d['data'] = r.i32()
            n = r.u32()
            d['bones'] = list(r.take('%di' % n)) if n else []
        elif typ == 'BSSkin::BoneData':
            mats = []
            for _ in range(r.u32()):
                r.vec(4)                                     # bounding sphere
                R = np.array(r.vec(9), dtype=np.float64).reshape(3, 3)
                t = r.vec(3)
                s = r.f32()
                M = np.eye(4)
                M[:3, :3] = R * s
                M[:3, 3] = t
                mats.append(M)
            d['skin_to_bone'] = mats
        elif typ in SHADER_CTRL or typ in ('NiTransformController', 'NiVisController', 'NiAlphaController'):
            d['next'] = r.i32()
            d['ctl_flags'] = r.u16()
            d['frequency'], d['phase'], d['start'], d['stop'] = r.vec(4)
            d['target'] = r.i32()
            d['interpolator'] = r.i32()
            if typ in SHADER_CTRL:
                d['variable'] = r.u32()
        elif typ in ('NiControllerManager', 'NiMultiTargetTransformController'):
            d['next'] = r.i32()
            d['ctl_flags'] = r.u16()
            d['frequency'], d['phase'], d['start'], d['stop'] = r.vec(4)
            d['target'] = r.i32()
            if typ == 'NiControllerManager':
                d['cumulative'] = r.u8()
                n = r.u32()
                d['sequences'] = list(r.take('%di' % n)) if n else []
        elif typ == 'NiFloatInterpolator':
            d['value'] = r.f32()
            d['data'] = r.i32()
        elif typ == 'NiPoint3Interpolator':
            d['value'] = r.vec(3)
            d['data'] = r.i32()
        elif typ == 'NiControllerSequence':
            d['name'] = self.string(r.i32())
            n = r.u32()
            r.u32()                                          # array grow by
            blocks = []
            for _ in range(n):
                ip, ctl = r.i32(), r.i32()
                prio = r.u8()
                names = [self.string(r.i32()) for _ in range(5)]
                blocks.append(dict(interpolator=ip, controller=ctl, priority=prio, node_name=names[0],
                                   property_type=names[1], controller_type=names[2], controller_id=names[3],
                                   interpolator_id=names[4]))
            d['blocks'] = blocks
            d['weight'] = r.f32()
            d['text_keys'] = r.i32()
            d['cycle_type'] = r.u32()
            d['frequency'] = r.f32()
            d['start'], d['stop'] = r.f32(), r.f32()
            d['manager'] = r.i32()
            d['accum_root'] = self.string(r.i32())
        elif typ in ('NiBoolInterpolator', 'NiBoolTimelineInterpolator'):
            d['value'] = r.u8()
            d['data'] = r.i32()
        elif typ == 'NiTransformInterpolator':
            d['translation'] = r.vec(3)
            d['rotation'] = r.vec(4)                         # w x y z
            d['scale'] = r.f32()
            d['data'] = r.i32()
        elif typ == 'NiFloatData':
            d['key_type'], d['keys'] = self._keys(r, 1)
        elif typ == 'NiPosData':
            d['key_type'], d['keys'] = self._keys(r, 3)
        elif typ == 'NiBoolData':
            d['key_type'], d['keys'] = self._keys_bool(r)
        elif typ in ('NiTransformData', 'NiKeyframeData'):
            self._transform_data(r, d)
        elif typ == 'BSXFlags':                              # NiIntegerExtraData: name + value
            d['name'] = self.string(r.i32())
            d['value'] = r.u32()
        elif typ in ('NiStringExtraData',):
            d['name'] = self.string(r.i32())
            d['value'] = self.string(r.i32())
        elif typ == 'NiParticleSystem':
            self._av(r, d)
            d['bound'] = r.vec(4)
            d['skin'], d['shader'], d['alpha'] = r.i32(), r.i32(), r.i32()
            d['desc'] = r.take('Q')[0]
            d['lod'] = list(r.take('4H'))                    # far begin / end, near begin / end
            d['data'] = r.i32()
            d['world_space'] = bool(r.u8())
            n = r.u32()
            d['modifiers'] = list(r.take('%di' % n)) if n else []
        elif typ == 'NiPSysData':
            self._psys_data(r, d)
        elif typ in PSYS_MODIFIERS:
            self._psys_modifier(r, d, typ)
        elif typ in PSYS_CTLRS:
            d['next'] = r.i32()
            d['ctl_flags'] = r.u16()
            d['frequency'], d['phase'], d['start'], d['stop'] = r.vec(4)
            d['target'] = r.i32()
            if typ != 'NiPSysUpdateCtlr':
                d['interpolator'] = r.i32()
                d['modifier_name'] = self.string(r.i32())
            if typ in ('NiPSysEmitterCtlr', 'BSPSysMultiTargetEmitterCtlr'):
                d['visibility'] = r.i32()
        if typ in PSYS_PARSED:
            d['_used'] = r.o - self.offsets[i]               # bytes read (tools/psys_check.py compares it with the size)
        return d

    # ---- particles (nif.xml, BS version 130) ---------------------------------------------------------
    def _psys_data(self, r, d):
        r.i32()                                              # group ID
        d['max'] = r.u16()                                   # BS Max Vertices: the most particles alive at once
        r.take('3B')                                         # keep flags, compress flags, has vertices
        r.u16()                                              # BS data flags
        r.u32()                                              # material CRC
        r.u8()                                               # has normals
        r.vec(4)                                             # bounding sphere
        r.u8()                                               # has vertex colours
        r.u16()                                              # consistency flags
        r.i32()                                              # additional data
        r.u8()                                               # has radii
        r.u16()                                              # num active
        r.take('5B')                                         # has sizes / rotations / angles / axes / texture indices
        n = r.u32()
        d['subtex'] = [r.vec(4) for _ in range(n)]           # atlas frames: (u, width, v, height)
        d['aspect_ratio'] = r.f32()
        d['aspect_flags'] = r.u16()
        d['aspect2'], d['speed1'], d['speed2'] = r.vec(3)
        r.u8()                                               # has rotation speeds

    def _psys_modifier(self, r, d, typ):
        d['name'] = self.string(r.i32())
        d['order'] = r.u32()
        d['target'] = r.i32()
        d['active'] = bool(r.u8())
        if typ in PSYS_EMITTERS:
            (d['speed'], d['speed_var'], d['declination'], d['declination_var'], d['planar'], d['planar_var']) = r.vec(6)
            d['color'] = r.vec(4)
            d['radius'], d['radius_var'], d['life'], d['life_var'] = r.vec(4)
            if typ == 'NiPSysMeshEmitter':
                n = r.u32()
                d['meshes'] = list(r.take('%di' % n)) if n else []
                d['velocity_type'], d['emission_type'] = r.u32(), r.u32()
                d['axis'] = r.vec(3)
            else:
                d['object'] = r.i32()
                if typ == 'NiPSysBoxEmitter':
                    d['size'] = r.vec(3)                     # width (x), height (y), depth (z)
                elif typ == 'NiPSysCylinderEmitter':
                    d['size'] = r.vec(2)                     # radius, height (z)
                else:
                    d['size'] = r.vec(1)                     # radius
        elif typ == 'NiPSysGravityModifier':
            d['object'] = r.i32()
            d['axis'] = r.vec(3)
            d['decay'], d['strength'] = r.vec(2)
            d['force_type'] = r.u32()
            d['turbulence'], d['turbulence_scale'] = r.vec(2)
            d['world_aligned'] = bool(r.u8())
        elif typ == 'NiPSysDragModifier':
            d['object'] = r.i32()
            d['axis'] = r.vec(3)
            d['percentage'], d['range'], d['range_falloff'] = r.vec(3)
        elif typ == 'NiPSysRotationModifier':
            d['speed'], d['speed_var'], d['angle'], d['angle_var'] = r.vec(4)
            d['random_sign'], d['random_axis'] = bool(r.u8()), bool(r.u8())
            d['axis'] = r.vec(3)
        elif typ == 'BSPSysSimpleColorModifier':
            d['fade_in'], d['fade_out'] = r.vec(2)
            d['keys'] = r.vec(4)                             # colour 1 end, colour 1 start, colour 2 end, colour 2 start
            d['colors'] = [r.vec(4) for _ in range(3)]
        elif typ == 'BSPSysSubTexModifier':
            (d['start'], d['start_fudge'], d['end'], d['loop_start'], d['loop_start_fudge'], d['fps'],
             d['fps_fudge']) = r.vec(7)
        elif typ == 'BSPSysScaleModifier':
            n = r.u32()
            d['scales'] = r.vec(n) if n else []
        elif typ == 'BSWindModifier':
            d['strength'] = r.f32()
        elif typ == 'NiPSysAgeDeathModifier':
            d['spawn_on_death'] = bool(r.u8())
            d['spawn_modifier'] = r.i32()

    def _keys_bool(self, r):
        n = r.u32()
        if n == 0:
            return 0, []
        kt = r.u32()
        keys = []
        for _ in range(n):
            t = r.f32()
            v = r.u8()
            if kt == 3:
                r.vec(3)
            keys.append([t, [float(v)], None, None, None])
        return kt, keys

    def _transform_data(self, r, d):
        n = r.u32()
        d['rot_type'] = 0
        d['rot_keys'] = []
        d['xyz_keys'] = None
        if n:
            rt = d['rot_type'] = r.u32()
            if rt == 4:
                d['xyz_keys'] = [self._keys(r, 1) for _ in range(3)]
            else:
                for _ in range(n):
                    t = r.f32()
                    q = r.vec(4)
                    if rt == 3:
                        r.vec(3)
                    d['rot_keys'].append([t, q])
        d['trans_type'], d['trans_keys'] = self._keys(r, 3)
        d['scale_type'], d['scale_keys'] = self._keys(r, 1)

    def _shape(self, r, d, typ):
        d['bound'] = r.vec(4)
        d['skin'] = r.i32()
        d['shader'] = r.i32()
        d['alpha'] = r.i32()
        desc = r.take('Q')[0]
        ntri = r.u32()
        nv = r.u16()
        dsize = r.u32()
        d['desc'] = desc
        d['nverts'], d['ntris'] = nv, ntri
        d['geometry'] = None
        if dsize == 0 or nv == 0:
            return
        stride = (desc & 0xF) * 4
        flags = desc >> 44
        vbytes = np.frombuffer(self.raw, np.uint8, nv * stride, r.o).reshape(nv, stride)
        r.o += nv * stride
        tris = np.frombuffer(self.raw, '<u2', ntri * 3, r.o).reshape(ntri, 3).astype(np.uint32)
        r.o += ntri * 6

        def field(off, dtype, count):
            return np.ascontiguousarray(vbytes[:, off:off + np.dtype(dtype).itemsize * count]).view(dtype)

        # the stored values are kept as they are (raw_*) for the browser, which reads them in the same formats
        # (half floats and bytes); the float copies are for the bounds and anything computed here
        g = {'flags': int(flags)}
        if flags & VA_FULLPREC:
            p4 = field(0, '<f4', 4).astype(np.float32)
        else:
            g['raw_position'] = field(0, '<f2', 4)
            p4 = g['raw_position'].astype(np.float32)
        g['position'] = p4[:, :3]
        bx = p4[:, 3]
        if flags & VA_UV:
            g['raw_uv'] = field(((desc >> 8) & 0xF) * 4, '<f2', 2)
            g['uv'] = g['raw_uv'].astype(np.float32)
        if flags & VA_NORMAL:
            g['raw_normal'] = field(((desc >> 16) & 0xF) * 4, np.uint8, 4)
            nb = g['raw_normal'].astype(np.float32) / 255.0 * 2.0 - 1.0
            g['normal'] = nb[:, :3]
            if flags & VA_TANGENT:
                g['raw_tangent'] = field(((desc >> 20) & 0xF) * 4, np.uint8, 4)
                tb = g['raw_tangent'].astype(np.float32) / 255.0 * 2.0 - 1.0
                # FO4 naming is swapped: the stored "tangent" runs along +v (dP/dv), the stored bitangent
                # (x in position w, y in normal w, z in tangent w) along +u (dP/du).
                g['dpdv'] = tb[:, :3]
                g['dpdu'] = np.stack([bx, nb[:, 3], tb[:, 3]], axis=1)
        if flags & VA_COLORS:
            g['color'] = field(((desc >> 24) & 0xF) * 4, np.uint8, 4).copy()
        if flags & VA_SKINNED:
            so = ((desc >> 28) & 0xF) * 4
            g['weights'] = field(so, '<f2', 4).astype(np.float32)
            g['bone_index'] = field(so + 8, np.uint8, 4).copy()
        if typ == 'BSDynamicTriShape':                       # facegen heads: full-float positions follow
            nd = r.u32()
            if nd == nv:
                g['position'] = np.frombuffer(self.raw, '<f4', nv * 4, r.o).reshape(nv, 4)[:, :3].copy()
                g.pop('raw_position', None)
        g['indices'] = tris
        d['geometry'] = g

    def _lighting(self, r, d):
        st = r.u32()
        d['shader_type'] = st
        d['shader_type_name'] = LIGHTING_TYPES.get(st, str(st))
        self._net(r, d)
        d['sf1'], d['sf2'] = r.u32(), r.u32()
        d['uv_offset'], d['uv_scale'] = r.vec(2), r.vec(2)
        d['texture_set'] = r.i32()
        d['emissive_color'] = r.vec(3)
        d['emissive_mult'] = r.f32()
        d['wet_material'] = self.string(r.i32())
        d['clamp'] = r.u32()
        d['alpha'] = r.f32()
        d['refraction'] = r.f32()
        d['smoothness'] = r.f32()
        d['specular_color'] = r.vec(3)
        d['specular_strength'] = r.f32()
        d['subsurface_rolloff'] = r.f32()
        rim = r.f32()
        d['rimlight_power'] = rim
        if rim >= FLT_MAX * 0.999:
            d['backlight_power'] = r.f32()
        d['greyscale_scale'] = r.f32()
        d['fresnel_power'] = r.f32()
        d['wet'] = dict(zip(('spec_scale', 'spec_power', 'min_var', 'envmap_scale', 'fresnel_power', 'metalness'),
                            r.vec(6)))
        if st == 1:
            d['envmap_scale'] = r.f32()
            d['ssr'], d['wet_ssr'] = r.u8(), r.u8()
        elif st in (5, 6):
            d['tint_color'] = r.vec(3)
        elif st == 11:
            d['inner_thickness'], d['refraction_scale'] = r.f32(), r.f32()
            d['inner_scale'] = r.vec(2)
            d['envmap_scale'] = r.f32()
        elif st == 16:
            d['eye_cubemap_scale'] = r.f32()

    def _effect(self, r, d):
        self._net(r, d)
        d['sf1'], d['sf2'] = r.u32(), r.u32()
        d['uv_offset'], d['uv_scale'] = r.vec(2), r.vec(2)
        d['source_texture'] = r.sized_str()
        d['clamp'], d['lighting_influence'], d['envmap_min_lod'], _ = r.take('4B')
        d['falloff'] = r.vec(4)                              # start angle, stop angle, start opacity, stop opacity
        d['base_color'] = r.vec(4)
        d['base_color_scale'] = r.f32()
        d['soft_depth'] = r.f32()
        d['greyscale_texture'] = r.sized_str()
        d['envmap_texture'] = r.sized_str()
        d['normal_texture'] = r.sized_str()
        d['envmask_texture'] = r.sized_str()
        d['envmap_scale'] = r.f32()

    # ---- scene helpers ---------------------------------------------------------------------------
    def parents(self):
        par = {}
        for i, b in enumerate(self.blocks):
            for c in (b or {}).get('children', []) or []:
                if c >= 0:
                    par[c] = i
        return par

    def world(self, i, par=None):
        par = par if par is not None else self.parents()
        b = self.blocks[i]
        M = b['local'] if 'local' in b else _I4
        p = par.get(i)
        while p is not None:
            b = self.blocks[p]
            M = (b['local'] if 'local' in b else _I4) @ M      # (the same products as with a new identity each time)
            p = par.get(p)
        return np.eye(4) if M is _I4 else M

    def controllers_of(self, i):
        out = []
        c = self.blocks[i].get('controller', -1)
        seen = set()
        while c is not None and 0 <= c < self.nblocks and c not in seen:
            seen.add(c)
            out.append(c)
            c = self.blocks[c].get('next', -1)
        return out
