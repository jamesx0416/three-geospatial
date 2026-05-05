import {
  Rectangle,
  type RectangleLike,
  type WaterOccurrenceClass,
  type WaterOccurrenceClassification,
  type WaterOccurrenceTileClassifier
} from '@takram/three-geospatial'
import type { Tile, TilesRenderer } from '3d-tiles-renderer'
import {
  Box3,
  BufferAttribute,
  type BufferGeometry,
  Color,
  Matrix4,
  Sphere,
  type Texture,
  Vector3,
  type Material,
  type Object3D
} from 'three'

type RegionArray = readonly [number, number, number, number, ...number[]]

interface TileViewErrorTarget {
  inView: boolean
  error: number
  distance: number
}

interface EllipsoidRegionLike {
  readonly latStart: number
  readonly latEnd: number
  readonly lonStart: number
  readonly lonEnd: number
}

interface TileBoundingVolumeLike {
  readonly region?: EllipsoidRegionLike | null
  getOBB?: (box: Box3, matrix: Matrix4) => void
  getSphere?: (sphere: Sphere) => void
}

interface EllipsoidLike {
  getPositionToCartographic: (
    position: Vector3,
    target: CartographicLike
  ) => CartographicLike
}

interface CartographicLike {
  lat: number
  lon: number
  height: number
}

type TileWithRegion = Tile & {
  readonly boundingVolume?: {
    readonly region?: RegionArray
  }
  readonly engineData?: {
    readonly boundingVolume?: TileBoundingVolumeLike | null
    readonly scene?: Object3D | null
  }
}

interface DebugStats {
  classified: number
  missingRectangles: number
  viewChecks: number
  colored: number
  maxWaterFraction: number
  maxValidFraction: number
  classes: Record<WaterOccurrenceClass, number>
}

type Object3DWithMaterial = Object3D & {
  material?: Material | Material[]
}

type Object3DWithGeometryMaterial = Object3DWithMaterial & {
  geometry?: BufferGeometry
  isMesh?: boolean
}

type MaterialWithColor = Material & {
  color?: Color
  emissive?: Color
  emissiveIntensity?: number
  map?: unknown
  toneMapped?: boolean
}

interface WaterMaskShader {
  uniforms: Record<string, { value: unknown }>
  vertexShader: string
  fragmentShader: string
}

const boxScratch = /*#__PURE__*/ new Box3()
const matrixScratch = /*#__PURE__*/ new Matrix4()
const waterMaskMatrixScratch = /*#__PURE__*/ new Matrix4()
const waterMaskCenterScratch = /*#__PURE__*/ new Vector3()
const sphereScratch = /*#__PURE__*/ new Sphere()
const vectorScratch = /*#__PURE__*/ new Vector3()
const cartographicScratch: CartographicLike = { lat: 0, lon: 0, height: 0 }
const TWO_PI = Math.PI * 2
const RADIANS_TO_DEGREES = 180 / Math.PI
const TILE_COLOR = /*#__PURE__*/ new Color(0xff0000)

export interface WaterOccurrenceTilesPluginOptions {
  readonly classifier: WaterOccurrenceTileClassifier
  readonly coloredClasses?: readonly WaterOccurrenceClass[]
  readonly culledClasses?: readonly WaterOccurrenceClass[]
  readonly maskedClasses?: readonly WaterOccurrenceClass[]
  readonly maskAllIntersectingTiles?: boolean
  readonly maskTexture?: Texture
  readonly maskRectangle?: RectangleLike
  readonly maskWaterThreshold?: number
  readonly maskAlphaThreshold?: number
  readonly minimumWaterFraction?: number
  readonly minimumValidFraction?: number
  readonly maximumCullRectangleWidth?: number
  readonly maximumCullRectangleHeight?: number
  readonly maximumCullScanSamples?: number
  readonly allowApproximateTileCull?: boolean
  readonly maximumMaskRectangleWidth?: number
  readonly maximumMaskRectangleHeight?: number
  readonly maximumColorRectangleWidth?: number
  readonly maximumColorRectangleHeight?: number
  readonly colorSampleGridSize?: number
  readonly debug?: boolean
  readonly debugLogLevel?: 'debug' | 'info'
  readonly maxDebugLogs?: number
  readonly onTileClassified?: (
    tile: Tile,
    classification: WaterOccurrenceClassification
  ) => void
}

