import type { Meta, StoryFn } from '@storybook/react-vite'
import { useFrame, useThree } from '@react-three/fiber'
import { TilesPlugin } from '3d-tiles-renderer/r3f'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import {
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  LinearFilter,
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
const MAXAR_OVERLAY_SEGMENTS = 96
const MAXAR_FAR_MASK_ALTITUDE = 120
const MAXAR_FAR_MASK_ALPHA = 245
const MAXAR_MASK_TEXTURE_SIZES = [512, 1024, 2048] as const
const MAXAR_FAR_MASK_COLORS: Readonly<Record<MaxarMaskTextureSize, number>> = {
  512: 0x4e8cff,
  1024: 0xffba49,
  2048: 0x3fd284
}
const MAXAR_MASK_CAMERA_DISTANCE_TIERS: readonly MaxarMaskCameraDistanceTier[] = [
  { maximumCameraDistance: 18000, textureSize: 2048 },
  { maximumCameraDistance: 40000, textureSize: 1024 },
  { maximumCameraDistance: Infinity, textureSize: 512 }
]

let maxarWaterClassifierPromise:
  | Promise<WaterOccurrenceTileClassifier>
  | undefined
let maxarRasterImagePromise: Promise<MaxarRasterImage> | undefined

type MaxarMaskTextureSize = (typeof MAXAR_MASK_TEXTURE_SIZES)[number]

interface MaxarMaskCameraDistanceTier {
  readonly maximumCameraDistance: number
  readonly textureSize: MaxarMaskTextureSize
}

interface MaxarRasterImage {
  readonly width: number
  readonly height: number
  readonly classificationData: Uint8Array
  readonly maskCanvases: Map<MaxarMaskTextureSize, HTMLCanvasElement>
}

export default {
  title: 'atmosphere/Ocean Culling',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta

export const Manhattan: StoryFn = () => {
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
          <MaxarFarWaterMaskOverlay />
          <MaxarWaterMaskTilesPlugin />
        </>
      }
    />
  )
}

function MaxarWaterMaskTilesPlugin(): ReactElement | null {
  const classifier = useMaxarManhattanWaterClassifier()
  const maskTexture = useMaxarWaterMaskTexture()
  const args = useMemo(
    () =>
      classifier != null && maskTexture != null
        ? {
            classifier,
            coloredClasses: [],
            culledClasses: [],
            maskedClasses: ['water', 'shoreline'],
            maskAllIntersectingTiles: true,
            maskTexture,
            maskWaterThreshold: MAXAR_WATER_THRESHOLD / 255,
            debug: false
          }
        : undefined,
    [classifier, maskTexture]
  )

  if (args == null) {
    return null
  }

  return <TilesPlugin plugin={WaterOccurrenceTilesPlugin} args={args} />
}

