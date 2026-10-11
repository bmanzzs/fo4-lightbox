"""Read-only Havok 2014 (hk_2014.1.0-r1, x64) packfile reader for the cloth data in Fallout 4 NIFs (BSClothExtraData).

Class layouts come from the hkClassMember tables inside Fallout4.exe; the reader was checked by round-tripping vanilla
cloth blobs byte for byte (Backpacks of the Commonwealth's keychain tools, VaultTecBackpack_Remaster/Scripts hkpack.py /
hk2014_schema.py, where the writer lives). Only reading is needed here.
"""
import struct
from collections import OrderedDict

# ==================================================================================================== class layouts
# member tuple: (name, offset, kind, arg, carray)
#   kind: u8 i8 u16 i16 u32 i32 u64 f32 bool | vec4 quat mat3 mat4 xform qsxform | ptr (arg = pointee base class) |
#         strptr | struct (arg = struct name) | array (arg = element kind or 'struct:Name' / 'ptr')
#   carray: fixed C-array length (0 = scalar)

REFOBJ = [('vtable', 0x0, 'u64', None, 0), ('memSizeAndRefCount', 0x8, 'u32', None, 0)]

S = {}


def cls(name, size, align, members, parent=None, virtual=True):
    S[name] = dict(size=size, align=align, members=members, parent=parent, virtual=virtual)


# ---- containers / animation ------------------------------------------------------------------------
cls('hkRootLevelContainer::NamedVariant', 24, 8, [
    ('name', 0x0, 'strptr', None, 0), ('className', 0x8, 'strptr', None, 0), ('variant', 0x10, 'ptr', 'hkReferencedObject', 0)],
    virtual=False)
cls('hkRootLevelContainer', 16, 8, [('namedVariants', 0x0, 'array', 'struct:hkRootLevelContainer::NamedVariant', 0)], virtual=False)
cls('hkaBone', 16, 8, [('name', 0x0, 'strptr', None, 0), ('lockTranslation', 0x8, 'bool', None, 0)], virtual=False)
cls('hkaSkeleton::LocalFrameOnBone', 16, 8, [('localFrame', 0x0, 'ptr', 'hkLocalFrame', 0), ('boneIndex', 0x8, 'i16', None, 0)], virtual=False)
cls('hkaSkeleton::Partition', 16, 8, [('name', 0x0, 'strptr', None, 0), ('startBoneIndex', 0x8, 'i16', None, 0),
                                      ('numBones', 0xa, 'i16', None, 0)], virtual=False)
cls('hkaSkeleton', 0x88, 8, REFOBJ + [
    ('name', 0x10, 'strptr', None, 0), ('parentIndices', 0x18, 'array', 'i16', 0), ('bones', 0x28, 'array', 'struct:hkaBone', 0),
    ('referencePose', 0x38, 'array', 'qsxform', 0), ('referenceFloats', 0x48, 'array', 'f32', 0),
    ('floatSlots', 0x58, 'array', 'strptr', 0), ('localFrames', 0x68, 'array', 'struct:hkaSkeleton::LocalFrameOnBone', 0),
    ('partitions', 0x78, 'array', 'struct:hkaSkeleton::Partition', 0)])

# ---- cloth data -----------------------------------------------------------------------------------------
cls('hclClothData', 0x80, 8, REFOBJ + [
    ('name', 0x10, 'strptr', None, 0), ('simClothDatas', 0x18, 'array', 'ptr', 0), ('bufferDefinitions', 0x28, 'array', 'ptr', 0),
    ('transformSetDefinitions', 0x38, 'array', 'ptr', 0), ('operators', 0x48, 'array', 'ptr', 0),
    ('clothStateDatas', 0x58, 'array', 'ptr', 0), ('actions', 0x68, 'array', 'ptr', 0), ('targetPlatform', 0x78, 'u32', None, 0)])

cls('hclSimClothData::OverridableSimulationInfo', 32, 16, [
    ('gravity', 0x0, 'vec4', None, 0), ('globalDampingPerSecond', 0x10, 'f32', None, 0), ('collisionTolerance', 0x14, 'f32', None, 0),
    ('subSteps', 0x18, 'u32', None, 0), ('pinchDetectionEnabled', 0x1c, 'bool', None, 0),
    ('landscapeCollisionEnabled', 0x1d, 'bool', None, 0), ('transferMotionEnabled', 0x1e, 'bool', None, 0)], virtual=False)