export class WaterOccurrenceTilesPlugin {
  readonly name = 'WATER_OCCURRENCE_TILES_PLUGIN'
  readonly classifier: WaterOccurrenceTileClassifier
  readonly coloredClasses: ReadonlySet<WaterOccurrenceClass>
  readonly culledClasses: ReadonlySet<WaterOccurrenceClass>
  readonly maskedClasses: ReadonlySet<WaterOccurrenceClass>
  readonly maskAllIntersectingTiles: boolean
  readonly maskTexture?: Texture
  readonly maskRectangle: Rectangle
  readonly maskWaterThreshold: number
  readonly maskAlphaThreshold: number
  readonly onTileClassified?: (
    tile: Tile,
    classification: WaterOccurrenceClassification
  ) => void
  readonly minimumWaterFraction?: number
  readonly minimumValidFraction: number
  readonly maximumCullRectangleWidth: number
  readonly maximumCullRectangleHeight: number
  readonly maximumCullScanSamples: number
  readonly allowApproximateTileCull: boolean
  readonly maximumMaskRectangleWidth: number
  readonly maximumMaskRectangleHeight: number
  readonly maximumColorRectangleWidth: number
  readonly maximumColorRectangleHeight: number
  readonly colorSampleGridSize: number
  readonly debug: boolean
  readonly debugLogLevel: 'debug' | 'info'
  readonly maxDebugLogs: number

  tiles?: TilesRenderer

  private classifications = new WeakMap<
    Tile,
    WaterOccurrenceClassification | null
  >()
  private readonly classificationRectangles = new WeakMap<Tile, Rectangle>()
  private readonly rectangle = new Rectangle()
  private readonly coloredTiles = new WeakSet<Tile>()
  private readonly maskedMaterials = new WeakMap<Material, Material>()
  private readonly cullableTiles = new WeakMap<Tile, boolean>()
  private debugLogCount = 0
  private colorSetLogCount = 0
  private colorPendingLogCount = 0
  private readonly debugStats: DebugStats = {
    classified: 0,
    missingRectangles: 0,
    viewChecks: 0,
    colored: 0,
    maxWaterFraction: 0,
    maxValidFraction: 0,
    classes: {
      land: 0,
      water: 0,
      shoreline: 0,
      unknown: 0
    }
  }

  constructor(options: WaterOccurrenceTilesPluginOptions) {
    const {
      classifier,
      coloredClasses,
      culledClasses = ['water'],
      maskedClasses = ['shoreline'],
      maskAllIntersectingTiles = false,
      maskTexture,
      maskRectangle = classifier.raster.rectangle,
      maskWaterThreshold = 0.5,
      maskAlphaThreshold = 0.5,
      minimumWaterFraction,
      minimumValidFraction = 1,
      maximumCullRectangleWidth = Infinity,
      maximumCullRectangleHeight = Infinity,
      maximumCullScanSamples = 65536,
      allowApproximateTileCull = false,
      maximumMaskRectangleWidth = Infinity,
      maximumMaskRectangleHeight = Infinity,
      maximumColorRectangleWidth = Infinity,
      maximumColorRectangleHeight = Infinity,
      colorSampleGridSize = 64,
      debug = false,
      debugLogLevel = 'debug',
      maxDebugLogs = 200,
      onTileClassified
    } = options
    this.classifier = classifier
    this.coloredClasses = new Set(coloredClasses ?? [])
    this.culledClasses = new Set(culledClasses)
    this.maskedClasses = new Set(maskedClasses)
    this.maskAllIntersectingTiles = maskAllIntersectingTiles
    this.maskTexture = maskTexture
    this.maskRectangle = new Rectangle().copy(maskRectangle)
    this.maskWaterThreshold = maskWaterThreshold
    this.maskAlphaThreshold = maskAlphaThreshold
    this.minimumWaterFraction = minimumWaterFraction
    this.minimumValidFraction = minimumValidFraction
    this.maximumCullRectangleWidth = maximumCullRectangleWidth
    this.maximumCullRectangleHeight = maximumCullRectangleHeight
    this.maximumCullScanSamples = maximumCullScanSamples
    this.allowApproximateTileCull = allowApproximateTileCull
    this.maximumMaskRectangleWidth = maximumMaskRectangleWidth
    this.maximumMaskRectangleHeight = maximumMaskRectangleHeight
    this.maximumColorRectangleWidth = maximumColorRectangleWidth
    this.maximumColorRectangleHeight = maximumColorRectangleHeight
    this.colorSampleGridSize = colorSampleGridSize
    this.debug = debug
    this.debugLogLevel = debugLogLevel
    this.maxDebugLogs = maxDebugLogs
    this.onTileClassified = onTileClassified
  }

