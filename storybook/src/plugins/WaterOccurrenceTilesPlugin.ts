import {
  Rectangle,
  type WaterOccurrenceClass,
  type WaterOccurrenceClassification,
  type WaterOccurrenceTileClassifier
} from '@takram/three-geospatial'
import type { Tile, TilesRenderer } from '3d-tiles-renderer'

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

type TileWithRegion = Tile & {
  readonly boundingVolume?: {
    readonly region?: RegionArray
  }
  readonly engineData?: {
    readonly boundingVolume?: {
      readonly region?: EllipsoidRegionLike | null
    } | null
  }
}

export interface WaterOccurrenceTilesPluginOptions {
  readonly classifier: WaterOccurrenceTileClassifier
  readonly culledClasses?: readonly WaterOccurrenceClass[]
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

  tiles?: TilesRenderer

  private classifications = new WeakMap<
    Tile,
    WaterOccurrenceClassification | null
  >()
  private readonly rectangle = new Rectangle()

  constructor(options: WaterOccurrenceTilesPluginOptions) {
    const { classifier, culledClasses = ['water'], onTileClassified } = options
    this.classifier = classifier
    this.culledClasses = new Set(culledClasses)
    this.onTileClassified = onTileClassified
  }

  // Plugin method
  init(tiles: TilesRenderer): void {
    this.tiles = tiles
  }

  // Plugin method
  preprocessNode(tile: Tile): void {
    this.classifyTile(tile)
  }

  // Plugin method
  calculateTileViewError(tile: Tile, target: TileViewErrorTarget): boolean {
    const classification = this.classifyTile(tile)
    if (classification == null || !this.culledClasses.has(classification.class)) {
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

    const rectangle = getTileRectangle(tile, this.rectangle)
    const classification =
      rectangle != null ? this.classifier.classifyRectangle(rectangle) : null
    this.classifications.set(tile, classification)

    if (classification != null) {
      this.onTileClassified?.(tile, classification)
    }
    return classification
  }
}

function getTileRectangle(
  tile: Tile,
  target: Rectangle
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
  return undefined
}
