"""The Havok cloth of a NIF (BSClothExtraData), decoded for the viewer's own cloth solver (web/js/cloth.js).

Havok itself is not used (it is closed and cannot ship with the viewer); this reads the data the game gives it and
turns it into flat arrays. The game runs each cloth as a chain of operators per cloth state. Every vanilla cloth has a
"Simulate" state:
  ObjectSpaceSkinPN    skin the simulation mesh (positions + normals) to the body bones
  MoveParticles        pin the fixed particles to their skinned vertices
  Simulate             the particle solver: gravity, damping, motion transfer, constraint sets in a given order,
                       collisions with capsules on the body bones
  SimpleMeshBoneDeform the cloth bones (CLOTH_BN_*) from particle triangles; the meshes are skinned to those bones
and an "Animate" state that skips the solver (the skinned vertices copied or gathered into the particle buffer).

Conventions, checked on all 158 cloth blocks of the vanilla + Backpacks of the Commonwealth outfits
(tools/cloth_check.py):
  * matrices are stored column-major (as the viewer's mat4); boneFromSkinMesh = inverse(bone rest world);
  * the hkaSkeleton's referencePose is parent-local (translation, quaternion xyzw, scale);
  * packed vectors: component = (int16 << 16) * float(bits = w16 << 16);
  * object-space deformer control bytes: 0 = four-bone blocks, 1 = three, 2 = two, 3 = one; the local position /
    normal blocks follow the control-byte order; weights are bytes / 255;
  * a cloth bone = [A-G, B-G, (A-G)x(B-G), G] of its triangle (G = centroid) x its local bone transform;
  * the vertex numbering of the skin buffers and of the particles can differ; MoveParticles and the Animate state's
    copy / gather operators map between them.
Bend stiffness: the four weights are an edge (A, B, positive, sum 1) minus two wing tips (C, D, negative, sum -1);
the stored stiffness is negative and pre-divided by sum(w^2 / mass) (stiffness x that sum is about -0.66 in vanilla);
every vanilla set uses its rest pose (useRestPoseConfig), so the rest vector is taken from the rest pose here.
"""
import json
import struct

import numpy as np

import havok

NB_BY_CONTROL = {0: 4, 1: 3, 2: 2, 3: 1}
LIST_BY_CONTROL = {0: 'fourBlendEntries', 1: 'threeBlendEntries', 2: 'twoBlendEntries', 3: 'oneBlendEntries'}


def blobs(nif):
    """The packfiles of a NIF's BSClothExtraData blocks (a u32 length, then the packfile)."""
    out = []
    for i, t in enumerate(nif.block_types):
        if t == 'BSClothExtraData':
            o = nif.offsets[i]
            n, = struct.unpack_from('<I', nif.raw, o)
            out.append(nif.raw[o + 4:o + 4 + min(n, nif.sizes[i] - 4)])
    return out


def _qs_to_mat(q):
    t = np.array(q[0:3]); x, y, z, w = q[4:8]; s = np.array(q[8:11])
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4)
    M[:3, :3] = R * s[None, :]
    M[:3, 3] = t
    return M


def skeleton_world(sk):
    par, ref = sk['parentIndices'], sk['referencePose']
    W = [None] * len(par)
    for i in range(len(par)):
        L = _qs_to_mat(ref[i])
        W[i] = L if par[i] < 0 else W[par[i]] @ L
    return W


def _unpack(v):
    sc = struct.unpack('<f', struct.pack('<I', (v[3] & 0xffff) << 16))[0]
    return [(v[k] << 16) * sc for k in range(3)]


def _cm(M):
    """numpy 4x4 -> column-major list (the viewer's mat4)."""
    return [round(float(x), 6) for x in np.asarray(M, float).T.reshape(-1)]


def _r(a, nd=5):
    return [round(float(x), nd) for x in a]


