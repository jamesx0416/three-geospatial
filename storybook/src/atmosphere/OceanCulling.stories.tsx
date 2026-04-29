import type { Meta, StoryFn } from '@storybook/react-vite'
import { TilesPlugin } from '3d-tiles-renderer/r3f'
import { useEffect, useState } from 'react'

import {
  radians,
  Rectangle,
  WaterOccurrenceRaster,
  WaterOccurrenceTileClassifier
} from '@takram/three-geospatial'

import { WaterOccurrenceTilesPlugin } from '../plugins/WaterOccurrenceTilesPlugin'
import { Story } from './3DTilesRenderer-Story'

const MAXAR_WATER_PROBABILITY_PATH =
  '/public/maxar/manhattan-water-probability.png'
const MAXAR_WATER_PROBABILITY_RECTANGLE = new Rectangle(
  radians(-74.08),
  radians(40.66),
  radians(-73.88),
  radians(40.84)
)

let maxarWaterClassifierPromise:
  | Promise<WaterOccurrenceTileClassifier>
  | undefined

export default {
  title: 'atmosphere/Ocean Culling',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta

export const Manhattan: StoryFn = () => {
  const classifier = useMaxarManhattanWaterClassifier()

  return (
    <Story
      longitude={-73.9709}
      latitude={40.7589}
      heading={-155}
      pitch={-35}
      distance={3000}
      exposure={60}
      dayOfYear={1}
      timeOfDay={7.6}
      globeChildren={
        classifier != null && (
          <TilesPlugin
            plugin={WaterOccurrenceTilesPlugin}
            args={{
              classifier,
              debug: true,
              debugLogLevel: 'info',
              maxDebugLogs: 500,
              maximumColorRectangleHeight: radians(0.01),
              maximumColorRectangleWidth: radians(0.01),
              minimumValidFraction: 0.95,
              minimumWaterFraction: 1
            }}
          />
        )
      }
    />
  )
}

function useMaxarManhattanWaterClassifier():
  | WaterOccurrenceTileClassifier
  | undefined {
  const [classifier, setClassifier] = useState<WaterOccurrenceTileClassifier>()

  useEffect(() => {
    let disposed = false
    loadMaxarManhattanWaterClassifier()
      .then(classifier => {
        if (!disposed) {
          setClassifier(classifier)
        }
      })
      .catch(error => {
        console.error(error)
      })
    return () => {
      disposed = true
    }
  }, [])

  return classifier
}

function loadMaxarManhattanWaterClassifier(): Promise<WaterOccurrenceTileClassifier> {
  maxarWaterClassifierPromise ??= loadWaterOccurrenceRaster(
    MAXAR_WATER_PROBABILITY_PATH
  ).then(
    raster =>
      new WaterOccurrenceTileClassifier(raster, {
        landThreshold: -1,
        waterThreshold: 0
      })
  )
  return maxarWaterClassifierPromise
}

async function loadWaterOccurrenceRaster(
  path: string
): Promise<WaterOccurrenceRaster> {
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error(
      `Failed to load Maxar water probability raster: ${response.status}`
    )
  }
  const bitmap = await createImageBitmap(await response.blob())
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d')
  if (context == null) {
    bitmap.close()
    throw new Error('Failed to create canvas context')
  }
  context.drawImage(bitmap, 0, 0)
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
  bitmap.close()

  return new WaterOccurrenceRaster({
    width: canvas.width,
    height: canvas.height,
    data,
    rectangle: MAXAR_WATER_PROBABILITY_RECTANGLE,
    channels: 4,
    channel: 0,
    noData: 255
  })
}
