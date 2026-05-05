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
const MAXAR_MASK_TEXTURE_SIZES = [512, 768, 1024, 1536, 2048, 4096] as const
const MAXAR_CANVAS_CACHE_LIMIT = 2
const MAXAR_FAR_MASK_COLORS: Readonly<Record<MaxarMaskTextureSize, number>> = {
  512: 0x4e8cff,
  768: 0x47c7ff,
  1024: 0xffba49,
  1536: 0xc8d84a,
  2048: 0x3fd284,
  4096: 0xffffff
}
const MAXAR_MASK_CAMERA_DISTANCE_TIERS: readonly MaxarMaskCameraDistanceTier[] = [
  { maximumCameraDistance: 9000, textureSize: 4096 },
  { maximumCameraDistance: 18000, textureSize: 2048 },
  { maximumCameraDistance: 26000, textureSize: 1536 },
  { maximumCameraDistance: 40000, textureSize: 1024 },
  { maximumCameraDistance: 65000, textureSize: 768 },
  { maximumCameraDistance: Infinity, textureSize: 512 }
]

let maxarWaterClassifierPromise:
  | Promise<WaterOccurrenceTileClassifier>
  | undefined
let maxarRasterImagePromise: Promise<MaxarRasterImage> | undefined
let maxarCanvasWorker: Worker | undefined
let maxarCanvasWorkerRequestId = 0
let maxarCanvasWorkerSourceId = 0
const maxarCanvasWorkerSources = new Set<number>()
const maxarCanvasWorkerRequests = new Map<
  number,
  (result: MaxarGeneratedCanvas) => void
>()

type MaxarMaskTextureSize = (typeof MAXAR_MASK_TEXTURE_SIZES)[number]

interface MaxarMaskCameraDistanceTier {
  readonly maximumCameraDistance: number
  readonly textureSize: MaxarMaskTextureSize
}

interface MaxarTextureOptions {
  readonly generateMipmaps: boolean
  readonly minFilter: CanvasTexture['minFilter']
  readonly magFilter: CanvasTexture['magFilter']
  readonly textureSize: MaxarMaskTextureSize
}

interface MaxarRasterImage {
  readonly width: number
  readonly height: number
  readonly classificationData: Uint8Array
  readonly maskCanvases: Map<MaxarMaskTextureSize, HTMLCanvasElement>
  readonly farMaskCanvases: Map<MaxarMaskTextureSize, HTMLCanvasElement>
  workerSourceId?: number
}

interface MaxarGeneratedCanvas {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
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
        <MaxarOceanCulling />
      }
    />
  )
}

function MaxarOceanCulling(): ReactElement {
  const textureSize = useMaxarMaskTextureSize()
  return (
    <>
      <MaxarFarWaterMaskOverlay textureSize={textureSize} />
      <MaxarWaterMaskTilesPlugin textureSize={textureSize} />
    </>
  )
}

interface MaxarMaskTextureSizeProps {
  readonly textureSize: MaxarMaskTextureSize
}

function MaxarWaterMaskTilesPlugin({
  textureSize
}: MaxarMaskTextureSizeProps): ReactElement | null {
  const classifier = useMaxarManhattanWaterClassifier()
  const maskTexture = useMaxarWaterMaskTexture(textureSize)
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

function MaxarFarWaterMaskOverlay({
  textureSize
}: MaxarMaskTextureSizeProps): ReactElement | null {
  const texture = useMaxarTexture(
    getCachedMaxarFarMaskCanvas,
    createAndCacheMaxarFarMaskCanvas,
    {
      generateMipmaps: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      textureSize
    }
  )
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

function useMaxarWaterMaskTexture(
  textureSize: MaxarMaskTextureSize
): CanvasTexture | undefined {
  return useMaxarTexture(
    getCachedMaxarMaskCanvas,
    createAndCacheMaxarMaskCanvas,
    {
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: NearestFilter,
      textureSize
    }
  )
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
  getCachedCanvas: (
    image: MaxarRasterImage,
    textureSize: MaxarMaskTextureSize
  ) => HTMLCanvasElement | undefined,
  createCanvas: (
    image: MaxarRasterImage,
    textureSize: MaxarMaskTextureSize
  ) => Promise<HTMLCanvasElement>,
  options: MaxarTextureOptions
): CanvasTexture | undefined {
  const { generateMipmaps, minFilter, magFilter, textureSize } = options
  const invalidate = useThree(({ invalidate }) => invalidate)
  const [texture, setTexture] = useState<CanvasTexture>()
  const textureRef = useRef<CanvasTexture | undefined>(undefined)
  const imageRef = useRef<MaxarRasterImage | undefined>(undefined)
  const textureSizeRef = useRef<MaxarMaskTextureSize | undefined>(undefined)
  const generationRef = useRef(0)

  const updateTextureCanvas = useCallback((canvas: HTMLCanvasElement) => {
    const texture = new CanvasTexture(canvas)
    texture.flipY = true
    texture.generateMipmaps = generateMipmaps
    texture.minFilter = minFilter
    texture.magFilter = magFilter
    texture.needsUpdate = true
    textureRef.current?.dispose()
    textureRef.current = texture
    setTexture(texture)
    invalidate()
  }, [generateMipmaps, invalidate, magFilter, minFilter])

  const updateTextureImage = useCallback((textureSize: MaxarMaskTextureSize) => {
    textureSizeRef.current = textureSize
    const image = imageRef.current
    if (image == null) {
      return
    }

    const cachedCanvas = getCachedCanvas(image, textureSize)
    if (cachedCanvas != null) {
      generationRef.current += 1
      updateTextureCanvas(cachedCanvas)
      return
    }

    const generation = generationRef.current + 1
    generationRef.current = generation
    scheduleIdle(() => {
      createCanvas(image, textureSize)
        .then(canvas => {
          if (
            generationRef.current === generation &&
            textureSizeRef.current === textureSize
          ) {
            updateTextureCanvas(canvas)
          }
        })
        .catch((error: unknown) => {
          console.error(error)
        })
    })
  }, [createCanvas, getCachedCanvas, updateTextureCanvas])

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
        textureSizeRef.current = initialTextureSize
        updateTextureImage(initialTextureSize)
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
  }, [updateTextureImage])

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
    maskCanvases: new Map(),
    farMaskCanvases: new Map()
  }
}