  // Plugin method
  init(tiles: TilesRenderer): void {
    this.tiles = tiles
    this.logDebug('init', {
      coloredClasses: [...this.coloredClasses],
      culledClasses: [...this.culledClasses],
      maskedClasses: [...this.maskedClasses],
      maskAllIntersectingTiles: this.maskAllIntersectingTiles,
      hasMaskTexture: this.maskTexture != null,
      maskWaterThreshold: this.maskWaterThreshold,
      maskAlphaThreshold: this.maskAlphaThreshold,
      minimumWaterFraction: this.minimumWaterFraction,
      minimumValidFraction: this.minimumValidFraction,
      maximumCullRectangleDegrees: {
        width: this.maximumCullRectangleWidth * RADIANS_TO_DEGREES,
        height: this.maximumCullRectangleHeight * RADIANS_TO_DEGREES
      },
      maximumCullScanSamples: this.maximumCullScanSamples,
      allowApproximateTileCull: this.allowApproximateTileCull,
      maximumMaskRectangleDegrees: {
        width: this.maximumMaskRectangleWidth * RADIANS_TO_DEGREES,
        height: this.maximumMaskRectangleHeight * RADIANS_TO_DEGREES
      },
      maximumColorRectangleDegrees: {
        width: this.maximumColorRectangleWidth * RADIANS_TO_DEGREES,
        height: this.maximumColorRectangleHeight * RADIANS_TO_DEGREES
      },
      colorSampleGridSize: this.colorSampleGridSize,
      debugLogLevel: this.debugLogLevel
    })

    tiles.forEachLoadedModel((scene, tile) => {
      this.processTileModel(scene, tile)
    })
    tiles.dispatchEvent({ type: 'needs-update' })
    tiles.dispatchEvent({ type: 'needs-render' })
  }

  // Plugin method
  preprocessNode(tile: Tile): void {
    this.classifyTile(tile)
  }

  // Plugin method
  processTileModel(scene: Object3D, tile: Tile): void {
    this.applyTileColor(tile, scene)
    this.applyTileMask(tile, scene)
  }

  // Plugin method
  setTileVisible(tile: Tile, visible: boolean): void {
    if (visible) {
      this.applyTileColor(tile)
      this.applyTileMask(tile)
    }
  }

  // Plugin method
  calculateTileViewError(tile: Tile, target: TileViewErrorTarget): boolean {
    if (!this.canChangeTileViewError()) {
      return false
    }

    const classification = this.classifyTile(tile)
    const shouldColor = classification != null && this.shouldColor(classification)
    const shouldCull =
      classification != null && this.shouldCull(tile, classification)
    const validFraction =
      classification != null && classification.samples > 0
        ? classification.validSamples / classification.samples
        : undefined
    this.debugStats.viewChecks++
    this.debugStats.maxValidFraction = Math.max(
      this.debugStats.maxValidFraction,
      validFraction ?? 0
    )
    this.debugStats.maxWaterFraction = Math.max(
      this.debugStats.maxWaterFraction,
      Number.isFinite(classification?.waterFraction)
        ? (classification?.waterFraction ?? 0)
        : 0
    )
    if (shouldColor) {
      this.applyTileColor(tile, undefined, classification)
    }
    if (shouldCull) {
      target.inView = false
      target.error = 0
      target.distance = Infinity
    }
    this.logDebug('view-error', {
      hasClassification: classification != null,
      class: classification?.class,
      waterFraction: classification?.waterFraction,
      validFraction,
      shouldColor,
      shouldCull,
      summary: this.getDebugSummary()
    })
    return shouldCull
  }

  getClassification(
    tile: Tile
  ): WaterOccurrenceClassification | undefined {
    return this.classifyTile(tile) ?? undefined
  }

  // Plugin method
  dispose(): void {
    this.logDebug('dispose')
    this.tiles = undefined
    this.classifications = new WeakMap()
  }

  private classifyTile(
    tile: Tile
  ): WaterOccurrenceClassification | null {
    const cached = this.classifications.get(tile)
    if (cached !== undefined) {
      return cached
    }

    const rectangle = getTileRectangle(tile, this.rectangle, this.tiles)
    if (rectangle == null) {
      this.debugStats.missingRectangles++
      this.logDebug('classify', {
        hasRectangle: false,
        boundingVolumeKeys: Object.keys(
          (tile as TileWithRegion).boundingVolume ?? {}
        ),
        hasEngineBoundingVolume:
          (tile as TileWithRegion).engineData?.boundingVolume != null,
        summary: this.getDebugSummary()
      })
      return null
    }

    const classification = this.classifier.classifyRectangle(rectangle)
    this.classifications.set(tile, classification)
    this.classificationRectangles.set(tile, rectangle.clone())
    this.debugStats.classified++
    this.debugStats.classes[classification.class]++

    this.logDebug('classify', {
      hasRectangle: true,
      rectangle: {
        west: rectangle.west,
        south: rectangle.south,
        east: rectangle.east,
        north: rectangle.north
      },
      rectangleDegrees: rectangleToDegrees(rectangle),
      class: classification?.class,
      waterFraction: classification?.waterFraction,
      validSamples: classification?.validSamples,
      samples: classification?.samples,
      summary: this.getDebugSummary()
    })

    if (classification != null) {
      this.onTileClassified?.(tile, classification)
    }
    return classification
  }

