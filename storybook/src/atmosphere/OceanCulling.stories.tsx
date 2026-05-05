import type { Meta, StoryFn } from '@storybook/react-vite'
import { TilesPlugin } from '3d-tiles-renderer/r3f'
import {
  useEffect,
  useMemo,
  useState,
  type ReactElement
} from 'react'
import {
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  LinearMipmapLinearFilter,
  NearestFilter,
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
  '/public/maxar/manhattan-water-probability.png?v=maxar-mosaic-4'
const MAXAR_WATER_PROBABILITY_RECTANGLE = new Rectangle(
  radians(-74.55423086017844),
  radians(40.07668324876217),
  radians(-73.06813098242732),
  radians(41.208482123651685)
)
const MAXAR_LAND_THRESHOLD = 0
const MAXAR_WATER_THRESHOLD = 90
const MAXAR_OVERLAY_ALTITUDE = 80
const MAXAR_OVERLAY_ALPHA = 220
const MAXAR_OVERLAY_SEGMENTS = 96
const MAXAR_OVERLAY_TEXTURE_SIZE = 2048
const MAXAR_MASK_TEXTURE_SIZE = 2048

let maxarWaterClassifierPromise:
  | Promise<WaterOccurrenceTileClassifier>
  | undefined
let maxarRasterImagePromise: Promise<MaxarRasterImage> | undefined
let maxarOverlayTexturePromise: Promise<CanvasTexture> | undefined
let maxarMaskTexturePromise: Promise<CanvasTexture> | undefined

interface MaxarRasterImage {
  readonly width: number
  readonly height: number
  readonly classificationData: Uint8Array
  readonly overlayCanvas: HTMLCanvasElement
  readonly maskCanvas: HTMLCanvasElement
}

export default {
  title: 'atmosphere/Ocean Culling',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta

export const Manhattan: StoryFn = () => {
  const classifier = useMaxarManhattanWaterClassifier()
  const maskTexture = useMaxarWaterMaskTexture()

  return (
    <Story
      longitude={-73.9709}
      latitude={40.7589}
      heading={-155}
      pitch={-45}
      distance={12000}
      exposure={60}
      dayOfYear={1}
      timeOfDay={7.6}
      globeChildren={
        <>
          <MaxarClassificationOverlay />
          {classifier != null && maskTexture != null && (
            <TilesPlugin
              plugin={WaterOccurrenceTilesPlugin}
              args={{
                classifier,
                coloredClasses: [],
                culledClasses: [],
                maskedClasses: ['water', 'shoreline'],
                maskAllIntersectingTiles: true,
                maskTexture,
                maskWaterThreshold: MAXAR_WATER_THRESHOLD / 255,
                debug: false
              }}
            />
          )}
        </>
      }
    />
  )
}

function MaxarClassificationOverlay(): ReactElement | null {
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
      .catch((error: unknown) => {
        console.error(error)
      })
    return () => {
      disposed = true
    }
  }, [])

  return texture
}

function useMaxarWaterMaskTexture(): CanvasTexture | undefined {
  const [texture, setTexture] = useState<CanvasTexture>()

  useEffect(() => {
    let disposed = false
    loadMaxarWaterMaskTexture(MAXAR_WATER_PROBABILITY_PATH)
      .then(texture => {
        if (!disposed) {
          setTexture(texture)
        }
      })
      .catch((error: unknown) => {
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
      .catch((error: unknown) => {
        console.error(error)
      })
    return () => {
      disposed = true
    }
  }, [])

  return classifier
}

async function loadMaxarManhattanWaterClassifier(): Promise<WaterOccurrenceTileClassifier> {
  maxarWaterClassifierPromise ??= loadWaterOccurrenceRaster().then(
    raster =>
      new WaterOccurrenceTileClassifier(raster, {
        landThreshold: MAXAR_LAND_THRESHOLD,
        waterThreshold: MAXAR_WATER_THRESHOLD
      })
  )
  return await maxarWaterClassifierPromise
}

async function loadWaterOccurrenceRaster(): Promise<WaterOccurrenceRaster> {
  const image = await loadMaxarRasterImage(MAXAR_WATER_PROBABILITY_PATH)
  return new WaterOccurrenceRaster({
    width: image.width,
    height: image.height,
    data: image.classificationData,
    rectangle: MAXAR_WATER_PROBABILITY_RECTANGLE,
    noData: 255
  })
}

async function loadMaxarRasterImage(path: string): Promise<MaxarRasterImage> {
  maxarRasterImagePromise ??= loadMaxarRasterImageUncached(path)
  return await maxarRasterImagePromise
}

async function loadMaxarRasterImageUncached(
  path: string
): Promise<MaxarRasterImage> {
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error(
      `Failed to load Maxar water probability raster: ${response.status}`
    )
  }
  const bitmap = await createImageBitmap(await response.blob())
  const { width, height } = bitmap
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context == null) {
    bitmap.close()
    throw new Error('Failed to create canvas context')
  }
  context.drawImage(bitmap, 0, 0)
  const source = context.getImageData(0, 0, width, height).data
  bitmap.close()

  const classificationData = new Uint8Array(width * height)
  for (let sourceIndex = 0, targetIndex = 0; sourceIndex < source.length; ) {
    classificationData[targetIndex++] = source[sourceIndex]
    sourceIndex += 4
  }

  return {
    width,
    height,
    classificationData,
    overlayCanvas: createMaxarOverlayCanvas(classificationData, width, height),
    maskCanvas: createMaxarMaskCanvas(classificationData, width, height)
  }
}

