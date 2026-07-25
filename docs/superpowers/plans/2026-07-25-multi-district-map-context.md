# 多行政區地圖背景圖層 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the annotation/list district single-select while showing it as a full-strength map layer and allowing any number of manifest-backed districts as muted, status-aware map context.

**Architecture:** `web-adapter.js` continues loading the selected district's configured context for detail lookup, but `/api/map-segments` gains `map_scope=primary` to return only the requested shard. A small pure map-layer module builds deduplicated feature collections and styles; `app.js` owns request cancellation, cache, checkboxes, and two Leaflet layers.

**Tech Stack:** Static GitHub Pages, browser JavaScript, Leaflet, Node built-in test runner pattern, JSONL district shards.

## Global Constraints

- The selected district is the only list, search, editing, and annotation-assignment scope.
- Only manifest-backed districts may be selected as map context; load every district only after the user selects or checks it.
- Deduplicate by `object_identity.nav_segment_key`; the primary district always wins.
- Do not crop LineString geometry at administrative borders.
- Preserve status semantics: unannotated gray, annotated green, suggested orange; context styling is muted, not relabeled.

---

### Task 1: Make the map endpoint expose primary-shard-only results

**Files:**
- Modify: `docs/web-adapter.js:205-270,845-856`
- Modify: `docs/test_web_adapter.mjs:45-110`

**Interfaces:**
- Consumes: `ensureDistrict(areaId)`, which still loads `store.segments` for the primary shard and `store.mapSegments` for detailed context.
- Produces: `/api/map-segments?district_area_id=<id>&map_scope=primary`, returning summaries from `store.segments`; omitted `map_scope` remains backward-compatible and returns `store.mapSegments`.

- [ ] **Step 1: Write the failing adapter assertions**

```js
const ZUOYING = "area/4212533";
{
  const { data } = await api(`/api/map-segments?district_area_id=${encodeURIComponent(ZUOYING)}&map_scope=primary`);
  assert(data.total === 2351, "Zuoying primary map has exactly its shard roads");
  assert(data.items.every((item) => item.geometry?.type === "LineString"), "primary map roads have geometry");
}
{
  const { data } = await api(`/api/map-segments?district_area_id=${encodeURIComponent(NANZI)}&map_scope=primary`);
  assert(data.total === 3184, "Nanzi primary map excludes automatic context roads");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node docs/test_web_adapter.mjs`

Expected: FAIL because `map_scope=primary` still returns merged `store.mapSegments`.

- [ ] **Step 3: Add the minimal endpoint branch**

```js
const mapScope = (params.get("map_scope") || "context").trim();
const sourceSegments = mapScope === "primary" ? store.segments : store.mapSegments;
const items = sourceSegments.map((segment) => {
  const key = segment.object_identity.nav_segment_key;
  return summarizeSegment(segment, bySegment.get(key) ?? null, statusesBySegment.get(key) ?? []);
});
```

Keep `ensureDistrict(areaId)` unchanged so `/api/segment` and nearby-intersection lookup retain their existing context behavior.

- [ ] **Step 4: Run the adapter test to verify it passes**

Run: `node docs/test_web_adapter.mjs`

Expected: `ALL PASS`.

- [ ] **Step 5: Commit**

```powershell
git add docs/web-adapter.js docs/test_web_adapter.mjs
git commit -m "feat: expose primary district map segments"
```

### Task 2: Isolate map feature merging and styling behind a testable module

**Files:**
- Create: `docs/map-layers.js`
- Create: `docs/test_map_layers.mjs`
- Modify: `docs/index.html:20-25`

**Interfaces:**
- Produces `window.LanePilotMapLayers.buildFeatures({ primaryItems, backgroundItemsByArea })` and `styleFor(properties, { context, selectedKey, targetKey })`.
- `buildFeatures` returns `{ primary, background }`; each is a GeoJSON FeatureCollection and no background feature has a key owned by primary or an earlier background area.

- [ ] **Step 1: Write the failing pure-module test**

```js
const result = buildFeatures({
  primaryItems: [{ nav_segment_key: "way/1", annotated: true, geometry }],
  backgroundItemsByArea: new Map([
    ["area/a", [{ nav_segment_key: "way/1", geometry }, { nav_segment_key: "way/2", suggested: true, geometry }]],
    ["area/b", [{ nav_segment_key: "way/2", geometry }, { nav_segment_key: "way/3", geometry }]],
  ]),
});
assert.equal(result.primary.features.length, 1);
assert.deepEqual(result.background.features.map((f) => f.properties.nav_segment_key), ["way/2", "way/3"]);
assert.equal(styleFor({ annotated: true }, { context: true }).opacity, 0.35);
assert.equal(styleFor({ annotated: true }, { context: true }).color, "#0b6e69");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node docs/test_map_layers.mjs`