  private shouldColor(classification: WaterOccurrenceClassification): boolean {
    if (this.coloredClasses.has(classification.class)) {
      return true
    }
    const { minimumWaterFraction } = this
    return (
      minimumWaterFraction != null &&
      classification.samples > 0 &&
      classification.validSamples / classification.samples >=
        this.minimumValidFraction &&
      classification.waterFraction >= minimumWaterFraction
    )
  }

  private canChangeTileViewError(): boolean {
    return (
      this.culledClasses.size > 0 ||
      this.coloredClasses.size > 0 ||
      this.minimumWaterFraction != null
    )
  }

  private shouldCull(
    tile: Tile,
    classification: WaterOccurrenceClassification
  ): boolean {
    const cached = this.cullableTiles.get(tile)
    if (cached != null) {
      return cached
    }
    if (!this.isCullClassification(classification)) {
      this.cullableTiles.set(tile, false)
      return false
    }
    if (!this.allowApproximateTileCull && !hasTileRegion(tile)) {
      this.cullableTiles.set(tile, false)
      return false
    }
    const rectangle = this.getClassificationRectangle(tile)
    if (rectangle == null || !this.shouldCullRectangle(rectangle)) {
      this.cullableTiles.set(tile, false)
      return false
    }
    const scanSamples = estimateRasterPixelCount(
      rectangle,
      this.classifier.raster.rectangle,
      this.classifier.raster.width,
      this.classifier.raster.height
    )
    if (
      scanSamples <= 0 ||
      scanSamples > this.maximumCullScanSamples
    ) {
      this.cullableTiles.set(tile, false)
      return false
    }
    const strictClassification = this.classifier.classifyRectangle(rectangle, {
      maxScanSamples: Number.MAX_SAFE_INTEGER
    })
    const result = this.isCullClassification(strictClassification)
    this.cullableTiles.set(tile, result)
    return result
  }

  private isCullClassification(
    classification: WaterOccurrenceClassification
  ): boolean {
    if (
      !this.culledClasses.has(classification.class) ||
      classification.samples === 0
    ) {
      return false
    }
    const validFraction = classification.validSamples / classification.samples
    return (
      validFraction >= this.minimumValidFraction &&
      (this.minimumWaterFraction == null ||
        classification.waterFraction >= this.minimumWaterFraction)
    )
  }

  private shouldMask(
    rectangle?: Rectangle,
    classification?: WaterOccurrenceClassification | null
  ): boolean {
    if (this.maskAllIntersectingTiles) {
      return rectangle != null && rectanglesOverlap(rectangle, this.maskRectangle)
    }
    return classification != null && this.maskedClasses.has(classification.class)
  }