async function loadMaxarClassificationOverlayTexture(
  path: string
): Promise<CanvasTexture> {
  maxarOverlayTexturePromise ??= loadMaxarRasterImage(path).then(image => {
    const canvas = image.overlayCanvas
    const texture = new CanvasTexture(canvas)
    texture.flipY = true
    texture.generateMipmaps = true
    texture.minFilter = LinearMipmapLinearFilter
    texture.magFilter = NearestFilter
    texture.needsUpdate = true
    return texture
  })
  return await maxarOverlayTexturePromise
}

async function loadMaxarWaterMaskTexture(path: string): Promise<CanvasTexture> {
  maxarMaskTexturePromise ??= loadMaxarRasterImage(path).then(image => {
    const texture = new CanvasTexture(image.maskCanvas)
    texture.flipY = true
    texture.generateMipmaps = true
    texture.minFilter = LinearMipmapLinearFilter
    texture.magFilter = NearestFilter
    texture.needsUpdate = true
    return texture
  })
  return await maxarMaskTexturePromise
}

function createMaxarMaskCanvas(
  data: Uint8Array,
  width: number,
  height: number
): HTMLCanvasElement {
  const scale = Math.min(1, MAXAR_MASK_TEXTURE_SIZE / Math.max(width, height))
  const maskWidth = Math.max(1, Math.round(width * scale))
  const maskHeight = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = maskWidth
  canvas.height = maskHeight
  const context = canvas.getContext('2d')
  if (context == null) {
    throw new Error('Failed to create canvas context')
  }

  const image = context.createImageData(maskWidth, maskHeight)
  const target = image.data
  for (let y = 0; y < maskHeight; y += 1) {
    const sourceY = Math.min(Math.floor(y / scale), height - 1)
    for (let x = 0; x < maskWidth; x += 1) {
      const sourceX = Math.min(Math.floor(x / scale), width - 1)
      const value = data[sourceY * width + sourceX]
      const targetIndex = (y * maskWidth + x) * 4
      if (value !== 255) {
        target[targetIndex] = value
        target[targetIndex + 3] = 255
      }
    }
  }
  context.putImageData(image, 0, 0)
  return canvas
}

function createMaxarOverlayCanvas(
  data: Uint8Array,
  width: number,
  height: number
): HTMLCanvasElement {
  const scale = Math.min(
    1,
    MAXAR_OVERLAY_TEXTURE_SIZE / Math.max(width, height)
  )
  const overlayWidth = Math.max(1, Math.round(width * scale))
  const overlayHeight = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = overlayWidth
  canvas.height = overlayHeight
  const context = canvas.getContext('2d')
  if (context == null) {
    throw new Error('Failed to create canvas context')
  }

  const image = context.createImageData(overlayWidth, overlayHeight)
  const target = image.data
  for (let y = 0; y < overlayHeight; y += 1) {
    const sourceY = Math.min(Math.floor(y / scale), height - 1)
    for (let x = 0; x < overlayWidth; x += 1) {
      const sourceX = Math.min(Math.floor(x / scale), width - 1)
      const value = data[sourceY * width + sourceX]
      const targetIndex = (y * overlayWidth + x) * 4
      if (value !== 255 && value >= MAXAR_WATER_THRESHOLD) {
        target[targetIndex] = 255
        target[targetIndex + 1] = 0
        target[targetIndex + 2] = 0
        target[targetIndex + 3] = MAXAR_OVERLAY_ALPHA
      } else {
        target[targetIndex + 3] = 0
      }
    }
  }
  context.putImageData(image, 0, 0)

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
