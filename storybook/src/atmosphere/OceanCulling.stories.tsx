import type { Meta, StoryFn } from '@storybook/react-vite'
import { TilesPlugin } from '3d-tiles-renderer/r3f'

import {
  radians,
  Rectangle,
  WaterOccurrenceRaster,
  WaterOccurrenceTileClassifier
} from '@takram/three-geospatial'

import { WaterOccurrenceTilesPlugin } from '../plugins/WaterOccurrenceTilesPlugin'
import { Story } from './3DTilesRenderer-Story'

const classifier = createManhattanWaterClassifier()

export default {
  title: 'atmosphere/Ocean Culling',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta

export const Manhattan: StoryFn = () => (
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
      <TilesPlugin
        plugin={WaterOccurrenceTilesPlugin}
        args={{
          classifier
        }}
      />
    }
  />
)

function createManhattanWaterClassifier(): WaterOccurrenceTileClassifier {
  const width = 192
  const height = 192
  const west = -74.08
  const south = 40.66
  const east = -73.88
  const north = 40.84
  const data = new Uint8Array(width * height)

  for (let y = 0; y < height; y++) {
    const latitude = north + ((south - north) * (y + 0.5)) / height
    for (let x = 0; x < width; x++) {
      const longitude = west + ((east - west) * (x + 0.5)) / width
      data[y * width + x] = isManhattanWater(longitude, latitude) ? 90 : 0
    }
  }

  return new WaterOccurrenceTileClassifier(
    new WaterOccurrenceRaster({
      width,
      height,
      data,
      rectangle: new Rectangle(
        radians(west),
        radians(south),
        radians(east),
        radians(north)
      )
    }),
    {
      waterThreshold: 50
    }
  )
}

function isManhattanWater(longitude: number, latitude: number): boolean {
  const hudsonRiver = longitude < -74.015
  const upperEastRiver = latitude > 40.76 && longitude > -73.945
  const lowerEastRiver =
    latitude <= 40.76 && longitude > -73.99 + (latitude - 40.66) * 0.45
  const newYorkHarbor = latitude < 40.705 && longitude < -73.985
  return hudsonRiver || upperEastRiver || lowerEastRiver || newYorkHarbor
}
