import type { Meta, StoryFn } from '@storybook/react-vite'
import { TilesPlugin } from '3d-tiles-renderer/r3f'
import { useEffect, useMemo, useState } from 'react'
import {
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  LinearFilter,
  Vector3
} from 'three'

import {
  Geodetic,
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
const MAXAR_OVERLAY_ALTITUDE = 80
const MAXAR_OVERLAY_ALPHA = 180
const MAXAR_OVERLAY_SEGMENTS = 96
const MAXAR_OVERLAY_WATER_THRESHOLD = 50

let maxarWaterClassifierPromise:
  | Promise<WaterOccurrenceTileClassifier>
  | undefined
let maxarOverlayTexturePromise: Promise<CanvasTexture> | undefined

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
        <>
          <MaxarClassificationOverlay />
          {classifier != null && (
            <TilesPlugin
              plugin={WaterOccurrenceTilesPlugin}
              args={{
                classifier,
                colorSampleGridSize: 96,
                debug: true,
                debugLogLevel: 'info',
                maxDebugLogs: 500,
                maximumColorRectangleHeight: radians(0.01),
                maximumColorRectangleWidth: radians(0.01),
                minimumValidFraction: 0.95,
                minimumWaterFraction: 1
              }}
            />
          )}
        </>
      }
    />
  )
}

function MaxarClassificationOverlay(): JSX.Element | null {
  const texture = useMaxarClassificationOverlayTexture()
  const geometry = useMemo(
    () =>
      createRectangleOverlayGeometry(
        MAXAR_WATER_PROBABILITY_RECTANGLE,
        MAXAR_OVERLAY_SEGMENTS,
        MAXAR_OVERLAY_ALTITUDE
      ),
    []
  )

  useEffect(
    () => () => {
      geometry.dispose()
    },
    [geometry]
  )

  if (texture == null) {
    return null
  }

  return (
    <mesh geometry={geometry} renderOrder={1000}>
      <meshBasicMaterial
        map={texture}
        transparent
        depthTest={false}
        depthWrite={false}
        side={DoubleSide}
        toneMapped={false}
      />
    </mesh>
  )
}

function useMaxarClassificationOverlayTexture(): CanvasTexture | undefined {
  const [texture, setTexture] = useState<CanvasTexture>()

  useEffect(() => {
    let disposed = false
    loadMaxarClassificationOverlayTexture(MAXAR_WATER_PROBABILITY_PATH)
      .then(texture => {
        if (!disposed) {
          setTexture(texture)
        }
      })
      .catch(error => {
        console.error(error)
      })
    return () => {
      disposed = true
    }
  }, [])

  return texture
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

async function loadMaxarClassificationOverlayTexture(
  path: string
): Promise<CanvasTexture> {
  maxarOverlayTexturePromise ??= loadMaxarOverlayCanvas(path).then(canvas => {
    const texture = new CanvasTexture(canvas)
    texture.flipY = false
    texture.generateMipmaps = false
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.needsUpdate = true
    return texture
  })
  return maxarOverlayTexturePromise
}

async function loadMaxarOverlayCanvas(path: string): Promise<HTMLCanvasElement> {
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error(
      `Failed to load Maxar classification overlay raster: ${response.status}`
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
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height)
  const data = image.data
  for (let i = 0; i < data.length; i += 4) {
    const value = data[i]
    if (value === 255) {
      data[i + 3] = 0
    } else if (value >= MAXAR_OVERLAY_WATER_THRESHOLD) {
      data[i] = 255
      data[i + 1] = 0
      data[i + 2] = 0
      data[i + 3] = MAXAR_OVERLAY_ALPHA
    } else {
      data[i] = 255
      data[i + 1] = 230
      data[i + 2] = 0
      data[i + 3] = MAXAR_OVERLAY_ALPHA
    }
  }
  context.putImageData(image, 0, 0)
  bitmap.close()

  return canvas
}

function createRectangleOverlayGeometry(
  rectangle: Rectangle,
  segments: number,
  height: number
): BufferGeometry {
  const geometry = new BufferGeometry()
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const geodetic = new Geodetic()
  const position = new Vector3()

  for (let y = 0; y <= segments; y += 1) {
    const v = y / segments
    const latitude = rectangle.south + rectangle.height * v
    for (let x = 0; x <= segments; x += 1) {
      const u = x / segments
      const longitude = rectangle.west + rectangle.width * u
      geodetic.set(longitude, latitude, height).toECEF(position)
      positions.push(position.x, position.y, position.z)
      uvs.push(u, v)
    }
  }

  const stride = segments + 1
  for (let y = 0; y < segments; y += 1) {
    for (let x = 0; x < segments; x += 1) {
      const a = y * stride + x
      const b = a + 1
      const c = a + stride
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  geometry.setIndex(indices)
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geometry.computeVertexNormals()
  return geometry
}
