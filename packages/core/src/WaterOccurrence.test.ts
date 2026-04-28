import { Rectangle } from './Rectangle'
import {
  WaterOccurrenceRaster,
  WaterOccurrenceTileClassifier
} from './WaterOccurrence'

describe('WaterOccurrenceRaster', () => {
  const rectangle = new Rectangle(0, 0, 4, 4)

  test('samples a north-up occurrence raster', () => {
    const raster = new WaterOccurrenceRaster({
      width: 2,
      height: 2,
      rectangle,
      data: [1, 2, 3, 4]
    })

    expect(raster.sample(1, 3)).toBe(1)
    expect(raster.sample(3, 3)).toBe(2)
    expect(raster.sample(1, 1)).toBe(3)
    expect(raster.sample(3, 1)).toBe(4)
  })

  test('classifies land, water, and shoreline rectangles conservatively', () => {
    const raster = new WaterOccurrenceRaster({
      width: 4,
      height: 4,
      rectangle,
      data: [
        0, 0, 80, 80,
        0, 0, 80, 80,
        0, 0, 80, 80,
        0, 0, 80, 80
      ]
    })

    expect(raster.classifyRectangle(new Rectangle(0, 0, 2, 4)).class).toBe(
      'land'
    )
    expect(raster.classifyRectangle(new Rectangle(2, 0, 4, 4)).class).toBe(
      'water'
    )
    expect(raster.classifyRectangle(rectangle).class).toBe('shoreline')
  })

  test('treats intermediate occurrence as shoreline', () => {
    const raster = new WaterOccurrenceRaster({
      width: 2,
      height: 2,
      rectangle,
      data: [25, 25, 25, 25]
    })

    expect(raster.classifyRectangle(rectangle).class).toBe('shoreline')
  })

  test('keeps no-data coverage unknown by default', () => {
    const raster = new WaterOccurrenceRaster({
      width: 2,
      height: 2,
      rectangle,
      data: [80, -1, 80, 80],
      noData: -1
    })

    expect(raster.classifyRectangle(rectangle).class).toBe('unknown')
    expect(
      raster.classifyRectangle(rectangle, { allowPartialCoverage: true }).class
    ).toBe('water')
  })

  test('keeps rectangles outside raster coverage unknown by default', () => {
    const raster = new WaterOccurrenceRaster({
      width: 2,
      height: 2,
      rectangle: new Rectangle(0, 0, 2, 2),
      data: [80, 80, 80, 80]
    })
    const partiallyCovered = new Rectangle(0, 0, 4, 2)
    const outside = new Rectangle(2, 0, 4, 2)

    expect(raster.classifyRectangle(partiallyCovered).class).toBe('unknown')
    expect(
      raster.classifyRectangle(partiallyCovered, {
        allowPartialCoverage: true
      }).class
    ).toBe('water')
    expect(raster.classifyRectangle(outside).class).toBe('unknown')
  })
})

describe('WaterOccurrenceTileClassifier', () => {
  test('lets a coarse mixed tile resolve into land and water children', () => {
    const rectangle = new Rectangle(0, 0, 4, 4)
    const raster = new WaterOccurrenceRaster({
      width: 4,
      height: 4,
      rectangle,
      data: [
        0, 0, 80, 80,
        0, 0, 80, 80,
        0, 0, 80, 80,
        0, 0, 80, 80
      ]
    })
    const classifier = new WaterOccurrenceTileClassifier(raster, {
      tilingScheme: { width: 1, height: 1, rectangle }
    })

    expect(classifier.classifyTile({ x: 0, y: 0, z: 0 }).class).toBe(
      'shoreline'
    )
    expect(classifier.classifyTile({ x: 0, y: 0, z: 1 }).class).toBe('land')
    expect(classifier.classifyTile({ x: 1, y: 0, z: 1 }).class).toBe('water')
  })
})
