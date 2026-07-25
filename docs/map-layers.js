(() => {
  function featureForItem(item, mapContext) {
    return {
      type: "Feature",
      properties: {
        nav_segment_key: item.nav_segment_key,
        annotated: Boolean(item.annotated),
        suggested: Boolean(
          item.suggested ||
          item.manual_targets?.length ||
          item.candidate_priority >= 70
        ),
        road_name: item.road_name,
        map_context: mapContext,
        label: `${item.road_name || `未命名道路 (${item.nav_segment_key})`} · ${item.nav_segment_key}`,
      },
      geometry: item.geometry,
    };
  }

  function buildFeatures({ primaryItems = [], backgroundItemsByArea = new Map() } = {}) {
    const claimedKeys = new Set();
    const primaryFeatures = [];
    const backgroundFeatures = [];

    for (const item of primaryItems) {
      if (!item.geometry || claimedKeys.has(item.nav_segment_key)) continue;
      claimedKeys.add(item.nav_segment_key);
      primaryFeatures.push(featureForItem(item, false));
    }

    for (const items of backgroundItemsByArea.values()) {
      for (const item of items) {
        if (!item.geometry || claimedKeys.has(item.nav_segment_key)) continue;
        claimedKeys.add(item.nav_segment_key);
        backgroundFeatures.push(featureForItem(item, true));
      }
    }

    return {
      primary: { type: "FeatureCollection", features: primaryFeatures },
      background: { type: "FeatureCollection", features: backgroundFeatures },
    };
  }

  function styleFor(
    properties,
    { context = false, selectedKey = null, targetKey = null } = {},
  ) {
    const selected = properties.nav_segment_key === selectedKey;
    const target = targetKey && properties.nav_segment_key === targetKey;
    const color = selected
      ? "#a13a3a"
      : target
        ? "#2563a8"
        : properties.annotated
          ? "#0b6e69"
          : properties.suggested
            ? "#9a5b16"
            : "#8a928c";
    return {
      color,
      weight: selected ? 8 : context ? 3 : 5,
      opacity: context ? 0.35 : 0.9,
    };
  }

  function contextDistrictOptions(districts, primaryAreaId) {
    return districts.filter((district) => district.area_id !== primaryAreaId);
  }

  window.LanePilotMapLayers = {
    buildFeatures,
    contextDistrictOptions,
    styleFor,
  };
})();