  private applyTileColor(
    tile: Tile,
    scene = (tile as TileWithRegion).engineData?.scene,
    classification?: WaterOccurrenceClassification | null
  ): void {
    if (this.coloredTiles.has(tile)) {
      return
    }
    if (!this.canApplyTileColor()) {
      return
    }
    const tileClassification = classification ?? this.classifyTile(tile)
    if (
      tileClassification == null ||
      !this.shouldColor(tileClassification)
    ) {
      return
    }
    const rectangle = this.getClassificationRectangle(tile)
    if (rectangle == null || !this.shouldColorRectangle(rectangle)) {
      this.logTileColor('tile colour skipped', {
        reason: rectangle == null ? 'missing-rectangle' : 'large-footprint',
        class: tileClassification.class,
        waterFraction: tileClassification.waterFraction,
        validFraction: getValidFraction(tileClassification),
        rectangleDegrees:
          rectangle != null ? rectangleToDegrees(rectangle) : undefined,
        summary: this.getDebugSummary()
      })
      return
    }
    const colorClassification = this.classifier.classifyRectangle(rectangle, {
      fallbackSampleGridSize: this.colorSampleGridSize,
      maxScanSamples: this.colorSampleGridSize * this.colorSampleGridSize
    })
    if (!this.shouldColorStrictly(colorClassification)) {
      this.logTileColor('tile colour skipped', {
        reason: 'not-strict-water',
        class: colorClassification.class,
        waterFraction: colorClassification.waterFraction,
        validFraction: getValidFraction(colorClassification),
        rectangleDegrees: rectangleToDegrees(rectangle),
        summary: this.getDebugSummary()
      })
      return
    }
    if (scene == null) {
      this.logTileColor('tile colour pending', {
        class: colorClassification.class,
        waterFraction: colorClassification.waterFraction,
        validFraction: getValidFraction(colorClassification),
        rectangleDegrees: rectangleToDegrees(rectangle),
        summary: this.getDebugSummary()
      })
      return
    }

    let materialCount = 0
    scene.traverse(object => {
      const objectWithMaterial = object as Object3DWithMaterial
      const { material } = objectWithMaterial
      if (material == null) {
        return
      }

      const materials = Array.isArray(material) ? material : [material]
      const coloredMaterials = materials.map(material => {
        const coloredMaterial = material.clone() as MaterialWithColor
        if (coloredMaterial.color != null) {
          coloredMaterial.color.copy(TILE_COLOR)
        }
        if ('map' in coloredMaterial) {
          coloredMaterial.map = null
        }
        if (coloredMaterial.emissive != null) {
          coloredMaterial.emissive.copy(TILE_COLOR)
        }
        if (coloredMaterial.emissiveIntensity != null) {
          coloredMaterial.emissiveIntensity = 1
        }
        if (coloredMaterial.toneMapped != null) {
          coloredMaterial.toneMapped = false
        }
        coloredMaterial.needsUpdate = true
        materialCount++
        return coloredMaterial
      })
      objectWithMaterial.material = Array.isArray(material)
        ? coloredMaterials
        : coloredMaterials[0]
    })

    this.coloredTiles.add(tile)
    this.debugStats.colored++
    this.logColorDebug({
      class: colorClassification.class,
      waterFraction: colorClassification.waterFraction,
      validFraction: getValidFraction(colorClassification),
      rectangleDegrees: rectangleToDegrees(rectangle),
      materialCount,
      summary: this.getDebugSummary()
    })
  }

  private canApplyTileColor(): boolean {
    return (
      this.coloredClasses.size > 0 ||
      this.minimumWaterFraction != null
    )
  }

  private applyTileMask(
    tile: Tile,
    scene = (tile as TileWithRegion).engineData?.scene,
    classification?: WaterOccurrenceClassification | null
  ): void {
    if (this.maskTexture == null || scene == null) {
      return
    }

    const rectangle = this.getClassificationRectangle(tile)
    if (rectangle != null && !this.shouldMaskRectangle(rectangle)) {
      return
    }

    const tileClassification =
      classification ??
      (this.maskAllIntersectingTiles
        ? undefined
        : this.classifyTile(tile))
    if (
      !this.maskAllIntersectingTiles &&
      !this.shouldMask(rectangle, tileClassification)
    ) {
      return
    }

    const { tiles } = this
    const ellipsoid = tiles?.ellipsoid
    if (tiles == null || ellipsoid == null) {
      return
    }

    scene.updateMatrixWorld(true)
    let maskedMaterialCount = 0
    scene.traverse(object => {
      const mesh = object as Object3DWithGeometryMaterial
      const { geometry, material } = mesh
      if (mesh.isMesh !== true || geometry == null || material == null) {
        return
      }

      waterMaskMatrixScratch.copy(mesh.matrixWorld)
      if (scene.parent !== null) {
        waterMaskMatrixScratch.premultiply(tiles.group.matrixWorldInverse)
      }
      if (
        !this.setWaterMaskUvAttribute(
          geometry,
          waterMaskMatrixScratch,
          ellipsoid
        )
      ) {
        return
      }

      const materials = Array.isArray(material) ? material : [material]
      const maskedMaterials = materials.map(material => {
        maskedMaterialCount++
        return this.getMaskedMaterial(material)
      })
      mesh.material = Array.isArray(material)
        ? maskedMaterials
        : maskedMaterials[0]
    })

    if (maskedMaterialCount === 0) {
      return
    }
    this.logDebug('tile mask set', {
      class: tileClassification?.class,
      waterFraction: tileClassification?.waterFraction,
      validFraction:
        tileClassification != null
          ? getValidFraction(tileClassification)
          : undefined,
      materialCount: maskedMaterialCount
    })
  }

