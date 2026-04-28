import { clamp } from './math'
import { Rectangle, type RectangleLike } from './Rectangle'
import type { TileCoordinateLike } from './TileCoordinate'
import { TilingScheme, type TilingSchemeLike } from './TilingScheme'

const TWO_PI = Math.PI * 2
const FULL_LONGITUDE_EPSILON = 1e-12

export type WaterOccurrenceClass =
  | 'land'
  | 'water'
  | 'shoreline'
  | 'unknown'

export interface WaterOccurrenceRasterOptions {
  readonly width: number
  readonly height: number
  readonly data: ArrayLike<number>
  readonly rectangle?: RectangleLike
  readonly channels?: number
  readonly channel?: number
  readonly noData?: number | readonly number[]
}

export interface WaterOccurrenceClassificationOptions {
  readonly landThreshold?: number
  readonly waterThreshold?: number
  readonly maxScanSamples?: number
  readonly fallbackSampleGridSize?: number
  readonly allowPartialCoverage?: boolean
  readonly unknownClass?: WaterOccurrenceClass
}

export interface WaterOccurrenceClassification {
  readonly class: WaterOccurrenceClass
  readonly min: number
  readonly max: number
  readonly mean: number
  readonly samples: number
  readonly validSamples: number
  readonly landSamples: number
  readonly waterSamples: number
  readonly transitionSamples: number
  readonly waterFraction: number
}

interface PixelWindow {
  readonly xStart: number
  readonly xEnd: number
  readonly yStart: number
  readonly yEnd: number
}

interface MutableStats {
  min: number
  max: number
  sum: number
  samples: number
  validSamples: number
  landSamples: number
  waterSamples: number
  transitionSamples: number
}

export class WaterOccurrenceRaster {
  readonly width: number
  readonly height: number
  readonly data: ArrayLike<number>
  readonly rectangle: Rectangle
  readonly channels: number
  readonly channel: number
  readonly noData: readonly number[]

  constructor(options: WaterOccurrenceRasterOptions) {
    const {
      width,
      height,
      data,
      rectangle = Rectangle.MAX,
      channels = 1,
      channel = 0,
      noData = []
    } = options

    if (width <= 0 || height <= 0) {
      throw new Error('WaterOccurrenceRaster: width and height must be positive')
    }
    if (channels <= 0) {
      throw new Error('WaterOccurrenceRaster: channels must be positive')
    }
    if (channel < 0 || channel >= channels) {
      throw new Error(
        'WaterOccurrenceRaster: channel must be within the channel count'
      )
    }
    if (data.length < width * height * channels) {
      throw new Error('WaterOccurrenceRaster: data is smaller than raster size')
    }

    this.width = width
    this.height = height
    this.data = data
    this.rectangle = new Rectangle().copy(rectangle)
    this.channels = channels
    this.channel = channel
    this.noData = typeof noData === 'number' ? [noData] : [...noData]
  }