cls('hclSimClothData::ParticleData', 16, 4, [
    ('mass', 0x0, 'f32', None, 0), ('invMass', 0x4, 'f32', None, 0), ('radius', 0x8, 'f32', None, 0), ('friction', 0xc, 'f32', None, 0)],
    virtual=False)
cls('hclSimClothData::CollidableTransformMap', 40, 8, [
    ('transformSetIndex', 0x0, 'i32', None, 0), ('transformIndices', 0x8, 'array', 'u32', 0), ('offsets', 0x18, 'array', 'mat4', 0)],
    virtual=False)
cls('hclSimClothData::CollidablePinchingData', 8, 4, [
    ('pinchDetectionEnabled', 0x0, 'bool', None, 0), ('pinchDetectionPriority', 0x1, 'i8', None, 0),
    ('pinchDetectionRadius', 0x4, 'f32', None, 0)], virtual=False)
cls('hclSimClothData::LandscapeCollisionData', 20, 4, [
    ('landscapeRadius', 0x0, 'f32', None, 0), ('enableStuckParticleDetection', 0x4, 'bool', None, 0),
    ('stuckParticlesStretchFactorSq', 0x8, 'f32', None, 0), ('pinchDetectionEnabled', 0xc, 'bool', None, 0),
    ('pinchDetectionPriority', 0xd, 'i8', None, 0), ('pinchDetectionRadius', 0x10, 'f32', None, 0)], virtual=False)
cls('hclSimClothData::TransferMotionData', 48, 4, [
    ('transformSetIndex', 0x0, 'u32', None, 0), ('transformIndex', 0x4, 'u32', None, 0),
    ('transferTranslationMotion', 0x8, 'bool', None, 0), ('minTranslationSpeed', 0xc, 'f32', None, 0),
    ('maxTranslationSpeed', 0x10, 'f32', None, 0), ('minTranslationBlend', 0x14, 'f32', None, 0),
    ('maxTranslationBlend', 0x18, 'f32', None, 0), ('transferRotationMotion', 0x1c, 'bool', None, 0),
    ('minRotationSpeed', 0x20, 'f32', None, 0), ('maxRotationSpeed', 0x24, 'f32', None, 0),
    ('minRotationBlend', 0x28, 'f32', None, 0), ('maxRotationBlend', 0x2c, 'f32', None, 0)], virtual=False)
cls('hclSimClothData', 0x180, 16, REFOBJ + [
    ('simulationInfo', 0x10, 'struct', 'hclSimClothData::OverridableSimulationInfo', 0), ('name', 0x30, 'strptr', None, 0),
    ('particleDatas', 0x38, 'array', 'struct:hclSimClothData::ParticleData', 0), ('fixedParticles', 0x48, 'array', 'u16', 0),
    ('triangleIndices', 0x58, 'array', 'u16', 0), ('triangleFlips', 0x68, 'array', 'u8', 0), ('totalMass', 0x78, 'f32', None, 0),
    ('collidableTransformMap', 0x80, 'struct', 'hclSimClothData::CollidableTransformMap', 0),
    ('perInstanceCollidables', 0xa8, 'array', 'ptr', 0), ('staticConstraintSets', 0xb8, 'array', 'ptr', 0),
    ('antiPinchConstraintSets', 0xc8, 'array', 'ptr', 0), ('simClothPoses', 0xd8, 'array', 'ptr', 0),
    ('actions', 0xe8, 'array', 'ptr', 0), ('staticCollisionMasks', 0xf8, 'array', 'u32', 0),
    ('perParticlePinchDetectionEnabledFlags', 0x108, 'array', 'bool', 0),
    ('collidablePinchingDatas', 0x118, 'array', 'struct:hclSimClothData::CollidablePinchingData', 0),
    ('minPinchedParticleIndex', 0x128, 'u16', None, 0), ('maxPinchedParticleIndex', 0x12a, 'u16', None, 0),
    ('maxCollisionPairs', 0x12c, 'u32', None, 0), ('maxParticleRadius', 0x130, 'f32', None, 0),
    ('landscapeCollisionData', 0x134, 'struct', 'hclSimClothData::LandscapeCollisionData', 0),
    ('numLandscapeCollidableParticles', 0x148, 'u32', None, 0), ('doNormals', 0x14c, 'bool', None, 0),
    ('transferMotionData', 0x150, 'struct', 'hclSimClothData::TransferMotionData', 0)])

cls('hclSimClothPose', 0x30, 16, REFOBJ + [('name', 0x10, 'strptr', None, 0), ('positions', 0x18, 'array', 'vec4', 0)])