  private setWaterMaskUvAttribute(
    geometry: BufferGeometry,
    matrix: Matrix4,
    ellipsoid: EllipsoidLike
  ): boolean {
    const position = geometry.getAttribute('position')
    if (position == null) {
      return false
    }

    const { maskRectangle } = this
    const maskRectangleWidth = getRectangleWidth(maskRectangle)

    waterMaskCenterScratch.set(0, 0, 0)
    let finitePositionCount = 0
    for (let i = 0; i < position.count; i += 1) {
      vectorScratch.fromBufferAttribute(position, i)
      if (!isFiniteVector(vectorScratch)) {
        continue
      }
      vectorScratch.applyMatrix4(matrix)
      if (!isFiniteVector(vectorScratch)) {
        continue
      }
      waterMaskCenterScratch.add(vectorScratch)
      finitePositionCount += 1
    }
    if (finitePositionCount === 0) {
      return false
    }
    waterMaskCenterScratch.multiplyScalar(1 / finitePositionCount)
    const center = ellipsoid.getPositionToCartographic(
      waterMaskCenterScratch,
      cartographicScratch
    )
    const centerLat = Number.isFinite(center.lat) ? center.lat : 0
    const centerLon = Number.isFinite(center.lon) ? center.lon : 0

    const uvs = new Float32Array(position.count * 2)
    let minU = Infinity
    let minV = Infinity
    let maxU = -Infinity
    let maxV = -Infinity
    for (let i = 0; i < position.count; i += 1) {
      vectorScratch.fromBufferAttribute(position, i)
      vectorScratch.applyMatrix4(matrix)
      const cartographic = ellipsoid.getPositionToCartographic(
        vectorScratch,
        cartographicScratch
      )

      let { lon, lat } = cartographic
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        uvs[i * 2] = -1
        uvs[i * 2 + 1] = -1
        continue
      }
      if (Math.abs(Math.abs(lat) - Math.PI / 2) < 1e-5) {
        lon = centerLon
      }
      if (Math.abs(centerLon - lon) > Math.PI) {
        lon += Math.sign(centerLon - lon) * TWO_PI
      }
      if (Math.abs(centerLat - lat) > Math.PI) {
        lat += Math.sign(centerLat - lat) * TWO_PI
      }

      const u =
        (unwrapLongitude(lon, maskRectangle.west) - maskRectangle.west) /
        maskRectangleWidth
      const v = (lat - maskRectangle.south) / maskRectangle.height
      uvs[i * 2] = u
      uvs[i * 2 + 1] = v
      minU = Math.min(minU, u)
      minV = Math.min(minV, v)
      maxU = Math.max(maxU, u)
      maxV = Math.max(maxV, v)
    }
    if (
      !Number.isFinite(minU) ||
      maxU < 0 ||
      minU > 1 ||
      maxV < 0 ||
      minV > 1
    ) {
      return false
    }
    geometry.setAttribute('waterMaskUv', new BufferAttribute(uvs, 2))
    return true
  }

  private getMaskedMaterial(material: Material): Material {
    const cached = this.maskedMaterials.get(material)
    if (cached != null) {
      return cached
    }

    const maskedMaterial = material.clone()
    const previousOnBeforeCompile = maskedMaterial.onBeforeCompile.bind(
      maskedMaterial
    )
    const previousProgramCacheKey =
      maskedMaterial.customProgramCacheKey.bind(maskedMaterial)

    maskedMaterial.onBeforeCompile = (shader, renderer): void => {
      previousOnBeforeCompile(shader, renderer)
      this.patchWaterMaskShader(shader)
    }
    maskedMaterial.customProgramCacheKey = (): string =>
      `${previousProgramCacheKey()}|water-mask-v2`
    maskedMaterial.needsUpdate = true
    this.maskedMaterials.set(material, maskedMaterial)
    this.maskedMaterials.set(maskedMaterial, maskedMaterial)
    return maskedMaterial
  }

  private patchWaterMaskShader(shader: WaterMaskShader): void {
    shader.uniforms.waterMaskTexture = { value: this.maskTexture }
    shader.uniforms.waterMaskWaterThreshold = {
      value: this.maskWaterThreshold
    }
    shader.uniforms.waterMaskAlphaThreshold = {
      value: this.maskAlphaThreshold
    }
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `
#include <common>
attribute vec2 waterMaskUv;
varying vec2 vWaterMaskUv;
`
    )
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
#include <begin_vertex>
vWaterMaskUv = waterMaskUv;
`
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `
#include <common>
uniform sampler2D waterMaskTexture;
uniform float waterMaskWaterThreshold;
uniform float waterMaskAlphaThreshold;
varying vec2 vWaterMaskUv;
`
    )

    const discardSnippet = `
