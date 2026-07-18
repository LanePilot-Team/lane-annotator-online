import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  connectedTargetWayForSegment,
  deriveIntersectionPresentation,
  favouriteIntersectionKey,
  matchesTagFilter,
  normalizeTargetRelation,
  resolveTargetWaySelection,
  segmentTriageTags,
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

{
  const selection = resolveTargetWaySelection({
    intersection: { connected_ways: [{ osm_way_id: 200, name: "Connected Road" }] },
    currentSegmentKey: "way/100",
    clickedSegmentKey: "way/300#2",
    clickedRoadName: "Offset Road",
  });
  assert(selection.ok && selection.kind === "offset_candidate", "non-connected map way becomes an offset candidate");
  assert(selection.targetSegmentKey === "way/300" && selection.targetRoad === "Offset Road", "offset candidate normalizes key and preserves road name");
  assert(normalizeTargetRelation({ kind: "offset_intersection", reason: "other", note: "separate OSM nodes" })?.note === "separate OSM nodes", "other offset relation preserves explanation");
  assert(normalizeTargetRelation({ kind: "offset_intersection", reason: "other", note: "" }) === null, "other offset relation requires explanation");
}

{
  const favourite = favouriteIntersectionKey("way/100", "node/200");
  const tags = segmentTriageTags({
    segmentKey: "way/100",
    annotations: [{
      annotation_metadata: { note: "needs revisit" },
      lane_nav_tags: {
        osm_review_tags: { osm_review_note: "geometry gap" },
        offset_relations: [{ to_segment_key: "way/300", kind: "offset_intersection", reason: "staggered_cross_intersection", note: null }],
        taiwan_motorcycle_tags: { movement_rules: [] },
      },
      object_identity: { nav_segment_key: "way/100", applies_to_intersection_key: "node/200" },
    }],
    favouriteIntersectionKeys: new Set([favourite]),
  });
  assert(tags.has("has_notes") && tags.has("offset_intersection") && tags.has("favourite"), "triage tags derive notes, offset relations, and favourites");
  assert(!matchesTagFilter(tags, new Set(["has_notes", "priority"]), "and"), "AND tag filter requires every selected tag");
  assert(matchesTagFilter(tags, new Set(["has_notes", "priority"]), "or"), "OR tag filter accepts any selected tag");
}

console.log("ALL PASS");
