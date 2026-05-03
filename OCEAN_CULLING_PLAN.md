# Ocean Culling Plan

## Goal

Remove ocean/water from Google photorealistic 3D tiles using a Maxar 2m water mask without forcing high-detail Google LODs at distance.

The core rule is:

```text
full ocean -> cull whole tile
full land  -> keep tile unchanged
mixed      -> keep tile, discard only water fragments
unknown    -> keep tile unchanged
```

## Classification

Use the Maxar water mask to classify each tile footprint before deciding how to render it.

- `water`: the tile footprint is confidently all water.
- `land`: the tile footprint is confidently all land.
- `mixed`: the tile contains both land and water.
- `unknown`: the tile is outside mask coverage, has insufficient valid data, or cannot be classified safely.

Classification should be conservative. A tile should only be culled when the mask coverage is valid enough and the tile is confidently full ocean.

## Implementation Strategy

### 1. Stream Maxar Mask Tiles

Do not load the full Maxar 2m mask as one browser image for production.

Stream the Maxar water mask as low-cost tiles. The runtime should request only the mask tiles needed by currently visible Google tile footprints and camera distance.

Recommended tile payloads:

- low zoom: compact preclassified pyramid tiles
- mid zoom: 8-bit water-probability mask tiles
- high zoom: 8-bit water-probability mask tiles at finer Maxar resolution

Each mask tile should include or imply:

- tile coordinate
- geographic rectangle
- resolution or mip level
- valid/no-data coverage
- water threshold convention

The tile cache should be independent from Google tiles. Google tiles are classified by footprint; the Maxar mask tile loader only supplies the raster/mask data needed to answer that footprint query or shader sample.

### ArcticData Source Layout

The Maxar/EarthDEM source endpoint is:

```text
https://arcticdata.io/data/10.18739/A2610VT7V/
```

Important discovered layout:

```text
/data/10.18739/A2610VT7V/
  filelist.txt
  earthdem/
    earthdem_03_conus/
      utm18n_46_05_1_1/
        output/
          utm18n_46_05_1_1_prob_v1.0.tif
          utm18n_46_05_1_1_coast_tide_thre50_v1.0.shp
          utm18n_46_05_1_1_coast_tide_thre50_v1.0.dbf
          utm18n_46_05_1_1_coast_tide_thre50_v1.0.shx
          utm18n_46_05_1_1_bound_v1.0.tif
          utm18n_46_05_1_1_low.tif
          utm18n_46_05_1_1_nov_v1.0.tif
```

The current Manhattan test mosaic was built from four source probability TIFFs:

```text
earthdem/earthdem_03_conus/utm18n_46_05_1_1/output/utm18n_46_05_1_1_prob_v1.0.tif
earthdem/earthdem_03_conus/utm18n_46_05_1_2/output/utm18n_46_05_1_2_prob_v1.0.tif
earthdem/earthdem_03_conus/utm18n_45_05_2_1/output/utm18n_45_05_2_1_prob_v1.0.tif
earthdem/earthdem_03_conus/utm18n_45_05_2_2/output/utm18n_45_05_2_2_prob_v1.0.tif
```

Observed source TIFF properties for `utm18n_46_05_1_1_prob_v1.0.tif`:

- URL size: about 54 MiB.
- Image size: 37001 x 37001.
- Format: 8-bit, single-channel GeoTIFF.
- Compression: LZW.
- Internal tile size: 256 x 256.
- Tile offset and byte-count tables are present in the TIFF IFD.
- Server supports `Accept-Ranges: bytes`.
- Server responds with CORS headers for a localhost Storybook origin.

This means direct browser range streaming is possible, but not without a GeoTIFF/LZW reader. The browser cannot use these TIFFs directly as simple image textures.

Recommended production path:

1. Use the ArcticData GeoTIFFs as source data.
2. Convert them offline into a web-friendly geographic mask tile pyramid.
3. Stream those generated PNG/WebP/KTX2 mask tiles at runtime.
4. Keep the source GeoTIFF URL and UTM metadata in the generated manifest for traceability.

