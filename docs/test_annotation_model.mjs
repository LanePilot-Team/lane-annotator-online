import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  connectedTargetWayForSegment,
  deriveIntersectionPresentation,
  targetRoadNameForWay,
} = require("./annotation_model.js");

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
};

{
  const presentation = deriveIntersectionPresentation({
    currentSegmentKey: "way/100",
    currentRoadName: "後昌路",
    intersection: {
      intersection_name: "後昌路 / 未命名道路",
      connected_ways: [
        { osm_way_id: 100, name: "後昌路" },
        { osm_way_id: 1398634356 },
      ],
    },
  });

  assert(presentation.targetSegmentKey === "way/1398634356", "unnamed target way is auto-selected by OSM way id");
  assert(presentation.targetRoad === "未命名道路 (way/1398634356)", "unnamed target road keeps a readable OSM way id label");
  assert(presentation.ambiguous === false, "single unnamed crossing way is not ambiguous");
}

{
  const presentation = deriveIntersectionPresentation({
    currentSegmentKey: "way/1398634356",
    currentRoadName: "",
    intersection: {
      connected_ways: [
        { osm_way_id: 1398634356 },
        { osm_way_id: 200, name: "後昌路" },
      ],
    },
  });

  assert(presentation.displayName === "未命名道路 (way/1398634356) / 後昌路", "unnamed selected way can still form an intersection display name");
  assert(presentation.targetSegmentKey === "way/200", "named target remains selectable when selected way is unnamed");
}

{
  const presentation = deriveIntersectionPresentation({
    currentSegmentKey: "way/100",
    currentRoadName: "後昌路",
    intersection: {
      connected_ways: [
        { osm_way_id: 100, name: "後昌路" },
        { osm_way_id: 200 },
        { osm_way_id: 300, name: "右昌街" },
      ],
    },
  });

  assert(presentation.targetSegmentKey === null, "multiple crossing ways remain ambiguous");
  assert(presentation.ambiguous === true, "ambiguous crossings still require manual target selection");
}

{
  assert(targetRoadNameForWay({ osm_way_id: 456, name: "  " }) === "未命名道路 (way/456)", "blank names fall back to way id");
  assert(targetRoadNameForWay({ osm_way_id: 789, name: "藍昌路" }) === "藍昌路", "named ways keep their road name");
}

{
  const intersection = {
    connected_ways: [
      { osm_way_id: 100, name: "後昌路" },
      { osm_way_id: 200 },
    ],
  };
  const allowed = connectedTargetWayForSegment({
    intersection,
    currentSegmentKey: "way/100",
    clickedSegmentKey: "way/200#1",
  });
  assert(allowed.ok && allowed.targetSegmentKey === "way/200", "Ctrl+click accepts only connected target ways and normalizes split keys");

  const sameAsCurrent = connectedTargetWayForSegment({
    intersection,
    currentSegmentKey: "way/100",
    clickedSegmentKey: "way/100",
  });
  assert(!sameAsCurrent.ok && sameAsCurrent.reason === "same_as_current", "Ctrl+click rejects the currently selected way");

  const notConnected = connectedTargetWayForSegment({
    intersection,
    currentSegmentKey: "way/100",
    clickedSegmentKey: "way/300",
  });
  assert(!notConnected.ok && notConnected.reason === "not_connected", "Ctrl+click rejects ways outside the selected intersection");
}

console.log("ALL PASS");
