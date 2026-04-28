import {
  Rectangle,
  type WaterOccurrenceClass,
  type WaterOccurrenceClassification,
  type WaterOccurrenceTileClassifier
} from '@takram/three-geospatial'
import type { Tile, TilesRenderer } from '3d-tiles-renderer'
import { Box3, Matrix4, Sphere, Vector3 } from 'three'

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
  }
}

type TilesRendererWithEllipsoid = TilesRenderer & {
  readonly ellipsoid?: EllipsoidLike
}

interface DebugStats {
  classified: number
  missingRectangles: number
  viewChecks: number
  culled: number
  maxWaterFraction: number
  maxValidFraction: number
  classes: Record<WaterOccurrenceClass, number>
}

const boxScratch = /*#__PURE__*/ new Box3()
const matrixScratch = /*#__PURE__*/ new Matrix4()
const sphereScratch = /*#__PURE__*/ new Sphere()
const vectorScratch = /*#__PURE__*/ new Vector3()
const cartographicScratch: CartographicLike = { lat: 0, lon: 0, height: 0 }
const RADIANS_TO_DEGREES = 180 / Math.PI

export interface WaterOccurrenceTilesPluginOptions {
  readonly classifier: WaterOccurrenceTileClassifier
  readonly culledClasses?: readonly WaterOccurrenceClass[]
  readonly minimumWaterFraction?: number
  readonly minimumValidFraction?: number
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
  readonly culledClasses: ReadonlySet<WaterOccurrenceClass>
  readonly onTileClassified?: (
    tile: Tile,
    classification: WaterOccurrenceClassification
  ) => void
  readonly minimumWaterFraction?: number
  readonly minimumValidFraction: number
  readonly debug: boolean
  readonly debugLogLevel: 'debug' | 'info'
  readonly maxDebugLogs: number

  tiles?: TilesRenderer

  private classifications = new WeakMap<
    Tile,
    WaterOccurrenceClassification | null
  >()
  private readonly rectangle = new Rectangle()
  private debugLogCount = 0
  private cullDebugLogCount = 0
  private readonly debugStats: DebugStats = {
    classified: 0,
    missingRectangles: 0,
    viewChecks: 0,
    culled: 0,
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
      culledClasses = ['water'],
      minimumWaterFraction,
      minimumValidFraction = 1,
      debug = false,
      debugLogLevel = 'debug',
      maxDebugLogs = 200,
      onTileClassified
    } = options
    this.classifier = classifier
    this.culledClasses = new Set(culledClasses)
    this.minimumWaterFraction = minimumWaterFraction
    this.minimumValidFraction = minimumValidFraction
    this.debug = debug
    this.debugLogLevel = debugLogLevel
    this.maxDebugLogs = maxDebugLogs
    this.onTileClassified = onTileClassified
  }

  // Plugin method
  init(tiles: TilesRenderer): void {
    this.tiles = tiles
    this.logDebug('init', {
      culledClasses: [...this.culledClasses],
      minimumWaterFraction: this.minimumWaterFraction,
      minimumValidFraction: this.minimumValidFraction,
      debugLogLevel: this.debugLogLevel
    })
    tiles.dispatchEvent({ type: 'needs-update' })
  }

  // Plugin method
  preprocessNode(tile: Tile): void {
    this.classifyTile(tile)
  }

  // Plugin method
  calculateTileViewError(tile: Tile, target: TileViewErrorTarget): boolean {
    const classification = this.classifyTile(tile)
    const cull = classification != null && this.shouldCull(classification)
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
    if (cull) {
      this.debugStats.culled++
      this.logCullDebug({
        class: classification.class,
        waterFraction: classification.waterFraction,
        validFraction,
        summary: this.getDebugSummary()
      })
    }
    this.logDebug('view-error', {
      hasClassification: classification != null,
      class: classification?.class,
      waterFraction: classification?.waterFraction,
      validFraction,
      cull,
      summary: this.getDebugSummary()
    })
    if (classification == null || !cull) {
      return false
    }

    target.inView = false
    target.error = 0
    target.distance = Infinity
    return true
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

  private shouldCull(classification: WaterOccurrenceClassification): boolean {
    if (this.culledClasses.has(classification.class)) {
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

  private logDebug(message: string, data?: unknown): void {
    if (!this.debug || this.debugLogCount >= this.maxDebugLogs) {
      return
    }
    this.debugLogCount++
    this.writeDebugLog(`[WaterOccurrenceTilesPlugin] ${message}`, data)
  }

  private logCullDebug(data: unknown): void {
    if (!this.debug || this.cullDebugLogCount >= 20) {
      return
    }
    this.cullDebugLogCount++
    this.writeDebugLog('[WaterOccurrenceTilesPlugin] cull', data)
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

function rectangleToDegrees(rectangle: Rectangle): Rectangle {
  return new Rectangle(
    rectangle.west * RADIANS_TO_DEGREES,
    rectangle.south * RADIANS_TO_DEGREES,
    rectangle.east * RADIANS_TO_DEGREES,
    rectangle.north * RADIANS_TO_DEGREES
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
  const ellipsoid = (tiles as TilesRendererWithEllipsoid | undefined)?.ellipsoid
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