# ---- collidables ---------------------------------------------------------------------------------------
cls('hclCollidable', 0x90, 16, REFOBJ + [
    ('name', 0x10, 'strptr', None, 0), ('transform', 0x20, 'xform', None, 0), ('linearVelocity', 0x60, 'vec4', None, 0),
    ('angularVelocity', 0x70, 'vec4', None, 0), ('pinchDetectionEnabled', 0x80, 'bool', None, 0),
    ('pinchDetectionPriority', 0x81, 'i8', None, 0), ('pinchDetectionRadius', 0x84, 'f32', None, 0),
    ('shape', 0x88, 'ptr', 'hclShape', 0)])
SHAPE = REFOBJ + [('type', 0x10, 'i32', None, 0)]
cls('hclCapsuleShape', 0x60, 16, SHAPE + [
    ('start', 0x20, 'vec4', None, 0), ('end', 0x30, 'vec4', None, 0), ('dir', 0x40, 'vec4', None, 0), ('radius', 0x50, 'f32', None, 0),
    ('capLenSqrdInv', 0x54, 'f32', None, 0)])

# ---- constraint sets ------------------------------------------------------------------------------------
CSET = REFOBJ + [('name', 0x10, 'strptr', None, 0), ('constraintId', 0x18, 'u32', None, 0), ('type', 0x1c, 'u32', None, 0)]
cls('hclStandardLinkConstraintSet::Link', 12, 4, [
    ('particleA', 0x0, 'u16', None, 0), ('particleB', 0x2, 'u16', None, 0), ('restLength', 0x4, 'f32', None, 0),
    ('stiffness', 0x8, 'f32', None, 0)], virtual=False)
cls('hclStandardLinkConstraintSet', 0x30, 8, CSET + [('links', 0x20, 'array', 'struct:hclStandardLinkConstraintSet::Link', 0)])
cls('hclStretchLinkConstraintSet::Link', 12, 4, [
    ('particleA', 0x0, 'u16', None, 0), ('particleB', 0x2, 'u16', None, 0), ('restLength', 0x4, 'f32', None, 0),
    ('stiffness', 0x8, 'f32', None, 0)], virtual=False)
cls('hclStretchLinkConstraintSet', 0x30, 8, CSET + [('links', 0x20, 'array', 'struct:hclStretchLinkConstraintSet::Link', 0)])
cls('hclBendStiffnessConstraintSet::Link', 32, 4, [
    ('weightA', 0x0, 'f32', None, 0), ('weightB', 0x4, 'f32', None, 0), ('weightC', 0x8, 'f32', None, 0), ('weightD', 0xc, 'f32', None, 0),
    ('bendStiffness', 0x10, 'f32', None, 0), ('restCurvature', 0x14, 'f32', None, 0), ('particleA', 0x18, 'u16', None, 0),
    ('particleB', 0x1a, 'u16', None, 0), ('particleC', 0x1c, 'u16', None, 0), ('particleD', 0x1e, 'u16', None, 0)], virtual=False)
cls('hclBendStiffnessConstraintSet', 0x38, 8, CSET + [
    ('links', 0x20, 'array', 'struct:hclBendStiffnessConstraintSet::Link', 0), ('useRestPoseConfig', 0x30, 'bool', None, 0)])
cls('hclLocalRangeConstraintSet::LocalConstraint', 16, 4, [
    ('particleIndex', 0x0, 'u16', None, 0), ('referenceVertex', 0x2, 'u16', None, 0), ('maximumDistance', 0x4, 'f32', None, 0),
    ('maxNormalDistance', 0x8, 'f32', None, 0), ('minNormalDistance', 0xc, 'f32', None, 0)], virtual=False)
cls('hclLocalRangeConstraintSet', 0x40, 8, CSET + [
    ('localConstraints', 0x20, 'array', 'struct:hclLocalRangeConstraintSet::LocalConstraint', 0),
    ('referenceMeshBufferIdx', 0x30, 'u32', None, 0), ('stiffness', 0x34, 'f32', None, 0), ('shapeType', 0x38, 'u32', None, 0),
    ('applyNormalComponent', 0x3c, 'bool', None, 0)])

# ---- buffers / transform sets / states -----------------------------------------------------------------------
cls('hclBufferLayout::BufferElement', 4, 1, [
    ('vectorConversion', 0x0, 'u8', None, 0), ('vectorSize', 0x1, 'u8', None, 0), ('slotId', 0x2, 'u8', None, 0),
    ('slotStart', 0x3, 'u8', None, 0)], virtual=False)