function getCachedMaxarMaskCanvas(
  image: MaxarRasterImage,
  textureSize: MaxarMaskTextureSize
): HTMLCanvasElement | undefined {
  return image.maskCanvases.get(textureSize)
}

function createAndCacheMaxarMaskCanvas(
  image: MaxarRasterImage,
  textureSize: MaxarMaskTextureSize
): Promise<HTMLCanvasElement> {
  return createMaxarCanvasInWorker(image, textureSize, false).then(canvas => {
    cacheMaxarCanvas(image.maskCanvases, textureSize, canvas)
    return canvas
  })
}

function getCachedMaxarFarMaskCanvas(
  image: MaxarRasterImage,
  textureSize: MaxarMaskTextureSize
): HTMLCanvasElement | undefined {
  return image.farMaskCanvases.get(textureSize)
}

function createAndCacheMaxarFarMaskCanvas(
  image: MaxarRasterImage,
  textureSize: MaxarMaskTextureSize
): Promise<HTMLCanvasElement> {
  return createMaxarCanvasInWorker(image, textureSize, true).then(canvas => {
    cacheMaxarCanvas(image.farMaskCanvases, textureSize, canvas)
    return canvas
  })
}

function cacheMaxarCanvas(
  cache: Map<MaxarMaskTextureSize, HTMLCanvasElement>,
  textureSize: MaxarMaskTextureSize,
  canvas: HTMLCanvasElement
): void {
  cache.delete(textureSize)
  cache.set(textureSize, canvas)
  while (cache.size > MAXAR_CANVAS_CACHE_LIMIT) {
    const oldestTextureSize = cache.keys().next().value
    if (oldestTextureSize == null) {
      return
    }
    cache.delete(oldestTextureSize)
  }
}

async function createMaxarCanvasInWorker(
  image: MaxarRasterImage,
  textureSize: MaxarMaskTextureSize,
  farMask: boolean
): Promise<HTMLCanvasElement> {
  if (typeof Worker === 'undefined') {
    return farMask
      ? createMaxarFarMaskCanvas(
          image.classificationData,
          image.width,
          image.height,
          textureSize
        )
      : createMaxarMaskCanvas(
          image.classificationData,
          image.width,
          image.height,
          textureSize
        )
  }

  const worker = getMaxarCanvasWorker()
  const sourceId = getMaxarWorkerSourceId(image, worker)
  const id = ++maxarCanvasWorkerRequestId
  const result = await new Promise<MaxarGeneratedCanvas>(resolve => {
    maxarCanvasWorkerRequests.set(id, resolve)
    worker.postMessage({
      id,
      sourceId,
      width: image.width,
      height: image.height,
      textureSize,
      farMask,
      waterThreshold: MAXAR_WATER_THRESHOLD,
      farMaskAlpha: MAXAR_FAR_MASK_ALPHA
    })
  })
  const canvas = document.createElement('canvas')
  canvas.width = result.width
  canvas.height = result.height
  const context = canvas.getContext('2d')
  if (context == null) {
    throw new Error('Failed to create canvas context')
  }
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(result.data),
      result.width,
      result.height
    ),
    0,
    0
  )
  return canvas
}

function getMaxarWorkerSourceId(
  image: MaxarRasterImage,
  worker: Worker
): number {
  image.workerSourceId ??= ++maxarCanvasWorkerSourceId
  if (!maxarCanvasWorkerSources.has(image.workerSourceId)) {
    maxarCanvasWorkerSources.add(image.workerSourceId)
    const dataBuffer = image.classificationData.slice().buffer
    worker.postMessage({
      type: 'source',
      sourceId: image.workerSourceId,
      data: dataBuffer
    }, [dataBuffer])
  }
  return image.workerSourceId
}