def _skin_vertices(op, offset, entries, entry_of, verts):
    """One ObjectSpaceSkinPN operator -> verts[global index] = (entries, weights, local pos, local normal)."""
    dfm = op['objectSpaceDeformer']
    lists = {c: dfm[LIST_BY_CONTROL[c]] for c in LIST_BY_CONTROL}
    pos = dict.fromkeys(LIST_BY_CONTROL, 0)
    packed = bool(op['localPNs'])
    pns = op['localPNs'] if packed else op['localUnpackedPNs']
    mats = op['boneFromSkinMeshTransforms']
    subset = op['transformSubset']
    for cb, pn in zip(dfm['controlBytes'], pns):
        blk = lists[cb][pos[cb]]
        pos[cb] += 1
        k = NB_BY_CONTROL[cb]
        for j, vi in enumerate(blk['vertexIndices']):
            lp = _unpack(pn['localPosition'][j]) if packed else list(pn['localPosition'][j][:3])
            ln = _unpack(pn['localNormal'][j]) if packed else list(pn['localNormal'][j][:3])
            bones = blk['boneIndices'][j * k:(j + 1) * k]
            wts = [1.0] if k == 1 else [x / 255.0 for x in blk['boneWeights'][j * k:(j + 1) * k]]
            ents = []
            for b, w in zip(bones, wts):
                if w <= 0:
                    continue
                key = (subset[b], tuple(mats[b]))
                if key not in entry_of:
                    entry_of[key] = len(entries)
                    entries.append(dict(bone=subset[b], bfs=[round(float(x), 6) for x in mats[b]]))
                ents.append((entry_of[key], w))
            verts[offset + vi] = (ents, lp, ln)