cls('hclBufferLayout::Slot', 2, 1, [('flags', 0x0, 'u8', None, 0), ('stride', 0x1, 'u8', None, 0)], virtual=False)
cls('hclBufferLayout', 26, 1, [
    ('elementsLayout', 0x0, 'struct', 'hclBufferLayout::BufferElement', 4), ('slots', 0x10, 'struct', 'hclBufferLayout::Slot', 4),
    ('numSlots', 0x18, 'u8', None, 0), ('triangleFormat', 0x19, 'u8', None, 0)], virtual=False)
BUFDEF = REFOBJ + [
    ('name', 0x10, 'strptr', None, 0), ('type', 0x18, 'i32', None, 0), ('subType', 0x1c, 'i32', None, 0),
    ('numVertices', 0x20, 'u32', None, 0), ('numTriangles', 0x24, 'u32', None, 0),
    ('bufferLayout', 0x28, 'struct', 'hclBufferLayout', 0)]
cls('hclBufferDefinition', 0x48, 8, BUFDEF)
cls('hclScratchBufferDefinition', 0x60, 8, BUFDEF + [
    ('triangleIndices', 0x48, 'array', 'u16', 0), ('storeNormals', 0x58, 'bool', None, 0),
    ('storeTangentsAndBiTangents', 0x59, 'bool', None, 0)])
cls('hclTransformSetDefinition', 0x20, 8, REFOBJ + [
    ('name', 0x10, 'strptr', None, 0), ('type', 0x18, 'i32', None, 0), ('numTransforms', 0x1c, 'u32', None, 0)])

cls('hclBufferUsage', 5, 1, [('perComponentFlags', 0x0, 'u8', None, 4), ('trianglesRead', 0x4, 'bool', None, 0)], virtual=False)
cls('hkBitFieldStorage', 0x18, 8, [('words', 0x0, 'array', 'u32', 0), ('numBits', 0x10, 'i32', None, 0)], virtual=False)
cls('hkBitField', 0x18, 8, [('storage', 0x0, 'struct', 'hkBitFieldStorage', 0)], virtual=False)
cls('hclTransformSetUsage::TransformTracker', 72, 8, [
    ('read', 0x0, 'struct', 'hkBitField', 0), ('readBeforeWrite', 0x18, 'struct', 'hkBitField', 0),
    ('written', 0x30, 'struct', 'hkBitField', 0)], virtual=False)
cls('hclTransformSetUsage', 24, 8, [
    ('perComponentFlags', 0x0, 'u8', None, 2),
    ('perComponentTransformTrackers', 0x8, 'array', 'struct:hclTransformSetUsage::TransformTracker', 0)], virtual=False)
cls('hclClothState::BufferAccess', 16, 4, [
    ('bufferIndex', 0x0, 'u32', None, 0), ('bufferUsage', 0x4, 'struct', 'hclBufferUsage', 0),
    ('shadowBufferIndex', 0xc, 'u32', None, 0)], virtual=False)
cls('hclClothState::TransformSetAccess', 32, 8, [
    ('transformSetIndex', 0x0, 'u32', None, 0), ('transformSetUsage', 0x8, 'struct', 'hclTransformSetUsage', 0)], virtual=False)
cls('hclClothState', 0x58, 8, REFOBJ + [
    ('name', 0x10, 'strptr', None, 0), ('operators', 0x18, 'array', 'u32', 0),
    ('usedBuffers', 0x28, 'array', 'struct:hclClothState::BufferAccess', 0),
    ('usedTransformSets', 0x38, 'array', 'struct:hclClothState::TransformSetAccess', 0),
    ('usedSimCloths', 0x48, 'array', 'u32', 0)])

# ---- operators ------------------------------------------------------------------------------------------
OP = REFOBJ + [('name', 0x10, 'strptr', None, 0), ('operatorID', 0x18, 'u32', None, 0), ('type', 0x1c, 'u32', None, 0)]
cls('hclObjectSpaceDeformer::FourBlendEntryBlock', 224, 2, [
    ('vertexIndices', 0x0, 'u16', None, 16), ('boneIndices', 0x20, 'u16', None, 64), ('boneWeights', 0xa0, 'u8', None, 64)], virtual=False)
cls('hclObjectSpaceDeformer::ThreeBlendEntryBlock', 176, 2, [
    ('vertexIndices', 0x0, 'u16', None, 16), ('boneIndices', 0x20, 'u16', None, 48), ('boneWeights', 0x80, 'u8', None, 48)], virtual=False)