if (
  all(greaterThanEqual(vWaterMaskUv, vec2(0.0))) &&
  all(lessThanEqual(vWaterMaskUv, vec2(1.0)))
) {
  vec4 waterMask = texture2D(waterMaskTexture, vWaterMaskUv);
  if (
    waterMask.r >= waterMaskWaterThreshold &&
    waterMask.a >= waterMaskAlphaThreshold
  ) {
    discard;
  }
}
`
    if (shader.fragmentShader.includes('#include <map_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `${discardSnippet}\n#include <map_fragment>`
      )
    } else {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphatest_fragment>',
        `${discardSnippet}\n#include <alphatest_fragment>`
      )
    }
  }

  private getClassificationRectangle(tile: Tile): Rectangle | undefined {
    const cached = this.classificationRectangles.get(tile)
    if (cached != null) {
      return cached
    }
    const rectangle = getTileRectangle(tile, this.rectangle, this.tiles)
    if (rectangle == null) {
      return undefined
    }
    const clone = rectangle.clone()
    this.classificationRectangles.set(tile, clone)
    return clone
  }

  private shouldColorRectangle(rectangle: Rectangle): boolean {
    return (
      rectangle.width <= this.maximumColorRectangleWidth &&
      rectangle.height <= this.maximumColorRectangleHeight
    )
  }

  private shouldCullRectangle(rectangle: Rectangle): boolean {
    return (
      rectangle.width <= this.maximumCullRectangleWidth &&
      rectangle.height <= this.maximumCullRectangleHeight
    )
  }

  private shouldMaskRectangle(rectangle: Rectangle): boolean {
    return (
      rectangle.width <= this.maximumMaskRectangleWidth &&
      rectangle.height <= this.maximumMaskRectangleHeight
    )
  }

  private shouldColorStrictly(
    classification: WaterOccurrenceClassification
  ): boolean {
    return (
      this.coloredClasses.has(classification.class) &&
      classification.samples > 0 &&
      classification.validSamples === classification.samples &&
      classification.waterFraction === 1
    )
  }

  private logDebug(message: string, data?: unknown): void {
    if (!this.debug || this.debugLogCount >= this.maxDebugLogs) {
      return
    }
    this.debugLogCount++
    this.writeDebugLog(`[WaterOccurrenceTilesPlugin] ${message}`, data)
  }

  private logColorDebug(data: unknown): void {
    if (!this.debug || this.colorSetLogCount >= 100) {
      return
    }
    this.colorSetLogCount++
    console.log('[WaterOccurrenceTilesPlugin] tile colour set', data)
  }

  private logColorPending(message: string, data: unknown): void {
    if (!this.debug || this.colorPendingLogCount >= 100) {
      return
    }
    this.colorPendingLogCount++
    console.log(`[WaterOccurrenceTilesPlugin] ${message}`, data)
  }

  private logTileColor(message: string, data: unknown): void {
    if (message === 'tile colour set') {
      this.logColorDebug(data)
      return
    }
    this.logColorPending(message, data)
  }

  private getDebugSummary(): DebugStats {
    return {
      ...this.debugStats,
      classes: { ...this.debugStats.classes }
    }
  }

  private writeDebugLog(message: string, data: unknown): void {
    if (this.debugLogLevel === 'info') {
      console.info(message, data)
    } else {
      console.debug(message, data)
    }
  }
}

function getValidFraction(
  classification: WaterOccurrenceClassification
): number | undefined {
  return classification.samples > 0
    ? classification.validSamples / classification.samples
    : undefined
}

function rectangleToDegrees(rectangle: Rectangle): Rectangle {
  return new Rectangle(
    rectangle.west * RADIANS_TO_DEGREES,
    rectangle.south * RADIANS_TO_DEGREES,
    rectangle.east * RADIANS_TO_DEGREES,
    rectangle.north * RADIANS_TO_DEGREES
  )
}

function estimateRasterPixelCount(
  rectangle: RectangleLike,
  rasterRectangle: RectangleLike,
  rasterWidth: number,
  rasterHeight: number
): number {
  const longitudeOverlap = getLongitudeOverlapWidth(rectangle, rasterRectangle)
  const latitudeOverlap = Math.max(
    0,
    Math.min(rectangle.north, rasterRectangle.north) -
      Math.max(rectangle.south, rasterRectangle.south)
  )
  if (longitudeOverlap <= 0 || latitudeOverlap <= 0) {
    return 0
  }

  const width = Math.ceil(
    (longitudeOverlap / getRectangleWidth(rasterRectangle)) * rasterWidth
  )
  const height = Math.ceil(
    (latitudeOverlap / (rasterRectangle.north - rasterRectangle.south)) *
      rasterHeight
  )
  return width * height
}