function getMaxarCanvasWorker(): Worker {
  if (maxarCanvasWorker != null) {
    return maxarCanvasWorker
  }
  const worker = new Worker(URL.createObjectURL(new Blob([`
const sources = new Map()
self.onmessage = event => {
  if (event.data.type === 'source') {
    sources.set(event.data.sourceId, new Uint8Array(event.data.data))
    return
  }
  const {
    id,
    sourceId,
    width,
    height,
    textureSize,
    farMask,
    waterThreshold,
    farMaskAlpha
  } = event.data
  const source = sources.get(sourceId)
  if (source == null) {
    throw new Error('Missing Maxar source data')
  }
  const scale = Math.min(1, textureSize / Math.max(width, height))
  const maskWidth = Math.max(1, Math.round(width * scale))
  const maskHeight = Math.max(1, Math.round(height * scale))
  const target = new Uint8ClampedArray(maskWidth * maskHeight * 4)
  for (let y = 0; y < maskHeight; y += 1) {
    const sourceYStart = Math.floor(y / scale)
    const sourceYEnd = Math.min(Math.ceil((y + 1) / scale), height)
    for (let x = 0; x < maskWidth; x += 1) {
      const sourceXStart = Math.floor(x / scale)
      const sourceXEnd = Math.min(Math.ceil((x + 1) / scale), width)
      let value = -1
      for (let sourceY = sourceYStart; sourceY < sourceYEnd; sourceY += 1) {
        const sourceRowIndex = sourceY * width
        for (
          let sourceX = sourceXStart;
          sourceX < sourceXEnd;
          sourceX += 1
        ) {
          const sourceValue = source[sourceRowIndex + sourceX]
          if (sourceValue !== 255) {
            value = Math.max(value, sourceValue)
          }
        }
      }
      const targetIndex = (y * maskWidth + x) * 4
      if (farMask) {
        if (value >= waterThreshold) {
          target[targetIndex] = 255
          target[targetIndex + 1] = 255
          target[targetIndex + 2] = 255
          target[targetIndex + 3] = farMaskAlpha
        }
      } else if (value >= 0) {
        target[targetIndex] = value
        target[targetIndex + 3] = 255
      }
    }
  }
  self.postMessage({ id, width: maskWidth, height: maskHeight, data: target }, [
    target.buffer
  ])
}
`], { type: 'text/javascript' })))
  worker.onmessage = (
    event: MessageEvent<MaxarGeneratedCanvas & { readonly id: number }>
  ) => {
    const { id, ...result } = event.data
    const resolve = maxarCanvasWorkerRequests.get(id)
    if (resolve != null) {
      maxarCanvasWorkerRequests.delete(id)
      resolve(result)
    }
  }
  maxarCanvasWorker = worker
  return worker
}

function scheduleIdle(callback: () => void): void {
  const requestIdleCallback = (
    window as Window & {
      requestIdleCallback?: (callback: () => void) => number
    }
  ).requestIdleCallback
  if (requestIdleCallback != null) {
    requestIdleCallback(callback)
  } else {
    window.setTimeout(callback, 0)
  }
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
    const sourceYStart = Math.floor(y / scale)
    const sourceYEnd = Math.min(Math.ceil((y + 1) / scale), height)
    for (let x = 0; x < maskWidth; x += 1) {
      const sourceXStart = Math.floor(x / scale)
      const sourceXEnd = Math.min(Math.ceil((x + 1) / scale), width)
      let value = -1
      for (let sourceY = sourceYStart; sourceY < sourceYEnd; sourceY += 1) {
        const sourceRowIndex = sourceY * width
        for (let sourceX = sourceXStart; sourceX < sourceXEnd; sourceX += 1) {
          const sourceValue = data[sourceRowIndex + sourceX]
          if (sourceValue !== 255) {
            value = Math.max(value, sourceValue)
          }
        }
      }
      const targetIndex = (y * maskWidth + x) * 4
      if (value >= 0) {
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
    const sourceYStart = Math.floor(y / scale)
    const sourceYEnd = Math.min(Math.ceil((y + 1) / scale), height)
    for (let x = 0; x < maskWidth; x += 1) {
      const sourceXStart = Math.floor(x / scale)
      const sourceXEnd = Math.min(Math.ceil((x + 1) / scale), width)
      let value = -1
      for (let sourceY = sourceYStart; sourceY < sourceYEnd; sourceY += 1) {
        const sourceRowIndex = sourceY * width
        for (let sourceX = sourceXStart; sourceX < sourceXEnd; sourceX += 1) {
          const sourceValue = data[sourceRowIndex + sourceX]
          if (sourceValue !== 255) {
            value = Math.max(value, sourceValue)
          }
        }
      }
      const targetIndex = (y * maskWidth + x) * 4
      if (value >= MAXAR_WATER_THRESHOLD) {
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