cls('hclObjectSpaceDeformer::TwoBlendEntryBlock', 128, 2, [
    ('vertexIndices', 0x0, 'u16', None, 16), ('boneIndices', 0x20, 'u16', None, 32), ('boneWeights', 0x60, 'u8', None, 32)], virtual=False)
cls('hclObjectSpaceDeformer::OneBlendEntryBlock', 64, 2, [
    ('vertexIndices', 0x0, 'u16', None, 16), ('boneIndices', 0x20, 'u16', None, 16)], virtual=False)
cls('hclObjectSpaceDeformer', 88, 8, [
    ('fourBlendEntries', 0x0, 'array', 'struct:hclObjectSpaceDeformer::FourBlendEntryBlock', 0),
    ('threeBlendEntries', 0x10, 'array', 'struct:hclObjectSpaceDeformer::ThreeBlendEntryBlock', 0),
    ('twoBlendEntries', 0x20, 'array', 'struct:hclObjectSpaceDeformer::TwoBlendEntryBlock', 0),
    ('oneBlendEntries', 0x30, 'array', 'struct:hclObjectSpaceDeformer::OneBlendEntryBlock', 0),
    ('controlBytes', 0x40, 'array', 'u8', 0), ('startVertexIndex', 0x50, 'u16', None, 0), ('endVertexIndex', 0x52, 'u16', None, 0),
    ('batchSizeSpu', 0x54, 'u16', None, 0), ('partialWrite', 0x56, 'bool', None, 0)], virtual=False)
cls('hclObjectSpaceDeformer::LocalBlockPN', 256, 2, [
    ('localPosition', 0x0, 'packedvec3', None, 16), ('localNormal', 0x80, 'packedvec3', None, 16)], virtual=False)
cls('hclObjectSpaceDeformer::LocalBlockUnpackedPN', 512, 16, [
    ('localPosition', 0x0, 'vec4', None, 16), ('localNormal', 0x100, 'vec4', None, 16)], virtual=False)
OSSKIN = OP + [
    ('boneFromSkinMeshTransforms', 0x20, 'array', 'mat4', 0), ('transformSubset', 0x30, 'array', 'u16', 0),
    ('outputBufferIndex', 0x40, 'u32', None, 0), ('transformSetIndex', 0x44, 'u32', None, 0),
    ('objectSpaceDeformer', 0x48, 'struct', 'hclObjectSpaceDeformer', 0)]
cls('hclObjectSpaceSkinPNOperator', 0xc0, 8, OSSKIN + [
    ('localPNs', 0xa0, 'array', 'struct:hclObjectSpaceDeformer::LocalBlockPN', 0),
    ('localUnpackedPNs', 0xb0, 'array', 'struct:hclObjectSpaceDeformer::LocalBlockUnpackedPN', 0)])
cls('hclMoveParticlesOperator::VertexParticlePair', 4, 2, [
    ('vertexIndex', 0x0, 'u16', None, 0), ('particleIndex', 0x2, 'u16', None, 0)], virtual=False)
cls('hclMoveParticlesOperator', 0x38, 8, OP + [
    ('vertexParticlePairs', 0x20, 'array', 'struct:hclMoveParticlesOperator::VertexParticlePair', 0),
    ('simClothIndex', 0x30, 'u32', None, 0), ('refBufferIdx', 0x34, 'u32', None, 0)])
cls('hclSimulateOperator', 0x48, 8, OP + [
    ('simClothIndex', 0x20, 'u32', None, 0), ('subSteps', 0x24, 'u32', None, 0), ('numberOfSolveIterations', 0x28, 'i32', None, 0),
    ('constraintExecution', 0x30, 'array', 'i32', 0), ('adaptConstraintStiffness', 0x40, 'bool', None, 0)])
cls('hclSimpleMeshBoneDeformOperator::TriangleBonePair', 4, 2, [
    ('boneOffset', 0x0, 'u16', None, 0), ('triangleOffset', 0x2, 'u16', None, 0)], virtual=False)
cls('hclSimpleMeshBoneDeformOperator', 0x48, 8, OP + [
    ('inputBufferIdx', 0x20, 'u32', None, 0), ('outputTransformSetIdx', 0x24, 'u32', None, 0),
    ('triangleBonePairs', 0x28, 'array', 'struct:hclSimpleMeshBoneDeformOperator::TriangleBonePair', 0),
    ('localBoneTransforms', 0x38, 'array', 'mat4', 0)])