function MaxarFarWaterMaskOverlay(): ReactElement | null {
  const textureSize = useMaxarMaskTextureSize()
  const texture = useMaxarTexture(getMaxarFarMaskCanvas, LinearFilter, textureSize)
  const geometry = useMemo(
    () =>
      createRectangleOverlayGeometry(
        MAXAR_WATER_PROBABILITY_RECTANGLE,
        MAXAR_OVERLAY_SEGMENTS,
        MAXAR_FAR_MASK_ALTITUDE
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
    <mesh geometry={geometry} renderOrder={999}>
      <meshBasicMaterial
        key={textureSize}
        color={MAXAR_FAR_MASK_COLORS[textureSize]}
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

function useMaxarWaterMaskTexture(): CanvasTexture | undefined {
  const textureSize = useMaxarMaskTextureSize()
  return useMaxarTexture(getMaxarMaskCanvas, NearestFilter, textureSize)
}

function useMaxarMaskTextureSize(): MaxarMaskTextureSize {
  const camera = useThree(({ camera }) => camera)
  const geodetic = useMemo(() => new Geodetic(), [])
  const nearestPosition = useMemo(() => new Vector3(), [])
  const [textureSize, setTextureSize] =
    useState<MaxarMaskTextureSize>(() =>
      getMaxarMaskTextureSize(camera.position, geodetic, nearestPosition)
    )
  const textureSizeRef = useRef(textureSize)

  useFrame(() => {
    const nextTextureSize = getMaxarMaskTextureSize(
      camera.position,
      geodetic,
      nearestPosition
    )
    if (textureSizeRef.current === nextTextureSize) {
      return
    }
    textureSizeRef.current = nextTextureSize
    setTextureSize(nextTextureSize)
  })

  return textureSize
}

function useMaxarTexture(
  getCanvas: (
    image: MaxarRasterImage,
    textureSize: MaxarMaskTextureSize
  ) => HTMLCanvasElement,
  magFilter: typeof LinearFilter | typeof NearestFilter,
  textureSize: MaxarMaskTextureSize
): CanvasTexture | undefined {
  const invalidate = useThree(({ invalidate }) => invalidate)
  const [texture, setTexture] = useState<CanvasTexture>()
  const textureRef = useRef<CanvasTexture>()
  const imageRef = useRef<MaxarRasterImage>()
  const textureSizeRef = useRef<MaxarMaskTextureSize>()

  const updateTextureImage = useCallback((textureSize: MaxarMaskTextureSize) => {
    textureSizeRef.current = textureSize
    const texture = textureRef.current
    const image = imageRef.current
    if (texture == null || image == null) {
      return
    }
    texture.image = getCanvas(image, textureSize)
    texture.needsUpdate = true
    invalidate()
  }, [getCanvas, invalidate])

  useEffect(() => {
    updateTextureImage(textureSize)
  }, [textureSize, updateTextureImage])

  useEffect(() => {
    let disposed = false
    loadMaxarRasterImage(MAXAR_WATER_PROBABILITY_PATH)
      .then(image => {
        if (disposed) {
          return
        }
        imageRef.current = image
        const initialTextureSize =
          textureSizeRef.current ?? MAXAR_MASK_TEXTURE_SIZES[0]
        const texture = new CanvasTexture(getCanvas(image, initialTextureSize))
        texture.flipY = true
        texture.generateMipmaps = true
        texture.minFilter = LinearMipmapLinearFilter
        texture.magFilter = magFilter
        texture.needsUpdate = true
        textureRef.current = texture
        textureSizeRef.current = initialTextureSize
        setTexture(texture)
        invalidate()
      })
      .catch((error: unknown) => {
        console.error(error)
      })
    return () => {
      disposed = true
      textureRef.current?.dispose()
      textureRef.current = undefined
      imageRef.current = undefined
    }
  }, [getCanvas, invalidate, magFilter])

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
    maskCanvases: new Map()
  }
}

function getMaxarMaskCanvas(
  image: MaxarRasterImage,
  textureSize: MaxarMaskTextureSize
): HTMLCanvasElement {
  let canvas = image.maskCanvases.get(textureSize)
  if (canvas == null) {
    canvas = createMaxarMaskCanvas(
      image.classificationData,
      image.width,
      image.height,
      textureSize
    )
    image.maskCanvases.set(textureSize, canvas)
  }
  return canvas
}

function getMaxarFarMaskCanvas(
  image: MaxarRasterImage,
  textureSize: MaxarMaskTextureSize
): HTMLCanvasElement {
  return createMaxarFarMaskCanvas(
    image.classificationData,
    image.width,
    image.height,
    textureSize
  )
}

function getMaxarMaskTextureSize(
  position: Vector3,
  geodetic: Geodetic,
  nearestPosition: Vector3
): MaxarMaskTextureSize {
  const distance = getMaxarCameraDistance(position, geodetic, nearestPosition)
  for (const tier of MAXAR_MASK_CAMERA_DISTANCE_TIERS) {
    if (distance <= tier.maximumCameraDistance) {
      return tier.textureSize
    }
  }
  return MAXAR_MASK_TEXTURE_SIZES[0]
}

function getMaxarCameraDistance(
  position: Vector3,
  geodetic: Geodetic,
  nearestPosition: Vector3
): number {
  if (position.lengthSq() === 0) {
    return Infinity
  }
  try {
    geodetic.setFromECEF(position)
  } catch {
    return Infinity
  }
  const longitude = clamp(
    geodetic.longitude,
    MAXAR_WATER_PROBABILITY_RECTANGLE.west,
    MAXAR_WATER_PROBABILITY_RECTANGLE.east
  )
  const latitude = clamp(
    geodetic.latitude,
    MAXAR_WATER_PROBABILITY_RECTANGLE.south,
    MAXAR_WATER_PROBABILITY_RECTANGLE.north
  )
  geodetic.set(longitude, latitude, 0).toECEF(nearestPosition)
  return position.distanceTo(nearestPosition)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function createMaxarMaskCanvas(
  data: Uint8Array,
  width: number,
  height: number,
  textureSize: MaxarMaskTextureSize
): HTMLCanvasElement {
  const scale = Math.min(1, textureSize / Math.max(width, height))
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

function createMaxarFarMaskCanvas(
  data: Uint8Array,
  width: number,
  height: number,
  textureSize: MaxarMaskTextureSize
): HTMLCanvasElement {
  const scale = Math.min(1, textureSize / Math.max(width, height))
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
      if (value !== 255 && value >= MAXAR_WATER_THRESHOLD) {
        target[targetIndex] = 255
        target[targetIndex + 1] = 255
        target[targetIndex + 2] = 255
        target[targetIndex + 3] = MAXAR_FAR_MASK_ALPHA
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