  getPixel(x: number, y: number): number | undefined {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return undefined
    }
    const index = (y * this.width + x) * this.channels + this.channel
    const value = this.data[index]
    return this.isNoData(value) ? undefined : value
  }

  sample(longitude: number, latitude: number): number | undefined {
    const x = this.longitudeToU(longitude)
    const y = this.latitudeToV(latitude)
    if (x == null || y == null) {
      return undefined
    }
    return this.getPixel(
      Math.min(Math.floor(x * this.width), this.width - 1),
      Math.min(Math.floor(y * this.height), this.height - 1)
    )
  }

  classifyRectangle(
    rectangle: RectangleLike,
    options: WaterOccurrenceClassificationOptions = {}
  ): WaterOccurrenceClassification {
    const {
      landThreshold = 0,
      waterThreshold = 50,
      maxScanSamples = 4096,
      fallbackSampleGridSize = 16,
      allowPartialCoverage = false,
      unknownClass = 'unknown'
    } = options

    if (waterThreshold < landThreshold) {
      throw new Error(
        'WaterOccurrenceRaster: waterThreshold must be greater than or equal to landThreshold'
      )
    }

    const stats = createStats()
    const fullyCovered = this.coversRectangle(rectangle)
    const windows = this.getPixelWindows(rectangle)
    const pixelCount = windows.reduce(
      (sum, window) =>
        sum +
        (window.xEnd - window.xStart + 1) *
          (window.yEnd - window.yStart + 1),
      0
    )

    if (pixelCount > 0 && pixelCount <= maxScanSamples) {
      for (const window of windows) {
        for (let y = window.yStart; y <= window.yEnd; y++) {
          for (let x = window.xStart; x <= window.xEnd; x++) {
            addValue(stats, this.getPixel(x, y), landThreshold, waterThreshold)
          }
        }
      }
    } else {
      const gridSize = Math.max(1, Math.floor(fallbackSampleGridSize))
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const longitude = interpolateWrappedLongitude(
            rectangle,
            (x + 0.5) / gridSize
          )
          const latitude =
            rectangle.north +
            (rectangle.south - rectangle.north) * ((y + 0.5) / gridSize)
          addValue(
            stats,
            this.sample(longitude, latitude),
            landThreshold,
            waterThreshold
          )
        }
      }
    }

    return finalizeStats(stats, {
      allowPartialCoverage,
      fullyCovered,
      unknownClass
    })
  }

  private isNoData(value: number): boolean {
    return !Number.isFinite(value) || this.noData.includes(value)
  }

  private getPixelWindows(rectangle: RectangleLike): PixelWindow[] {
    const north = Math.min(rectangle.north, this.rectangle.north)
    const south = Math.max(rectangle.south, this.rectangle.south)
    if (south >= north) {
      return []
    }

    const yStart = clamp(
      Math.floor((this.latitudeToV(north) ?? -1) * this.height),
      0,
      this.height - 1
    )
    const yEnd = clamp(
      Math.ceil((this.latitudeToV(south) ?? 2) * this.height) - 1,
      0,
      this.height - 1
    )
    if (yEnd < yStart) {
      return []
    }

    return this.getLongitudeIntervals(rectangle).map(([west, east]) => ({
      xStart: clamp(Math.floor(west * this.width), 0, this.width - 1),
      xEnd: clamp(Math.ceil(east * this.width) - 1, 0, this.width - 1),
      yStart,
      yEnd
    }))
  }

  private coversRectangle(rectangle: RectangleLike): boolean {
    if (
      rectangle.south < this.rectangle.south - FULL_LONGITUDE_EPSILON ||
      rectangle.north > this.rectangle.north + FULL_LONGITUDE_EPSILON
    ) {
      return false
    }

    const longitudeCoverage = this.getLongitudeIntervals(rectangle).reduce(
      (sum, [west, east]) => sum + (east - west) * this.rectangle.width,
      0
    )
    return (
      longitudeCoverage + FULL_LONGITUDE_EPSILON >= rectangleWidth(rectangle)
    )
  }

  private getLongitudeIntervals(
    rectangle: RectangleLike
  ): Array<readonly [number, number]> {
    if (
      rectangleWidth(rectangle) >= TWO_PI - FULL_LONGITUDE_EPSILON &&
      this.rectangle.width >= TWO_PI - FULL_LONGITUDE_EPSILON
    ) {
      return [[0, 1]]
    }

    const west = unwrapLongitude(rectangle.west, this.rectangle.west)
    let east = unwrapLongitude(rectangle.east, west)
    if (east < west) {
      east += TWO_PI
    }

    const rasterWest = this.rectangle.west
    const rasterEast = this.rectangle.west + this.rectangle.width
    const intervals: Array<readonly [number, number]> = []
    for (const offset of [-TWO_PI, 0, TWO_PI]) {
      const start = Math.max(west + offset, rasterWest)
      const end = Math.min(east + offset, rasterEast)
      if (end > start) {
        intervals.push([
          (start - rasterWest) / this.rectangle.width,
          (end - rasterWest) / this.rectangle.width
        ])
      }
    }
    return intervals
  }

  private longitudeToU(longitude: number): number | undefined {
    const width = this.rectangle.width
    const west = this.rectangle.west
    const east = west + width
    let unwrapped = unwrapLongitude(longitude, west)
    if (unwrapped < west - FULL_LONGITUDE_EPSILON) {
      unwrapped += TWO_PI
    } else if (unwrapped > east + FULL_LONGITUDE_EPSILON) {
      unwrapped -= TWO_PI
    }
    if (
      unwrapped < west - FULL_LONGITUDE_EPSILON ||
      unwrapped > east + FULL_LONGITUDE_EPSILON
    ) {
      return undefined
    }
    return clamp((unwrapped - west) / width, 0, 1)
  }

  private latitudeToV(latitude: number): number | undefined {
    const { south, north } = this.rectangle
    if (
      latitude < south - FULL_LONGITUDE_EPSILON ||
      latitude > north + FULL_LONGITUDE_EPSILON
    ) {
      return undefined
    }
    return clamp((north - latitude) / this.rectangle.height, 0, 1)
  }
}