cls('hclGatherAllVerticesOperator', 0x40, 8, OP + [
    ('vertexInputFromVertexOutput', 0x20, 'array', 'i16', 0), ('inputBufferIdx', 0x30, 'u32', None, 0),
    ('outputBufferIdx', 0x34, 'u32', None, 0), ('gatherNormals', 0x38, 'bool', None, 0), ('partialGather', 0x39, 'bool', None, 0)])
cls('hclCopyVerticesOperator', 0x38, 8, OP + [
    ('inputBufferIdx', 0x20, 'u32', None, 0), ('outputBufferIdx', 0x24, 'u32', None, 0), ('numberOfVertices', 0x28, 'u32', None, 0),
    ('startVertexIn', 0x2c, 'u32', None, 0), ('startVertexOut', 0x30, 'u32', None, 0), ('copyNormals', 0x34, 'bool', None, 0)])

PRIM = {'u8': ('<B', 1), 'i8': ('<b', 1), 'bool': ('<B', 1), 'u16': ('<H', 2), 'i16': ('<h', 2), 'u32': ('<I', 4),
        'i32': ('<i', 4), 'u64': ('<Q', 8), 'f32': ('<f', 4), 'vec4': ('<4f', 16), 'quat': ('<4f', 16), 'mat3': ('<12f', 48),
        'mat4': ('<16f', 64), 'xform': ('<16f', 64), 'qsxform': ('<12f', 48), 'packedvec3': ('<4h', 8)}
ALIGN = {'u8': 1, 'i8': 1, 'bool': 1, 'u16': 2, 'i16': 2, 'u32': 4, 'i32': 4, 'u64': 8, 'f32': 4, 'vec4': 16, 'quat': 16,
         'mat3': 16, 'mat4': 16, 'xform': 16, 'qsxform': 16, 'packedvec3': 2, 'ptr': 8, 'strptr': 8}


def elem_size(kind):
    if kind.startswith('struct:'):
        return S[kind[7:]]['size']
    if kind in ('ptr', 'strptr'):
        return 8
    return PRIM[kind][1]

# ---- added after the batch round-trip test ---------------------------------------------------------------
cls('hclTaperedCapsuleShape', 0xb0, 16, SHAPE + [
    ('small', 0x20, 'vec4', None, 0), ('big', 0x30, 'vec4', None, 0), ('coneApex', 0x40, 'vec4', None, 0),
    ('coneAxis', 0x50, 'vec4', None, 0), ('lVec', 0x60, 'vec4', None, 0), ('dVec', 0x70, 'vec4', None, 0),
    ('tanThetaVecNeg', 0x80, 'vec4', None, 0), ('smallRadius', 0x90, 'f32', None, 0), ('bigRadius', 0x94, 'f32', None, 0),
    ('l', 0x98, 'f32', None, 0), ('d', 0x9c, 'f32', None, 0), ('cosTheta', 0xa0, 'f32', None, 0), ('sinTheta', 0xa4, 'f32', None, 0),
    ('tanTheta', 0xa8, 'f32', None, 0), ('tanThetaSqr', 0xac, 'f32', None, 0)])
cls('hclBendLinkConstraintSet::Link', 20, 4, [
    ('particleA', 0x0, 'u16', None, 0), ('particleB', 0x2, 'u16', None, 0), ('bendMinLength', 0x4, 'f32', None, 0),
    ('stretchMaxLength', 0x8, 'f32', None, 0), ('bendStiffness', 0xc, 'f32', None, 0), ('stretchStiffness', 0x10, 'f32', None, 0)],
    virtual=False)
cls('hclBendLinkConstraintSet', 0x30, 8, CSET + [('links', 0x20, 'array', 'struct:hclBendLinkConstraintSet::Link', 0)])
cls('hclVolumeConstraintMx::FrameBatchData', 352, 16, [
    ('frameVector', 0x0, 'vec4', None, 16), ('particleIndex', 0x100, 'u16', None, 16), ('weight', 0x120, 'f32', None, 16)], virtual=False)
cls('hclVolumeConstraintMx::FrameSingleData', 32, 16, [
    ('frameVector', 0x0, 'vec4', None, 0), ('particleIndex', 0x10, 'u16', None, 0), ('weight', 0x14, 'f32', None, 0)], virtual=False)
cls('hclVolumeConstraintMx::ApplyBatchData', 352, 16, [
    ('frameVector', 0x0, 'vec4', None, 16), ('particleIndex', 0x100, 'u16', None, 16), ('stiffness', 0x120, 'f32', None, 16)], virtual=False)
