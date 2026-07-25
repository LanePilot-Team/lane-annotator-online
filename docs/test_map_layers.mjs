import assert from "node:assert/strict";

globalThis.window = {};
await import("./map-layers.js");

const { buildFeatures, styleFor } = window.LanePilotMapLayers;
const geometry = {
  type: "LineString",
  coordinates: [[120.28, 22.68], [120.29, 22.69]],
};

const result = buildFeatures({
  primaryItems: [
    { nav_segment_key: "way/1", road_name: "主區道路", annotated: true, geometry },
  ],
  backgroundItemsByArea: new Map([
    ["area/a", [
      { nav_segment_key: "way/1", road_name: "重複道路", geometry },
      { nav_segment_key: "way/2", road_name: "背景候選", suggested: true, geometry },
    ]],
    ["area/b", [
      { nav_segment_key: "way/2", road_name: "另一個重複", geometry },
      { nav_segment_key: "way/3", road_name: "背景一般", geometry },
    ]],
  ]),
});

assert.equal(result.primary.features.length, 1);
assert.deepEqual(
  result.background.features.map((feature) => feature.properties.nav_segment_key),
  ["way/2", "way/3"],
);
assert.equal(result.background.features[0].properties.map_context, true);
assert.equal(styleFor({ annotated: true }, { context: true }).color, "#0b6e69");
assert.equal(styleFor({ annotated: true }, { context: true }).opacity, 0.35);
assert.equal(styleFor({ suggested: true }, { context: true }).color, "#9a5b16");
assert.equal(styleFor({}, { context: true }).color, "#8a928c");

console.log("ALL PASS");
