(function initLaneAnnotationModel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LaneAnnotationModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLaneAnnotationModel() {
  const DIRECTIONS = new Set(["forward", "backward"]);
  const MOVEMENTS = new Set(["left", "right", "through", "uturn"]);

  function contextKey(identity) {
    const segment = identity?.nav_segment_key;
    const direction = identity?.approach_direction;
    if (!segment || !DIRECTIONS.has(direction)) return null;
    if (identity.context_scope === "intersection_approach") {
      return identity.intersection_key ? `${segment}@${identity.intersection_key}/${direction}` : null;
    }
    return identity.context_scope === "segment_direction" ? `${segment}/${direction}` : null;
  }

  function movementKey(fromContextKey, toSegmentKey, movement) {
    if (!fromContextKey || !toSegmentKey || !MOVEMENTS.has(movement)) return null;
    return `${fromContextKey}->${toSegmentKey}/${movement}`;
  }

  function movementIdentity(fromContextKey, toSegmentKey, targetRoad, movement) {
    if (toSegmentKey) return movementKey(fromContextKey, toSegmentKey, movement);
    const road = String(targetRoad || "").trim();
    if (!fromContextKey || !road || !MOVEMENTS.has(movement)) return null;
    return `${fromContextKey}->road:${encodeURIComponent(road)}/${movement}`;
  }

  function annotationHasEffectiveContent(annotation) {
    const laneTags = annotation?.lane_nav_tags || {};
    const movementRules = laneTags.taiwan_motorcycle_tags?.movement_rules || [];
    const laneProfiles = laneTags.lane_detail_tags?.lane_profiles || [];
    return movementRules.length > 0 || laneProfiles.length > 0;
  }

  function deriveTwoStageRule(twoStageSignExists, waitingZoneExists) {
    const signExists = twoStageSignExists === "yes";
    const zoneExists = waitingZoneExists === "yes";
    if (signExists && zoneExists) return "two_stage_required";
    if (signExists || zoneExists) return "two_stage_optional";
    return null;
  }

  function wayKeyForId(osmWayId) {
    return osmWayId === undefined || osmWayId === null || osmWayId === "" ? null : `way/${osmWayId}`;
  }

  function targetRoadNameForWay(way) {
    const name = String(way?.name || "").trim();
    if (name) return name;
    const key = wayKeyForId(way?.osm_way_id);
    return key ? `未命名道路 (${key})` : "未命名道路";
  }

  function baseWayIdFromSegmentKey(key) {
    return String(key || "").replace(/^way\//, "").split("#")[0];
  }

  function connectedTargetWayForSegment({ intersection, currentSegmentKey, clickedSegmentKey }) {
    const clickedWayId = baseWayIdFromSegmentKey(clickedSegmentKey);
    const currentWayId = baseWayIdFromSegmentKey(currentSegmentKey);
    if (!clickedWayId) return { ok: false, reason: "missing_clicked_way" };
    if (clickedWayId === currentWayId) return { ok: false, reason: "same_as_current" };
    const connectedWay = (intersection?.connected_ways || []).find(
      (way) => String(way.osm_way_id ?? "") === clickedWayId
    );
    if (!connectedWay) return { ok: false, reason: "not_connected" };
    return {
      ok: true,
      way: connectedWay,
      targetSegmentKey: wayKeyForId(clickedWayId),
    };
  }

  function resolveTargetWaySelection({ intersection, currentSegmentKey, clickedSegmentKey, clickedRoadName }) {
    const connected = connectedTargetWayForSegment({ intersection, currentSegmentKey, clickedSegmentKey });
    if (connected.ok) return { ...connected, kind: "connected", targetRoad: targetRoadNameForWay(connected.way) };
    if (connected.reason !== "not_connected") return { ...connected, kind: null };
    const targetSegmentKey = wayKeyForId(baseWayIdFromSegmentKey(clickedSegmentKey));
    const targetRoad = String(clickedRoadName || "").trim();
    if (!targetSegmentKey || !targetRoad) return { ok: false, reason: "missing_target_details", kind: null };
    return { ok: true, kind: "offset_candidate", targetSegmentKey, targetRoad, way: null };
  }

  function normalizeTargetRelation(value) {
    if (value?.kind !== "offset_intersection") return null;
    const reason = value.reason;
    if (!new Set(["staggered_cross_intersection", "osm_geometry_missing", "other"]).has(reason)) return null;
    const note = String(value.note || "").trim() || null;
    if (reason === "other" && !note) return null;
    return { kind: "offset_intersection", reason, note };
  }

  function favouriteIntersectionKey(segmentKey, intersectionKey) {
    return segmentKey && intersectionKey ? `${segmentKey}@${intersectionKey}` : null;
  }

  function segmentTriageTags({ segmentKey, annotations = [], favouriteIntersectionKeys = new Set(), candidatePriority = 0, manualTargets = [] }) {
    const tags = new Set();
    if (Number(candidatePriority) >= 70 || manualTargets.length) tags.add("priority");
    for (const annotation of annotations) {
      const rules = annotation?.lane_nav_tags?.taiwan_motorcycle_tags?.movement_rules || [];
      const reviewNote = annotation?.lane_nav_tags?.osm_review_tags?.osm_review_note;
      if (String(annotation?.annotation_metadata?.note || "").trim() || String(reviewNote || "").trim()) tags.add("has_notes");
      if (rules.some((rule) => normalizeTargetRelation(rule.target_relation))) tags.add("offset_intersection");
      const identity = annotation?.object_identity || {};
      if (favouriteIntersectionKeys.has(favouriteIntersectionKey(segmentKey || identity.nav_segment_key, identity.applies_to_intersection_key))) tags.add("favourite");
    }
    return tags;
  }

  function matchesTagFilter(tags, selectedTags, mode = "and") {
    if (!selectedTags?.size) return true;
    return mode === "or"
      ? [...selectedTags].some((tag) => tags.has(tag))
      : [...selectedTags].every((tag) => tags.has(tag));
  }

  function draftComparable(formData, transientFieldIds = []) {
    const transient = new Set(transientFieldIds);
    const fields = Object.fromEntries(
      Object.entries(formData?.fields || {}).filter(([id]) => !transient.has(id))
    );
    return {
      fields,
      movement_rules: structuredClone(formData?.movement_rules || []),
      lane_profiles: structuredClone(formData?.lane_profiles || []),
    };
  }

  function implicitContextScope(intersectionKey) {
    return intersectionKey ? "intersection_approach" : "segment_direction";
  }

  function intersectionReviewKey(segmentKey, intersectionKey) {
    return segmentKey && intersectionKey ? `${segmentKey}@${intersectionKey}` : null;
  }

  function intersectionRuleOverview({ intersectionKey, contextAnnotations = [], legacyAnnotation = null }) {
    if (!intersectionKey) return [];
    const rows = [];
    const exactDirections = new Set();
    for (const annotation of contextAnnotations || []) {
      const identity = annotation?.object_identity || {};
      if (identity.context_scope !== "intersection_approach" ||
          identity.applies_to_intersection_key !== intersectionKey) continue;
      if (identity.approach_direction) exactDirections.add(identity.approach_direction);
      const rules = annotation?.lane_nav_tags?.taiwan_motorcycle_tags?.movement_rules || [];
      for (const rule of rules) {
        rows.push({
          ...structuredClone(rule),
          target_relation: normalizeTargetRelation(rule.target_relation),
          approach_direction: identity.approach_direction || rule.approach_direction || "unknown",
          data_origin: "context_v2",
          source_context_key: identity.nav_context_key || null,
        });
      }
    }
    const legacyRules = legacyAnnotation?.lane_nav_tags?.taiwan_motorcycle_tags?.movement_rules || [];
    for (const rule of legacyRules) {
      if (rule.applies_to_intersection_key !== intersectionKey) continue;
      if (exactDirections.has(rule.approach_direction)) continue;
      rows.push({
        ...structuredClone(rule),
        target_relation: normalizeTargetRelation(rule.target_relation),
        approach_direction: rule.approach_direction || "unknown",
        data_origin: "legacy",
        legacy_verified_at: legacyAnnotation?.annotation_metadata?.verified_at || null,
        source_context_key: null,
      });
    }
    const directionOrder = { forward: 0, backward: 1, unknown: 2 };
    return rows.sort((left, right) =>
      (directionOrder[left.approach_direction] ?? 3) -
      (directionOrder[right.approach_direction] ?? 3)
    );
  }

  function deriveIntersectionPresentation({ currentSegmentKey, currentRoadName, intersection }) {
    const normalize = (value) => String(value || "").trim();
    const currentName = normalize(currentRoadName);
    const currentWayId = String(currentSegmentKey || "")
      .replace(/^way\//, "")
      .split("#")[0];
    const ways = Array.isArray(intersection?.connected_ways) ? intersection.connected_ways : [];
    const currentWay = ways.find((way) => String(way.osm_way_id ?? "") === currentWayId);
    const currentLabel = currentName || (currentWay ? targetRoadNameForWay(currentWay) : normalize(currentSegmentKey));
    const crossingWays = ways.filter((way) => {
      const wayId = String(way.osm_way_id ?? "");
      const wayName = normalize(way.name);
      return wayId && wayId !== currentWayId && (!currentName || !wayName || wayName !== currentName);
    });
    const targetKeys = [...new Set(crossingWays.map((way) => wayKeyForId(way.osm_way_id)).filter(Boolean))];
    if (currentLabel && targetKeys.length === 1) {
      const targetKey = targetKeys[0];
      const matches = crossingWays.filter((way) => wayKeyForId(way.osm_way_id) === targetKey);
      const targetRoad = targetRoadNameForWay(matches[0]);
      return {
        displayName: `${currentLabel} / ${targetRoad}`,
        targetRoad,
        targetSegmentKey: matches.length === 1 ? targetKey : null,
        ambiguous: matches.length !== 1,
      };
    }
    return {
      displayName: normalize(intersection?.intersection_name) || "未命名路口",
      targetRoad: null,
      targetSegmentKey: null,
      ambiguous: true,
    };
  }

  function resolveLaneProfile(parent, child) {
    if (!parent && !child) {
      return { profile: null, inherited: [], laneCountMismatch: false };
    }
    if (!child) {
      return { profile: structuredClone(parent), inherited: ["lane_movements", "motorcycle_access_by_lane"], laneCountMismatch: false };
    }
    const parentCount = parent?.lane_count ?? null;
    const childCount = child.lane_count ?? null;
    const laneCountMismatch = Boolean(parent && parentCount !== null && childCount !== null && parentCount !== childCount);
    const inherited = [];
    const profile = {
      lane_count: childCount ?? parentCount,
      lane_movements: child.lane_movements ?? null,
      motorcycle_access_by_lane: child.motorcycle_access_by_lane ?? null,
    };
    if (!laneCountMismatch && parent) {
      for (const field of ["lane_movements", "motorcycle_access_by_lane"]) {
        if (profile[field] === null && parent[field] !== null && parent[field] !== undefined) {
          profile[field] = structuredClone(parent[field]);
          inherited.push(field);
        }
      }
    }
    return { profile, inherited, laneCountMismatch };
  }

  function draftStorageKey(identity) {
    if (!identity?.nav_segment_key) return null;
    const direction = identity.approach_direction || "unknown";
    let key = contextKey(identity);
    if (!key && identity.context_scope === "intersection_approach") {
      key = `${identity.nav_segment_key}@${identity.intersection_key || "unselected"}/${direction}`;
    } else if (!key && identity.context_scope === "segment_direction") {
      key = `${identity.nav_segment_key}/${direction}`;
    }
    return key ? `lanepilot:draft:v1:${key}` : null;
  }

  function stableStringify(value) {
    function normalize(item) {
      if (Array.isArray(item)) return item.map(normalize);
      if (item && typeof item === "object") {
        return Object.keys(item).sort().reduce((result, key) => {
          result[key] = normalize(item[key]);
          return result;
        }, {});
      }
      return item;
    }
    return JSON.stringify(normalize(value));
  }

  return {
    annotationHasEffectiveContent,
    connectedTargetWayForSegment,
    contextKey,
    deriveTwoStageRule,
    deriveIntersectionPresentation,
    draftComparable,
    draftStorageKey,
    implicitContextScope,
    intersectionRuleOverview,
    intersectionReviewKey,
    movementKey,
    movementIdentity,
    favouriteIntersectionKey,
    matchesTagFilter,
    normalizeTargetRelation,
    resolveTargetWaySelection,
    resolveLaneProfile,
    segmentTriageTags,
    stableStringify,
    targetRoadNameForWay,
  };
});