cls('hclVolumeConstraintMx::ApplySingleData', 32, 16, [
    ('frameVector', 0x0, 'vec4', None, 0), ('particleIndex', 0x10, 'u16', None, 0), ('stiffness', 0x14, 'f32', None, 0)], virtual=False)
cls('hclVolumeConstraintMx', 0x60, 8, CSET + [
    ('frameBatchDatas', 0x20, 'array', 'struct:hclVolumeConstraintMx::FrameBatchData', 0),
    ('frameSingleDatas', 0x30, 'array', 'struct:hclVolumeConstraintMx::FrameSingleData', 0),
    ('applyBatchDatas', 0x40, 'array', 'struct:hclVolumeConstraintMx::ApplyBatchData', 0),
    ('applySingleDatas', 0x50, 'array', 'struct:hclVolumeConstraintMx::ApplySingleData', 0)])

# ---- added for FO4 Lightbox (layouts from the same Fallout4.exe member tables): lab coats, Hooded Rags ------------------
cls('hclCompressibleLinkConstraintSet::Link', 16, 4, [
    ('particleA', 0x0, 'u16', None, 0), ('particleB', 0x2, 'u16', None, 0), ('restLength', 0x4, 'f32', None, 0),
    ('compressionLength', 0x8, 'f32', None, 0), ('stiffness', 0xc, 'f32', None, 0)], virtual=False)
cls('hclCompressibleLinkConstraintSet', 0x30, 8, CSET + [
    ('links', 0x20, 'array', 'struct:hclCompressibleLinkConstraintSet::Link', 0)])
cls('hclBonePlanesConstraintSet::BonePlane', 32, 16, [
    ('planeEquationBone', 0x0, 'vec4', None, 0), ('particleIndex', 0x10, 'u16', None, 0),
    ('transformIndex', 0x12, 'u16', None, 0), ('stiffness', 0x14, 'f32', None, 0)], virtual=False)
cls('hclGatherSomeVerticesOperator::VertexPair', 4, 2, [
    ('indexInput', 0x0, 'u16', None, 0), ('indexOutput', 0x2, 'u16', None, 0)], virtual=False)
cls('hclGatherSomeVerticesOperator', 0x40, 8, OP + [
    ('vertexPairs', 0x20, 'array', 'struct:hclGatherSomeVerticesOperator::VertexPair', 0),
    ('inputBufferIdx', 0x30, 'u32', None, 0), ('outputBufferIdx', 0x34, 'u32', None, 0), ('gatherNormals', 0x38, 'bool', None, 0)])
cls('hclBonePlanesConstraintSet', 0x38, 8, CSET + [
    ('bonePlanes', 0x20, 'array', 'struct:hclBonePlanesConstraintSet::BonePlane', 0),
    ('transformSetIndex', 0x30, 'u32', None, 0)])


# ==================================================================================================== reading
MAGIC = (0x57E0E057, 0x10C0C010)


class HkObj:
    __slots__ = ('cls', 'f', 'src_off')

    def __init__(self, cls, fields=None, src_off=None):
        self.cls = cls
        self.f = fields if fields is not None else OrderedDict()
        self.src_off = src_off

    def __getitem__(self, k):
        return self.f[k]

    def __setitem__(self, k, v):
        self.f[k] = v

    def __repr__(self):
        nm = self.f.get('name')
        return f'<{self.cls} {nm!r}>' if nm else f'<{self.cls}>'


def al(x, a):
    return (x + a - 1) // a * a