export interface WaterOccurrenceTileClassifierOptions
  extends WaterOccurrenceClassificationOptions {
  readonly tilingScheme?: TilingSchemeLike
}

export class WaterOccurrenceTileClassifier {
  readonly raster: WaterOccurrenceRaster
  readonly tilingScheme: TilingScheme
  readonly options: WaterOccurrenceClassificationOptions

  constructor(
    raster: WaterOccurrenceRaster,
    options: WaterOccurrenceTileClassifierOptions = {}
  ) {
    const { tilingScheme = new TilingScheme(), ...classificationOptions } =
      options
    this.raster = raster
    this.tilingScheme = new TilingScheme().copy(tilingScheme)
    this.options = classificationOptions
  }

  classifyRectangle(
    rectangle: RectangleLike,
    options?: WaterOccurrenceClassificationOptions
  ): WaterOccurrenceClassification {
    return this.raster.classifyRectangle(rectangle, {
      ...this.options,
      ...options
    })
  }

  classifyTile(
    tile: TileCoordinateLike,
    options?: WaterOccurrenceClassificationOptions
  ): WaterOccurrenceClassification {
    return this.classifyRectangle(this.tilingScheme.getRectangle(tile), options)
  }
}

function createStats(): MutableStats {
  return {
    min: Infinity,
    max: -Infinity,
    sum: 0,
    samples: 0,
    validSamples: 0,
    landSamples: 0,
    waterSamples: 0,
    transitionSamples: 0
  }
}

function addValue(
  stats: MutableStats,
  value: number | undefined,
  landThreshold: number,
  waterThreshold: number
): void {
  stats.samples++
  if (value == null) {
    return
  }

  stats.validSamples++
  stats.min = Math.min(stats.min, value)
  stats.max = Math.max(stats.max, value)
  stats.sum += value

  if (value <= landThreshold) {
    stats.landSamples++
  } else if (value >= waterThreshold) {
    stats.waterSamples++
  } else {
    stats.transitionSamples++
  }
}

function finalizeStats(
  stats: MutableStats,
  options: Required<
    Pick<
      WaterOccurrenceClassificationOptions,
      'allowPartialCoverage' | 'unknownClass'
    >
  > & { readonly fullyCovered: boolean }
): WaterOccurrenceClassification {
  const {
    samples,
    validSamples,
    landSamples,
    waterSamples,
    transitionSamples
  } = stats
  let classification: WaterOccurrenceClass
  if (
    validSamples === 0 ||
    (!options.allowPartialCoverage && !options.fullyCovered) ||
    (!options.allowPartialCoverage && validSamples !== samples)
  ) {
    classification = options.unknownClass
  } else if (transitionSamples > 0) {
    classification = 'shoreline'
  } else if (waterSamples === validSamples) {
    classification = 'water'
  } else if (landSamples === validSamples) {
    classification = 'land'
  } else {
    classification = 'shoreline'
  }

  return {
    class: classification,
    min: validSamples > 0 ? stats.min : NaN,
    max: validSamples > 0 ? stats.max : NaN,
    mean: validSamples > 0 ? stats.sum / validSamples : NaN,
    samples,
    validSamples,
    landSamples,
    waterSamples,
    transitionSamples,
    waterFraction: validSamples > 0 ? waterSamples / validSamples : NaN
  }
}

function rectangleWidth(rectangle: RectangleLike): number {
  let east = rectangle.east
  if (east < rectangle.west) {
    east += TWO_PI
  }
  return east - rectangle.west
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

function interpolateWrappedLongitude(
  rectangle: RectangleLike,
  x: number
): number {
  let east = rectangle.east
  if (east < rectangle.west) {
    east += TWO_PI
  }
  const longitude = rectangle.west + (east - rectangle.west) * x
  return longitude > Math.PI ? longitude - TWO_PI : longitude
}