function getLongitudeOverlapWidth(
  rectangle: RectangleLike,
  rasterRectangle: RectangleLike
): number {
  const west = unwrapLongitude(rectangle.west, rasterRectangle.west)
  let east = unwrapLongitude(rectangle.east, west)
  if (east < west) {
    east += TWO_PI
  }

  const rasterWest = rasterRectangle.west
  const rasterEast = rasterWest + getRectangleWidth(rasterRectangle)
  let overlap = 0
  for (const offset of [-TWO_PI, 0, TWO_PI]) {
    const start = Math.max(west + offset, rasterWest)
    const end = Math.min(east + offset, rasterEast)
    overlap += Math.max(0, end - start)
  }
  return Math.min(overlap, getRectangleWidth(rasterRectangle))
}

function rectanglesOverlap(
  rectangle: RectangleLike,
  target: RectangleLike
): boolean {
  const latitudeOverlap =
    Math.min(rectangle.north, target.north) -
    Math.max(rectangle.south, target.south)
  return latitudeOverlap > 0 && getLongitudeOverlapWidth(rectangle, target) > 0
}

function getRectangleWidth(rectangle: RectangleLike): number {
  return rectangle.east >= rectangle.west
    ? rectangle.east - rectangle.west
    : rectangle.east + TWO_PI - rectangle.west
}

function unwrapLongitude(longitude: number, origin: number): number {
  let unwrapped = longitude
  while (unwrapped < origin) {
    unwrapped += TWO_PI
  }
  while (unwrapped > origin + TWO_PI) {
    unwrapped -= TWO_PI
  }
  return unwrapped
}

function isFiniteVector(vector: Vector3): boolean {
  return (
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
  )
}

function getTileRectangle(
  tile: Tile,
  target: Rectangle,
  tiles?: TilesRenderer
): Rectangle | undefined {
  const region = (tile as TileWithRegion).boundingVolume?.region
  if (region != null) {
    return target.set(region[0], region[1], region[2], region[3])
  }

  const ellipsoidRegion = (tile as TileWithRegion).engineData?.boundingVolume
    ?.region
  if (ellipsoidRegion != null) {
    return target.set(
      ellipsoidRegion.lonStart,
      ellipsoidRegion.latStart,
      ellipsoidRegion.lonEnd,
      ellipsoidRegion.latEnd
    )
  }

  const boundingVolume = (tile as TileWithRegion).engineData?.boundingVolume
  const ellipsoid = tiles?.ellipsoid
  if (boundingVolume != null && ellipsoid != null) {
    if (boundingVolume.getOBB != null) {
      boundingVolume.getOBB(boxScratch, matrixScratch)
      return getOBBRectangle(boxScratch, matrixScratch, ellipsoid, target)
    }
    if (boundingVolume.getSphere != null) {
      boundingVolume.getSphere(sphereScratch)
      return getSphereRectangle(sphereScratch, ellipsoid, target)
    }
  }
  return undefined
}

function hasTileRegion(tile: Tile): boolean {
  return (
    (tile as TileWithRegion).boundingVolume?.region != null ||
    (tile as TileWithRegion).engineData?.boundingVolume?.region != null
  )
}

function getOBBRectangle(
  box: Box3,
  matrix: Matrix4,
  ellipsoid: EllipsoidLike,
  target: Rectangle
): Rectangle | undefined {
  if (box.isEmpty()) {
    return undefined
  }

  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity

  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        vectorScratch.set(x, y, z).applyMatrix4(matrix)
        const { lon, lat } = ellipsoid.getPositionToCartographic(
          vectorScratch,
          cartographicScratch
        )
        west = Math.min(west, lon)
        south = Math.min(south, lat)
        east = Math.max(east, lon)
        north = Math.max(north, lat)
      }
    }
  }

  return target.set(west, south, east, north)
}

function getSphereRectangle(
  sphere: Sphere,
  ellipsoid: EllipsoidLike,
  target: Rectangle
): Rectangle | undefined {
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
    return undefined
  }

  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  const { center, radius } = sphere
  for (const offset of [
    [-radius, 0, 0],
    [radius, 0, 0],
    [0, -radius, 0],
    [0, radius, 0],
    [0, 0, -radius],
    [0, 0, radius]
  ] as const) {
    vectorScratch
      .set(center.x + offset[0], center.y + offset[1], center.z + offset[2])
    const { lon, lat } = ellipsoid.getPositionToCartographic(
      vectorScratch,
      cartographicScratch
    )
    west = Math.min(west, lon)
    south = Math.min(south, lat)
    east = Math.max(east, lon)
    north = Math.max(north, lat)
  }

  return target.set(west, south, east, north)
}