# ------------------------------------------------------------------------------------------------ reading
class Packfile:
    def __init__(self, data):
        self.data = data
        m0, m1 = struct.unpack_from('<II', data, 0)
        assert (m0, m1) == MAGIC, 'not a packfile'
        (self.user_tag, self.file_version) = struct.unpack_from('<ii', data, 8)
        self.layout = data[0x10:0x14]
        (self.nsec, self.contents_sec, self.contents_off, self.cn_sec, self.cn_off) = struct.unpack_from('<5i', data, 0x14)
        self.version = data[0x28:0x38]
        self.flags, self.maxpred, self.predsize = struct.unpack_from('<IHH', data, 0x38)
        self.pred = data[0x40:0x40 + self.predsize]
        o = 0x40 + self.predsize
        self.sections = []
        for i in range(self.nsec):
            tag = data[o:o + 20]
            vals = struct.unpack_from('<7i', data, o + 20)
            self.sections.append(dict(tag=tag.split(b'\0')[0].decode(), raw_tag=tag, abs=vals[0], local=vals[1], glob=vals[2],
                                      virt=vals[3], exports=vals[4], imports=vals[5], end=vals[6], pad=data[o + 48:o + 64]))
            o += 64
        cn = self.sections[0]
        self.classnames = OrderedDict()   # offset -> (name, signature)
        p = cn['abs']; e = cn['abs'] + cn['local']
        while p + 5 < e:
            sig, = struct.unpack_from('<I', data, p)
            if data[p + 4] != 9:
                break
            z = data.index(b'\0', p + 5)
            self.classnames[p + 5 - cn['abs']] = (data[p + 5:z].decode(), sig)
            p = z + 1
        d = self.sections[2]
        self.d = d
        self.ds = d['abs']
        self.local = {}
        for q in range(d['abs'] + d['local'], d['abs'] + d['glob'] - 7, 8):
            s, t = struct.unpack_from('<ii', data, q)
            if s == -1:
                continue
            self.local[s] = t
        self.glob = {}
        for q in range(d['abs'] + d['glob'], d['abs'] + d['virt'] - 11, 12):
            s, sec, t = struct.unpack_from('<iii', data, q)
            if s == -1:
                continue
            self.glob[s] = (sec, t)
        self.virt = OrderedDict()
        for q in range(d['abs'] + d['virt'], d['abs'] + d['exports'] - 11, 12):
            s, sec, t = struct.unpack_from('<iii', data, q)
            if s == -1:
                continue
            self.virt[s] = self.classnames[t][0]
        self.objs = {}

    def sig(self, name):
        for off, (n, s) in self.classnames.items():
            if n == name:
                return s
        return None

    def cstr(self, rel):
        a = self.ds + rel
        z = self.data.index(b'\0', a)
        return self.data[a:z].decode('latin-1')

    def read_prim(self, kind, rel):
        fmt, n = PRIM[kind]
        v = struct.unpack_from(fmt, self.data, self.ds + rel)
        if kind in ('bool',):
            return v[0]
        return v[0] if len(v) == 1 else list(v)

    def read_value(self, kind, arg, rel, carray):
        if carray:
            sz = S[arg]['size'] if kind == 'struct' else (8 if kind in ('ptr', 'strptr') else PRIM[kind][1])
            return [self.read_value(kind, arg, rel + i * sz, 0) for i in range(carray)]
        if kind == 'struct':
            return self.read_struct(arg, rel)
        if kind == 'ptr':
            g = self.glob.get(rel)
            if g is None:
                assert struct.unpack_from('<Q', self.data, self.ds + rel)[0] == 0
                return None
            return self.obj(g[1])
        if kind == 'strptr':
            t = self.local.get(rel)
            return None if t is None else self.cstr(t)
        if kind == 'array':
            size, capflags = struct.unpack_from('<ii', self.data, self.ds + rel + 8)
            t = self.local.get(rel)
            if size == 0:
                return []
            assert t is not None, ('array without fixup', rel)
            ek = arg
            es = elem_size(ek)
            # a corrupt size would loop for minutes (pointer elements read nothing that could run out): the array must
            # lie inside the data
            if size < 0 or t < 0 or self.ds + t + size * es > len(self.data):
                raise ValueError('array of %d x %d bytes at %#x runs past the data' % (size, es, t))
            out = []
            for i in range(size):
                er = t + i * es
                if ek.startswith('struct:'):
                    out.append(self.read_struct(ek[7:], er))
                elif ek == 'ptr':
                    g = self.glob.get(er)
                    out.append(self.obj(g[1]) if g else None)
                elif ek == 'strptr':
                    lt = self.local.get(er)
                    out.append(None if lt is None else self.cstr(lt))
                else:
                    out.append(self.read_prim(ek, er))
            return out
        return self.read_prim(kind, rel)

    def read_struct(self, name, rel):
        sch = S[name]
        out = OrderedDict()
        for (mn, mo, kind, arg, carr) in sch['members']:
            if mn in ('vtable', 'memSizeAndRefCount'):
                continue
            out[mn] = self.read_value(kind, arg, rel + mo, carr)
        return out

    def obj(self, rel):
        if rel in self.objs:
            return self.objs[rel]
        cname = self.virt.get(rel)
        if cname is None:
            raise KeyError('no object at %#x' % rel)
        o = HkObj(cname, None, rel)
        self.objs[rel] = o
        if cname not in S:                     # a class without a layout here: known by name only (callers skip it)
            o.f['__unknown'] = True
            return o
        o.f = self.read_struct(cname, rel)
        return o

    def root(self):
        return self.obj(self.contents_off)