def decode(blob):
    """One cloth packfile -> a dict for web/js/cloth.js (JSON-ready). Raises ValueError for data it cannot run."""
    root = havok.Packfile(blob).root()
    cd = sk = None
    for nv in root['namedVariants']:
        o = nv['variant']
        if o is not None and o.cls == 'hclClothData':
            cd = o
        elif o is not None and o.cls == 'hkaSkeleton':
            sk = o
    if cd is None or sk is None:
        raise ValueError('no cloth data / skeleton in the packfile')
    names = [b['name'] for b in sk['bones']]
    W = skeleton_world(sk)
    ops = cd['operators']
    states = cd['clothStateDatas']
    sim_state = next((s for s in states if any(ops[k].cls == 'hclSimulateOperator' for k in s['operators'])), None)
    if sim_state is None:
        raise ValueError('no simulated cloth state')
    if len(cd['simClothDatas']) != 1:
        raise ValueError('%d simulated cloths in one block' % len(cd['simClothDatas']))
    chain = [ops[k] for k in sim_state['operators']]
    unknown = sorted({o.cls for o in chain if o.f.get('__unknown')} |
                     {o.cls for o in chain if o.cls not in ('hclObjectSpaceSkinPNOperator', 'hclMoveParticlesOperator',
                                                             'hclSimulateOperator', 'hclSimpleMeshBoneDeformOperator')})
    if unknown:
        raise ValueError('cloth operators not supported: ' + ', '.join(unknown))
    bufs = cd['bufferDefinitions']
    boff, o = [], 0
    for b in bufs:
        boff.append(o)
        o += b['numVertices']
    sim = cd['simClothDatas'][0]
    n = len(sim['particleDatas'])
    deform = next(o for o in chain if o.cls == 'hclSimpleMeshBoneDeformOperator')
    pbuf = deform['inputBufferIdx']                          # the buffer whose vertices are the particles
    # ---- skinned vertices (every skin operator of the Simulate state, buffers laid end to end)
    entries, entry_of, verts = [], {}, {}
    skin_bufs = set()
    for op in chain:
        if op.cls == 'hclObjectSpaceSkinPNOperator':
            _skin_vertices(op, boff[op['outputBufferIndex']], entries, entry_of, verts)
            skin_bufs.add(op['outputBufferIndex'])
    if not verts:
        raise ValueError('no skinned vertices')
    order = sorted(verts)                                    # compact numbering
    gidx = {g: i for i, g in enumerate(order)}
    sv_n, sv_e, sv_w, sv_p, sv_nrm = [], [], [], [], []
    for g in order:
        ents, lp, ln = verts[g]
        ents = sorted(ents, key=lambda e: -e[1])[:4]
        sv_n.append(len(ents))
        for k in range(4):
            sv_e.append(ents[k][0] if k < len(ents) else 0)
            sv_w.append(round(ents[k][1], 5) if k < len(ents) else 0.0)
        sv_p += _r(lp)
        sv_nrm += _r(ln, 4)

    def skin_index(buf, vertex):
        g = boff[buf] + vertex
        return gidx.get(g, -1) if buf in skin_bufs else -1
    # ---- particles
    pdat = sim['particleDatas']
    if not sim['simClothPoses'] or len(sim['simClothPoses'][0]['positions']) < n:
        raise ValueError('no rest pose for the particles')
    pose = [q[:3] for q in sim['simClothPoses'][0]['positions'][:n]]
    fixed = []
    for op in chain:
        if op.cls == 'hclMoveParticlesOperator':
            for pr in op['vertexParticlePairs']:
                fixed.append([pr['particleIndex'], skin_index(op['refBufferIdx'], pr['vertexIndex'])])
    if any(f[1] < 0 for f in fixed):
        raise ValueError('a fixed particle is not on a skinned vertex')
    # particle -> skinned vertex as the Animate state places it (start-up, and the "physics off" pose)
    anim = [-1] * n
    for st in states:
        if st is sim_state:
            continue
        for k in st['operators']:
            op = ops[k]
            if op.f.get('__unknown'):
                continue
            if op.cls == 'hclCopyVerticesOperator' and op['outputBufferIdx'] == pbuf:
                for j in range(max(0, min(op['numberOfVertices'], n - op['startVertexOut']))):
                    anim[op['startVertexOut'] + j] = skin_index(op['inputBufferIdx'], op['startVertexIn'] + j)
            elif op.cls == 'hclGatherAllVerticesOperator' and op['outputBufferIdx'] == pbuf:
                for p_, v_ in enumerate(op['vertexInputFromVertexOutput'][:n]):
                    if v_ >= 0:
                        anim[p_] = skin_index(op['inputBufferIdx'], v_)
            elif op.cls == 'hclGatherSomeVerticesOperator' and op['outputBufferIdx'] == pbuf:
                for pr in op['vertexPairs']:
                    if pr['indexOutput'] < n:
                        anim[pr['indexOutput']] = skin_index(op['inputBufferIdx'], pr['indexInput'])
    for p_, s_ in fixed:
        anim[p_] = s_
    if any(a < 0 for a in anim):
        _anim_by_rest(anim, pose, W, entries, sv_n, sv_e, sv_w, sv_p)
    tri = list(sim['triangleIndices'])
    # ---- cloth bones
    bones_out = []
    for pr, L in zip(deform['triangleBonePairs'], deform['localBoneTransforms']):
        t = pr['triangleOffset'] // 6
        bones_out.append(dict(bone=pr['boneOffset'] // 64, tri=tri[3 * t:3 * t + 3], local=[round(float(x), 6) for x in L]))
    # ---- solver settings
    simop = next(o for o in chain if o.cls == 'hclSimulateOperator')
    si = sim['simulationInfo']
    tm = sim['transferMotionData']
    settings = dict(gravity=_r(si['gravity'][:3], 4), damping=si['globalDampingPerSecond'],
                    tolerance=si['collisionTolerance'], substeps=max(1, simop['subSteps'] or si['subSteps'] or 1),
                    iterations=max(1, simop['numberOfSolveIterations']), adapt=bool(simop['adaptConstraintStiffness']),
                    execution=list(simop['constraintExecution']),
                    transfer=dict(on=bool(si['transferMotionEnabled']), bone=tm['transformIndex'],
                                  translate=bool(tm['transferTranslationMotion']),
                                  tspeed=[tm['minTranslationSpeed'], tm['maxTranslationSpeed']],
                                  tblend=[tm['minTranslationBlend'], tm['maxTranslationBlend']],
                                  rotate=bool(tm['transferRotationMotion']),
                                  rspeed=[tm['minRotationSpeed'], tm['maxRotationSpeed']],
                                  rblend=[tm['minRotationBlend'], tm['maxRotationBlend']]))
    # ---- constraint sets (in data order; settings.execution indexes them, -1 = collisions)
    P = np.array(pose, float)
    inv = np.array([p['invMass'] for p in pdat], float)
    sets, unsupported = [], []
    for cs in sim['staticConstraintSets']:
        c = cs.cls
        if cs.f.get('__unknown'):
            sets.append(dict(type='none', name=cs['name'] if 'name' in cs.f else c, cls=c))
            unsupported.append(c)
        elif c in ('hclStandardLinkConstraintSet', 'hclStretchLinkConstraintSet'):
            L = cs['links']
            sets.append(dict(type='link' if c == 'hclStandardLinkConstraintSet' else 'stretch', name=cs['name'],
                             a=[l['particleA'] for l in L], b=[l['particleB'] for l in L],
                             rest=_r([l['restLength'] for l in L]), k=_r([l['stiffness'] for l in L], 4)))
        elif c == 'hclCompressibleLinkConstraintSet':
            L = cs['links']
            sets.append(dict(type='compress', name=cs['name'], a=[l['particleA'] for l in L], b=[l['particleB'] for l in L],
                             rest=_r([l['restLength'] for l in L]), min=_r([l['compressionLength'] for l in L]),
                             k=_r([l['stiffness'] for l in L], 4)))
        elif c == 'hclBendLinkConstraintSet':
            L = cs['links']
            sets.append(dict(type='bendlink', name=cs['name'], a=[l['particleA'] for l in L], b=[l['particleB'] for l in L],
                             min=_r([l['bendMinLength'] for l in L]), max=_r([l['stretchMaxLength'] for l in L]),
                             kmin=_r([l['bendStiffness'] for l in L], 4), kmax=_r([l['stretchStiffness'] for l in L], 4)))
        elif c == 'hclBendStiffnessConstraintSet':
            p4, w4, k, rest = [], [], [], []
            for l in cs['links']:
                idx = [l['particleA'], l['particleB'], l['particleC'], l['particleD']]
                w = np.array([l['weightA'], l['weightB'], l['weightC'], l['weightD']])
                sw2 = float((w * w * inv[idx]).sum())
                kk = min(1.0, max(0.0, -l['bendStiffness'] * sw2)) if sw2 > 0 else 0.0
                X = P[idx]
                C = w @ X
                fr = _hinge_frame(X)
                p4 += idx
                w4 += _r(w, 6)
                if fr is None:                               # a zero-length edge: no hinge to keep
                    k.append(0.0)
                    rest += [0.0, 0.0, 0.0]
                    continue
                e, nrm = fr
                b = np.cross(nrm, e)
                k.append(round(kk, 4))
                rest += _r([C @ e, C @ nrm, C @ b], 5)
            sets.append(dict(type='bend', name=cs['name'], p=p4, w=w4, k=k, rest=rest))
        elif c == 'hclLocalRangeConstraintSet':
            LC = cs['localConstraints']
            refbuf = cs['referenceMeshBufferIdx']
            to_particle = refbuf == pbuf
            refs = [l['referenceVertex'] if to_particle else skin_index(refbuf, l['referenceVertex']) for l in LC]
            if not to_particle and any(r_ < 0 for r_ in refs):
                sets.append(dict(type='none', name=cs['name'], cls=c))
                unsupported.append(c + ' (reference buffer)')
                continue
            sets.append(dict(type='range', name=cs['name'], p=[l['particleIndex'] for l in LC], ref=refs,
                             ref_particle=to_particle, max=_r([l['maximumDistance'] for l in LC]),
                             nmax=_r([l['maxNormalDistance'] for l in LC]), nmin=_r([l['minNormalDistance'] for l in LC]),
                             k=cs['stiffness'], normal=bool(cs['applyNormalComponent']), shape=cs['shapeType']))
        elif c == 'hclBonePlanesConstraintSet':
            BP = cs['bonePlanes']
            sets.append(dict(type='planes', name=cs['name'], p=[l['particleIndex'] for l in BP],
                             bone=[l['transformIndex'] for l in BP], plane=[round(float(x), 6) for l in BP for x in l['planeEquationBone']],
                             k=_r([l['stiffness'] for l in BP], 4)))
        else:                                                # volume constraints (a dozen coats): not solved yet
            sets.append(dict(type='none', name=cs['name'], cls=c))
            unsupported.append(c)
    # ---- collidables (capsules on body bones)
    ctm = sim['collidableTransformMap']
    cols = []
    for col, bi, off in zip(sim['perInstanceCollidables'], ctm['transformIndices'], ctm['offsets']):
        sh = col['shape']
        if sh is None or sh.f.get('__unknown'):
            cols.append(dict(kind='none'))
            continue
        if sh.cls == 'hclCapsuleShape':
            cols.append(dict(kind='capsule', name=col['name'], bone=bi, offset=[round(float(x), 6) for x in off],
                             a=_r(sh['start'][:3]), b=_r(sh['end'][:3]), ra=sh['radius'], rb=sh['radius']))
        elif sh.cls == 'hclTaperedCapsuleShape':
            cols.append(dict(kind='capsule', name=col['name'], bone=bi, offset=[round(float(x), 6) for x in off],
                             a=_r(sh['small'][:3]), b=_r(sh['big'][:3]), ra=sh['smallRadius'], rb=sh['bigRadius']))
        else:
            cols.append(dict(kind='none'))
            unsupported.append(sh.cls)
    masks = list(sim['staticCollisionMasks'])[:n]
    masks += [0] * (n - len(masks))
    c = dict(
        name=cd['name'], bones=names, parents=list(sk['parentIndices']), rest=[_cm(M) for M in W],
        skin=dict(entries=entries, count=len(order), n=sv_n, e=sv_e, w=sv_w, pos=sv_p, nrm=sv_nrm),
        particles=dict(count=n, inv=_r([p['invMass'] for p in pdat], 6), radius=_r([p['radius'] for p in pdat], 4),
                       friction=_r([p['friction'] for p in pdat], 3), pose=[round(float(x), 4) for q in pose for x in q],
                       anim=anim, fixed=fixed),
        triangles=tri, cloth_bones=bones_out, settings=settings, sets=sets, collidables=cols, masks=masks,
        unsupported=sorted(set(unsupported)))
    _check(c)
    return c


def _anim_by_rest(anim, pose, W, entries, sv_n, sv_e, sv_w, sv_p):
    """Particles the Animate state does not place (a cloth with one state only, e.g. the DLC03 Trapper outfit): the
    skinned vertex that sits on the particle's rest position, after the skin-to-pose offset of the particles already
    placed (a few vanilla files carry a constant offset of 0.1 to 1 unit)."""
    ents = [W[e['bone']] @ np.array(e['bfs'], float).reshape(4, 4).T for e in entries]
    S = len(sv_n)
    skin = np.zeros((S, 3))
    for v in range(S):
        M = sum(sv_w[4 * v + k] * ents[sv_e[4 * v + k]] for k in range(sv_n[v]))
        skin[v] = (M @ np.append(sv_p[3 * v:3 * v + 3], 1.0))[:3]
    P = np.array(pose, float)
    have = [p for p, a in enumerate(anim) if a >= 0]
    off = (skin[[anim[p] for p in have]] - P[have]).mean(0) if have else np.zeros(3)
    for p, a in enumerate(anim):
        if a < 0:
            d = np.linalg.norm(skin - off - P[p], axis=1)
            j = int(d.argmin())
            if d[j] < 0.01:
                anim[p] = j


def _check(c):
    """Every index the solver follows must point inside its array (a mod's damaged cloth would make cloth.js throw on
    every frame or go NaN); the solver loops must stay small."""
    nb, n = len(c['bones']), c['particles']['count']
    S, ne = c['skin']['count'], len(c['skin']['entries'])

    def within(idx, hi, what):
        for i in idx:
            if not 0 <= i < hi:
                raise ValueError('%s %d out of range (%d)' % (what, i, hi))
    if len(c['rest']) != nb or len(c['parents']) != nb:
        raise ValueError('skeleton: %d bones, %d rest matrices, %d parents' % (nb, len(c['rest']), len(c['parents'])))
    within([p + 1 for p in c['parents']], nb + 1, 'parent bone (+1)')
    within([e['bone'] for e in c['skin']['entries']], nb, 'skin bone')
    within(c['skin']['e'], max(ne, 1), 'skin entry')
    if len(c['particles']['pose']) != 3 * n:
        raise ValueError('rest pose of %d values for %d particles' % (len(c['particles']['pose']), n))
    within([a for a in c['particles']['anim'] if a != -1], S, 'skinned vertex')
    within([f[0] for f in c['particles']['fixed']], n, 'fixed particle')
    within([f[1] for f in c['particles']['fixed']], S, 'skinned vertex')
    within(c['triangles'], n, 'triangle particle')
    for b in c['cloth_bones']:
        if len(b['tri']) != 3:
            raise ValueError('cloth bone %d: triangle of %d particles' % (b['bone'], len(b['tri'])))
        within([b['bone']], nb, 'cloth bone')
        within(b['tri'], n, 'cloth bone particle')
    st = c['settings']
    within([st['transfer']['bone']], nb, 'transfer bone')
    if not (1 <= st['substeps'] <= 16 and 1 <= st['iterations'] <= 64):
        raise ValueError('%d substeps x %d iterations' % (st['substeps'], st['iterations']))
    within([x for x in st['execution'] if x != -1], len(c['sets']), 'constraint set')
    for s in c['sets']:
        t = s['type']
        if t in ('link', 'stretch', 'compress', 'bendlink'):
            within(s['a'], n, s['name'] + ' particle')
            within(s['b'], n, s['name'] + ' particle')
        elif t == 'bend':
            within(s['p'], n, s['name'] + ' particle')
        elif t == 'range':
            within(s['p'], n, s['name'] + ' particle')
            within(s['ref'], n if s['ref_particle'] else S, s['name'] + ' reference')
        elif t == 'planes':
            within(s['p'], n, s['name'] + ' particle')
            within(s['bone'], nb, s['name'] + ' bone')
    within([col['bone'] for col in c['collidables'] if col['kind'] == 'capsule'], nb, 'capsule bone')


def _hinge_frame(X):
    """Edge direction and mean normal of the two triangles of a bend link (A-B edge, C and D the wing tips); None for
    an edge of zero length."""
    e = X[1] - X[0]
    el = np.linalg.norm(e)
    if not el > 1e-9:
        return None
    e = e / el
    n1 = np.cross(X[1] - X[0], X[2] - X[0])
    n2 = np.cross(X[3] - X[0], X[1] - X[0])
    nn = n1 / (np.linalg.norm(n1) or 1.0) + n2 / (np.linalg.norm(n2) or 1.0)
    nn = nn - e * (nn @ e)
    nl = np.linalg.norm(nn)
    if nl < 1e-9:
        a = np.array([0.0, 0.0, 1.0]) if abs(e[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
        nn = np.cross(e, a)
        nl = np.linalg.norm(nn)
    return e, nn / nl


def scene_cloth(nif, log):
    """[decoded cloth] for build_scene; problems go to the scene log (the meshes still show, skinned to the rest)."""
    out = []
    for i, b in enumerate(blobs(nif)):
        try:
            c = decode(b)
            json.dumps(c, allow_nan=False)       # a NaN / Infinity would make the whole scene answer unreadable
            out.append(c)
            if c['unsupported']:
                log.append('cloth %s: not simulated yet: %s' % (c['name'], ', '.join(c['unsupported'])))
        except Exception as e:                                # one odd cloth never sinks the model
            log.append('cloth %d: failed: %s: %s' % (i, type(e).__name__, e))
    return out