Expected: FAIL because `map-layers.js` does not yet exist.

- [ ] **Step 3: Implement the module and load it before `app.js`**

```js
function styleFor(properties, { context = false, selectedKey = null, targetKey = null } = {}) {
  const selected = properties.nav_segment_key === selectedKey;
  const target = properties.nav_segment_key === targetKey;
  const color = selected ? "#a13a3a" : target ? "#2563a8" : properties.annotated ? "#0b6e69" : properties.suggested ? "#9a5b16" : "#8a928c";
  return { color, weight: selected ? 8 : context ? 3 : 5, opacity: context ? 0.35 : 0.9 };
}
```

Use a `Set` of claimed keys while adding primary features first and background areas in checkbox order. Add `<script src="./map-layers.js"></script>` immediately before the existing `app.js` script tag.

- [ ] **Step 4: Run the module test to verify it passes**

Run: `node docs/test_map_layers.mjs`

Expected: all assertions pass.

- [ ] **Step 5: Commit**

```powershell
git add docs/map-layers.js docs/test_map_layers.mjs docs/index.html
git commit -m "feat: add map layer merge helpers"
```

### Task 3: Add background-district controls and two Leaflet layers

**Files:**
- Modify: `docs/index.html:36-42,139-147`
- Modify: `docs/app.js:1-25,517-531,664-685,928-965,1061-1130`

**Interfaces:**
- Consumes: `/api/areas`, primary map endpoint, `LanePilotMapLayers`.
- Produces: `state.backgroundAreaIds`, `state.mapItemsByArea`, `renderMapLayers()` and a checkbox control with `id="mapContextDistricts"`.

- [ ] **Step 1: Add a failing UI-state assertion to `docs/test_map_layers.mjs`**

```js
const result = buildFeatures({ primaryItems: [], backgroundItemsByArea: new Map([["area/a", [{ nav_segment_key: "way/1", geometry }]])] });
assert.equal(result.background.features[0].properties.map_context, true);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node docs/test_map_layers.mjs`

Expected: FAIL because background feature properties do not identify context yet.

- [ ] **Step 3: Implement UI and loading flow**

Add a compact checkbox panel below the district selector. Render options from `state.areas.districts`, excluding the selected district. On checking an area, fetch:

```js
const params = new URLSearchParams({ district_area_id: areaId, map_scope: "primary" });
const data = await fetchJson(`/api/map-segments?${params}`);
state.mapItemsByArea.set(areaId, data.items);
state.backgroundAreaIds.add(areaId);
renderMapLayers();
```

On unchecking, delete only that id from `backgroundAreaIds` and call `renderMapLayers()`. On primary district change, clear `backgroundAreaIds`, `mapItemsByArea`, checkbox markup, and both layers before the new primary request completes. Maintain a monotonically increasing map request id and discard stale responses.

In `initMap`, create `state.primarySegmentLayer` and `state.backgroundSegmentLayer`. `renderMapLayers()` calls `buildFeatures`, sends primary and background collections to their respective layers, and applies `styleFor(..., { context: false })` and `styleFor(..., { context: true })`. Preserve the current map click callback for both layers.

- [ ] **Step 4: Run focused and regression tests**

Run: `node docs/test_map_layers.mjs; node docs/test_web_adapter.mjs`

Expected: both commands pass; a primary duplicate is visible only in the primary collection and context styling retains the green/orange/gray color.

- [ ] **Step 5: Commit**

```powershell
git add docs/index.html docs/app.js docs/map-layers.js docs/test_map_layers.mjs
git commit -m "feat: add multi-district map context controls"
```

### Task 4: Verify actual UI behavior and final regression suite

**Files:**
- Modify only if verification exposes a reproducible defect: files from Tasks 1-3.

- [ ] **Step 1: Run static and automated verification**

Run: `node docs/test_annotation_model.mjs; node docs/test_web_adapter.mjs; node docs/test_map_layers.mjs; git diff --check`

Expected: every Node test ends successfully and `git diff --check` has no output.

- [ ] **Step 2: Perform a browser smoke test**

Select 左營區 and confirm its complete primary road network appears. Check two other available districts and confirm muted gray/green/orange context roads appear. Uncheck one and confirm only its roads disappear. Change the primary district and confirm all context checks clear and the list remains scoped to the new primary district.

- [ ] **Step 3: Commit any verification-only correction**

```powershell
git add docs
git commit -m "fix: preserve primary map scope during context changes"
```