Direct runtime GeoTIFF range streaming is a possible later path if a dependency such as a browser-capable GeoTIFF decoder is acceptable.

### 2. Precompute a Mask Pyramid

Generate a compact sidecar from the Maxar 2m raster.

Each pyramid node should store enough information to answer tile-footprint queries cheaply, for example:

- min/max water value
- valid coverage
- water coverage
- class: land, water, mixed, unknown

This avoids scanning the full Maxar raster at runtime. Runtime classification should be close to O(1) or a small bounded rectangle query.

### 3. Cull Full-Ocean Tiles

In the tiles renderer plugin, classify the tile rectangle.

If a tile is confidently `water`, mask it out through `calculateTileViewError`:

```ts
target.inView = false
return true
```

This prevents full-ocean tiles from being selected for rendering.

### 4. Keep Full-Land and Unknown Tiles

If a tile is `land`, leave it alone.

If a tile is `unknown`, leave it alone. This avoids deleting valid land where the Maxar mask has no coverage or no-data pixels.

### 5. Discard Water Fragments in Mixed Tiles

For `mixed` tiles, keep the Google tile at its normal LOD and patch only that tile's materials.

The patched shader samples the Maxar water mask and discards fragments where the mask says water:

```glsl
float water = texture2D(waterMask, waterMaskUv).r;

if (water >= waterThreshold) {
  discard;
}
```

This removes only the ocean part of a mixed tile while preserving land geometry and imagery.

## Why Discard Still Has Draw Cost

`discard` happens inside the fragment shader. The GPU still has to issue the draw call, run the vertex shader, rasterize triangles, run enough fragment shader work to sample the mask, and then decide whether to discard the fragment.

So discard removes the final pixel output, but it does not eliminate all rendering work.

It is still expected to be cheaper than forcing deeper Google LODs because it avoids extra tile downloads, glTF/Draco decode, CPU parsing, geometry allocation, GPU memory, and extra child-tile draw calls.

## Optimizations

- Classify tiles with a precomputed Maxar pyramid/sidecar, not runtime raster scans.
- Stream Maxar mask tiles by demand, with an LRU cache and request deduplication.
- Select Maxar mask resolution from camera distance or Google tile screen-space error.
- Only patch materials for `mixed` tiles.
- Cache classifications per tile with a `WeakMap`.
- Use mipmapped water-mask textures so distant mixed tiles sample lower-resolution data.
- Use a conservative threshold and valid-coverage requirement for full-ocean culling.
- Add a small dilation/erosion margin around shorelines to reduce flicker and mask mismatch.
- Leave `unknown` tiles unchanged.
- Skip fragment masking for very small screen-space mixed tiles if the visual difference is not worth the fill cost.
- Reuse patched material variants where possible.
- Render an ocean or globe surface behind discarded fragments so removed water reveals clean water instead of empty background.
- Consider a depth/stencil water-mask prepass later if fragment discard becomes the bottleneck.

## Optional Depth/Stencil Variant

A later optimization is to render a low-cost water mask into depth or stencil before Google tiles render.

Then Google water fragments can fail depth/stencil before running the full Google material shader. This can be cheaper than shader discard for large water-heavy mixed tiles, but it requires a depth/stencil-capable render path.

The current Storybook setup uses `gl={{ depth: false }}`, so material discard is the simpler first implementation.

## Validation

Test at three camera distances:

- Far: full-ocean tiles should disappear without forcing high Google LODs.
- Mid: mixed shoreline tiles should retain land and remove obvious water.
- Near: shoreline mask quality should be acceptable, with no severe flicker or land loss.

Track:

- tile classification counts
- number of culled full-ocean tiles
- number of mixed tiles using patched materials
- frame time
- tile download/parse pressure
- visual shoreline errors
