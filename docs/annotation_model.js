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
    const crossingWays = ways.filter((way) => {
      const wayId = String(way.osm_way_id ?? "");
      const wayName = normalize(way.name);
      return wayId !== currentWayId && wayName && wayName !== currentName;
    });
    const targetNames = [...new Set(crossingWays.map((way) => normalize(way.name)))];
    if (currentName && targetNames.length === 1) {
      const targetRoad = targetNames[0];
      const matches = crossingWays.filter((way) => normalize(way.name) === targetRoad);
      return {
        displayName: `${currentName} / ${targetRoad}`,
        targetRoad,
        targetSegmentKey: matches.length === 1 ? `way/${matches[0].osm_way_id}` : null,
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
    resolveLaneProfile,
    stableStringify,
  };
});
