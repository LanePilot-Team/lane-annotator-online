const state = {
  selectedKey: null,
  selectedSegment: null,
  selectedAnnotation: null,
  legacyAnnotation: null,
  contextAnnotations: [],
  selectedNearbyIntersections: [],
  selectedIntersectionKey: null,
  intersectionReviews: new Map(),
  movementRules: [],
  laneProfiles: [],
  areas: { cities: [], districts: [] },
  map: null,
  segmentLayer: null,
  intersectionLayer: null,
  directionLayer: null,
  selectedIntersectionLayer: null,
  offset: 0,
  limit: 120,
  dataWarnings: {},
  segmentRequestId: 0,
  mapRequestId: 0,
  segmentTotal: 0,
  segmentLoaded: 0,
  segmentLoading: false,
  activeDraftIdentity: null,
  formBaseline: null,
  dirty: false,
  applyingFormState: false,
  pendingOffsetTarget: null,
  pendingTargetRelation: null,
  favouriteIntersectionKeys: new Set(),
};

const FAVOURITES_STORAGE_KEY = "lanepilot:favourite-intersections:v1";

const $ = (id) => document.getElementById(id);
const {
  annotationHasEffectiveContent,
  connectedTargetWayForSegment,
  contextKey: modelContextKey,
  deriveTwoStageRule,
  deriveIntersectionPresentation,
  draftComparable,
  draftStorageKey,
  implicitContextScope,
  intersectionRuleOverview,
  intersectionReviewKey,
  favouriteIntersectionKey,
  movementKey,
  movementIdentity,
  normalizeTargetRelation,
  resolveTargetWaySelection,
  resolveLaneProfile,
  stableStringify,
  targetRoadNameForWay,
} = LaneAnnotationModel;

function loadFavouriteIntersectionKeys() {
  try {
    const value = JSON.parse(localStorage.getItem(FAVOURITES_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : []);
  } catch {
    return new Set();
  }
}

function persistFavouriteIntersectionKeys() {
  localStorage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify([...state.favouriteIntersectionKeys]));
}

function selectedTagFilters() {
  return [...document.querySelectorAll(".tag-filter-option:checked")].map((input) => input.value);
}

function favouriteSegmentKeys() {
  return [...new Set([...state.favouriteIntersectionKeys].map((key) => key.split("@")[0]).filter(Boolean))];
}

function updateTagFilterLabel() {
  const selected = selectedTagFilters();
  $("tagFilterToggle").textContent = `標籤篩選（${selected.length}）`;
  $("clearTagFilter").disabled = selected.length === 0;
}

function setDataWarning(key, message = "") {
  if (message) state.dataWarnings[key] = message;
  else delete state.dataWarnings[key];
  const warning = $("dataWarning");
  const messages = Object.values(state.dataWarnings);
  warning.hidden = messages.length === 0;
  warning.textContent = messages.join(" ");
}

function debounce(fn, wait = 400) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function valueOrEmpty(value) {
  return value === null || value === undefined ? "" : value;
}

function localHourString() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`;
}

function normalizePoint(point) {
  if (Array.isArray(point)) return point;
  if (typeof point === "string") {
    const parts = point.trim().split(/[,\s]+/).map(Number);
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      return [parts[0], parts[1]];
    }
  }
  return point;
}

function normalizeGeometry(geometry) {
  if (!geometry) return geometry;
  if (geometry.type === "LineString") {
    return { ...geometry, coordinates: (geometry.coordinates || []).map(normalizePoint) };
  }
  if (geometry.type === "Point") {
    return { ...geometry, coordinates: normalizePoint(geometry.coordinates) };
  }
  return geometry;
}

function formatCoord(point) {
  if (!point) return "-";
  return `${Number(point[1]).toFixed(6)}, ${Number(point[0]).toFixed(6)}`;
}

function bearingDegrees(start, end) {
  const lat1 = start[1] * Math.PI / 180;
  const lat2 = end[1] * Math.PI / 180;
  const dLng = (end[0] - start[0]) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function bearingText(deg) {
  const dirs = [
    "北", "北北東", "東北", "東北東",
    "東", "東南東", "東南", "南南東",
    "南", "南南西", "西南", "西南西",
    "西", "西北西", "西北", "北北西",
  ];
  return dirs[Math.round(deg / 22.5) % 16];
}

function currentRoadName() {
  const segment = state.selectedSegment || {};
  const tags = segment.lane_nav_tags || {};
  const osm = segment.osm_selected_tags || {};
  return (tags.road_name || osm.name || "").trim();
}

function currentRoadLabel() {
  const name = currentRoadName();
  if (name) return name;
  const segment = state.selectedSegment || {};
  const osmWayId = segment.object_identity?.source_osm?.osm_id;
  return targetRoadNameForWay({ osm_way_id: osmWayId });
}

let toastTimer = null;

function showToast(message, options = {}) {
  clearTimeout(toastTimer);
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", Boolean(options.error));
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

function setMovementRuleStatus(message = "", isError = false) {
  const status = $("movementRuleStatus");
  status.textContent = message;
  status.classList.toggle("error", Boolean(message) && isError);
}

function setContextStatus(message, kind = "empty") {
  const status = $("contextStatus");
  status.textContent = message;
  status.className = `context-status ${kind}`;
}

function currentContextScope() {
  return implicitContextScope(state.selectedIntersectionKey);
}

function intersectionPresentation(intersection) {
  return deriveIntersectionPresentation({
    currentSegmentKey: state.selectedSegment?.object_identity?.nav_segment_key,
    currentRoadName: currentRoadName(),
    intersection,
  });
}

function populateTargetSegmentOptions(connectedWays, selectedKey = null) {
  const targetSelect = $("targetSegmentKey");
  const currentWayId = String(state.selectedKey || "").replace(/^way\//, "").split("#")[0];
  targetSelect.innerHTML = `<option value="">請選擇目標 OSM 路段</option>`;
  const seen = new Set();
  for (const way of connectedWays || []) {
    if (String(way.osm_way_id ?? "") === currentWayId) continue;
    const candidates = [{ nav_segment_key: `way/${way.osm_way_id}` }];
    for (const candidate of candidates) {
      const key = candidate.nav_segment_key;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const option = document.createElement("option");
      option.value = key;
      option.dataset.roadName = targetRoadNameForWay(way);
      option.textContent = `${targetRoadNameForWay(way)} — ${key}`;
      targetSelect.appendChild(option);
    }
  }
  targetSelect.value = selectedKey || "";
  return seen.size;
}

function handleTargetSegmentChange() {
  syncTargetRoadSnapshot();
  $("targetRoadHint").textContent = "已人工選擇目標 OSM way；請以地圖藍線確認。";
}

function setSelectedRoadFields(intersection) {
  const presentation = deriveIntersectionPresentation({
    currentSegmentKey: state.selectedSegment?.object_identity?.nav_segment_key,
    currentRoadName: currentRoadName(),
    intersection,
  });
  $("selectedRoad").value = currentRoadLabel();
  $("targetRoad").value = presentation.targetRoad || "";
  const candidateCount = populateTargetSegmentOptions(
    intersection?.connected_ways || [],
    presentation.targetSegmentKey
  );
  $("targetSegmentAssist").hidden = candidateCount <= 1;
  $("targetSegmentKey").hidden = candidateCount <= 1;
  $("targetRoadHint").textContent = presentation.ambiguous
    ? "目標道路已自動填入；請對照地圖紅藍線，人工選擇目標 OSM way。"
    : `已自動對應 ${presentation.targetSegmentKey}`;
  refreshSegmentMapStyles();
}

async function loadIntersectionReviews() {
  const segmentKey = state.selectedSegment?.object_identity?.nav_segment_key;
  state.intersectionReviews = new Map();
  if (!segmentKey) return;
  const data = await fetchJson(
    `/api/intersection-reviews?nav_segment_key=${encodeURIComponent(segmentKey)}`
  );
  for (const row of data.items || []) {
    state.intersectionReviews.set(row.review_key, row);
  }
}

function intersectionDisplayStatus(intersectionKey) {
  const contextRows = state.contextAnnotations.filter((row) =>
    row.object_identity?.context_scope === "intersection_approach" &&
    row.object_identity?.applies_to_intersection_key === intersectionKey
  );
  const annotatedContext = contextRows.some(annotationHasEffectiveContent);
  const emptyContext = contextRows.length > 0 && !annotatedContext;
  const annotatedLegacy = contextLaneData(state.legacyAnnotation).movementRules.some(
    (rule) => rule.applies_to_intersection_key === intersectionKey
  );
  if (annotatedContext && annotatedLegacy) return { kind: "annotated", label: "已標註・含舊版" };
  if (annotatedContext) return { kind: "annotated", label: "已標註" };
  if (annotatedLegacy) return { kind: "legacy", label: "舊版資料" };
  if (emptyContext) return { kind: "empty", label: "已檢查・無規則" };
  const reviewKey = intersectionReviewKey(state.selectedKey, intersectionKey);
  if (reviewKey && state.intersectionReviews.has(reviewKey)) {
    return { kind: "checked", label: "已檢查" };
  }
  return null;
}

async function toggleIntersectionReview(event, intersection) {
  event.preventDefault();
  event.stopPropagation();
  const reviewKey = intersectionReviewKey(
    state.selectedKey,
    intersection.nav_intersection_key
  );
  const wasChecked = state.intersectionReviews.has(reviewKey);
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await fetchJson("/api/intersection-reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nav_segment_key: state.selectedKey,
        nav_intersection_key: intersection.nav_intersection_key,
        checked: !wasChecked,
        checked_by: $("verifiedBy").value.trim() || "unknown",
      }),
    });
    if (result.checked) state.intersectionReviews.set(reviewKey, result.review);
    else state.intersectionReviews.delete(reviewKey);
    renderNearbyIntersections(state.selectedNearbyIntersections);
    showToast(result.checked ? "已設為已檢查" : "已取消已檢查");
  } catch (error) {
    button.disabled = false;
    showToast(`已檢查狀態儲存失敗：${error.message}`, { error: true });
  }
}

const DRAFT_FIELD_IDS = [
  "targetSegmentKey",
  "targetRoad",
  "movementType",
  "vehicleMovementRule",
  "motorcycleTurnRule",
  "twoStageSignExists",
  "waitingZoneExists",
  "waitingZonePosition",
  "laneMovements",
  "laneMotorcycleAccess",
  "osmLaneStatus",
  "osmTurnLaneStatus",
  "osmMotorcycleStatus",
  "osmReviewNote",
  "confidence",
  "verifiedBy",
  "evidenceType",
  "note",
];

const TRANSIENT_DRAFT_FIELD_IDS = [
  "targetSegmentKey",
  "targetRoad",
  "movementType",
  "vehicleMovementRule",
  "motorcycleTurnRule",
  "twoStageSignExists",
  "waitingZoneExists",
  "waitingZonePosition",
  "laneMovements",
  "laneMotorcycleAccess",
];

function currentDraftIdentity() {
  if (!state.selectedSegment) return null;
  const scope = currentContextScope();
  const direction = $("approachDirection").value;
  if (!["forward", "backward"].includes(direction)) return null;
  return {
    nav_segment_key: state.selectedSegment.object_identity.nav_segment_key,
    context_scope: scope,
    intersection_key: scope === "intersection_approach" ? state.selectedIntersectionKey : null,
    approach_direction: direction,
  };
}

function captureFormDraft() {
  const fields = {};
  for (const id of DRAFT_FIELD_IDS) fields[id] = $(id)?.value ?? "";
  return {
    fields,
    movement_rules: structuredClone(state.movementRules),
    lane_profiles: structuredClone(state.laneProfiles),
  };
}

function comparableFormDraft() {
  return stableStringify(draftComparable(captureFormDraft(), TRANSIENT_DRAFT_FIELD_IDS));
}

function applyFormDraft(formData) {
  state.applyingFormState = true;
  try {
    for (const [id, value] of Object.entries(formData?.fields || {})) {
      if ($(id)) $(id).value = value ?? "";
    }
    state.movementRules = structuredClone(formData?.movement_rules || []);
    state.laneProfiles = structuredClone(formData?.lane_profiles || []);
    syncTargetRoadSnapshot();
    renderMovementRules();
    renderLaneProfiles();
    renderLaneInheritance();
  } finally {
    state.applyingFormState = false;
  }
}

function updateDirtyStatus() {
  $("dirtyStatus").hidden = !state.dirty;
}

function saveCurrentDraft() {
  if (!state.activeDraftIdentity || !state.dirty) return;
  const draftKey = draftStorageKey(state.activeDraftIdentity);
  if (!draftKey) return;
  const draft = {
    schema_version: 1,
    context_identity: state.activeDraftIdentity,
    form_data: captureFormDraft(),
    saved_at: new Date().toISOString(),
  };
  localStorage.setItem(draftKey, JSON.stringify(draft));
}

const scheduleDraftSave = debounce(saveCurrentDraft, 300);

function markFormDirty() {
  if (state.applyingFormState || !state.activeDraftIdentity || state.formBaseline === null) return;
  state.dirty = comparableFormDraft() !== state.formBaseline;
  updateDirtyStatus();
  if (state.dirty) scheduleDraftSave();
  else clearCurrentDraft();
}

function clearCurrentDraft() {
  const draftKey = draftStorageKey(state.activeDraftIdentity);
  if (draftKey) localStorage.removeItem(draftKey);
  state.dirty = false;
  updateDirtyStatus();
}

function restoreContextDraft() {
  const draftKey = draftStorageKey(state.activeDraftIdentity);
  if (!draftKey) return;
  const raw = localStorage.getItem(draftKey);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    applyFormDraft(draft.form_data);
    state.dirty = comparableFormDraft() !== state.formBaseline;
    if (!state.dirty) localStorage.removeItem(draftKey);
    updateDirtyStatus();
  } catch (error) {
    localStorage.removeItem(draftKey);
  }
}

function activateDraftContext() {
  const identity = currentDraftIdentity();
  const draftKey = draftStorageKey(identity);
  state.activeDraftIdentity = draftKey ? identity : null;
  state.formBaseline = comparableFormDraft();
  state.dirty = false;
  updateDirtyStatus();
  if (state.activeDraftIdentity) restoreContextDraft();
}

function confirmDirtyTransition() {
  if (!state.dirty) return true;
  saveCurrentDraft();
  const proceed = window.confirm("有草稿尚未儲存，是否仍要跳轉下筆資料?");
  if (proceed) {
    state.dirty = false;
    updateDirtyStatus();
  }
  return proceed;
}

function requestSegmentChange(key, options = {}) {
  if (!confirmDirtyTransition()) return Promise.resolve(false);
  return loadSegmentDetail(key, options).then(() => true);
}

function handleContextSelectorChange(event) {
  const previous = state.activeDraftIdentity;
  if (!confirmDirtyTransition()) {
    if (event.target.id === "approachDirection" && previous) event.target.value = previous.approach_direction;
    return;
  }
  loadActiveContext();
}

function syncTargetRoadSnapshot() {
  const option = $("targetSegmentKey").selectedOptions[0];
  $("targetRoad").value = option?.dataset?.roadName || "";
  refreshSegmentMapStyles();
}

function syncTwoStageDefaults() {
  const defaultRule = deriveTwoStageRule(
    $("twoStageSignExists").value,
    $("waitingZoneExists").value
  );
  if (defaultRule) $("motorcycleTurnRule").value = defaultRule;
  if ($("waitingZoneExists").value === "yes" && $("waitingZonePosition").value === "unknown") {
    $("waitingZonePosition").value = "front_right";
  }
}

function optionLabel(area) {
  return `${area.name} (${area.name_en || area.admin_level})`;
}

function geoParams() {
  const params = {};
  const cityAreaId = $("cityFilter").value;
  const districtAreaId = $("districtFilter").value;
  if (cityAreaId) params.city_area_id = cityAreaId;
  if (districtAreaId) params.district_area_id = districtAreaId;
  return params;
}

function mapSegmentColor(properties) {
  if (properties.nav_segment_key === state.selectedKey) return "#a13a3a";
  const targetSegmentKey = $("targetSegmentKey")?.value || null;
  if (targetSegmentKey && properties.nav_segment_key === targetSegmentKey) return "#2563a8";
  if (properties.annotated) return "#0b6e69";
  return properties.suggested ? "#9a5b16" : "#8a928c";
}

function refreshSegmentMapStyles() {
  if (!state.segmentLayer) return;
  state.segmentLayer.setStyle((feature) => ({
    color: mapSegmentColor(feature.properties),
    weight: feature.properties.nav_segment_key === state.selectedKey ? 8 : 5,
    opacity: 0.9,
  }));
}

function selectedIntersection() {
  if (!state.selectedIntersectionKey) return null;
  return state.selectedNearbyIntersections.find(
    (item) => item.nav_intersection_key === state.selectedIntersectionKey
  ) || null;
}

function selectTargetSegmentFromMap(navSegmentKey, roadName = "") {
  const intersection = selectedIntersection();
  if (!intersection) {
    showToast("請先選擇路口，再用 Ctrl+點擊選擇目標道路。", { error: true });
    return false;
  }

  const target = resolveTargetWaySelection({
    intersection,
    currentSegmentKey: state.selectedKey,
    clickedSegmentKey: navSegmentKey,
    clickedRoadName: roadName,
  });
  if (target.reason === "same_as_current") {
    showToast("目標道路不能是目前選定道路。", { error: true });
    return false;
  }
  if (!target.ok) {
    showToast("這條路不在目前路口的 connected ways 裡。", { error: true });
    return false;
  }

  if (target.ok && target.kind === "offset_candidate") {
    state.pendingOffsetTarget = target;
    $("offsetTargetSummary").textContent = `${target.targetRoad} (${target.targetSegmentKey})`;
    $("offsetReasonNote").value = "";
    $("offsetReasonNoteLabel").hidden = true;
    $("offsetTargetDialog").showModal();
    return true;
  }
  const targetKey = target.targetSegmentKey;
  const targetSelect = $("targetSegmentKey");
  targetSelect.value = targetKey;
  if (targetSelect.value !== targetKey) {
    populateTargetSegmentOptions(intersection.connected_ways || [], targetKey);
    targetSelect.value = targetKey;
  }
  state.pendingTargetRelation = null;
  $("targetRoad").value = target.targetRoad || targetRoadNameForWay(target.way);
  $("targetRoadHint").textContent = "已用地圖 Ctrl+點擊選擇目標 OSM way；仍受目前路口 connected ways 限制。";
  targetSelect.hidden = false;
  $("targetSegmentAssist").hidden = false;
  refreshSegmentMapStyles();
  markFormDirty();
  return true;
}

function offsetReasonValue() {
  return document.querySelector('input[name="offsetReason"]:checked')?.value || "";
}

function syncOffsetReasonNote() {
  $("offsetReasonNoteLabel").hidden = offsetReasonValue() !== "other";
}

function confirmOffsetTarget() {
  const pending = state.pendingOffsetTarget;
  const reason = offsetReasonValue();
  const relation = normalizeTargetRelation({
    kind: "offset_intersection",
    reason,
    note: $("offsetReasonNote").value,
  });
  if (!pending || !relation) {
    showToast("請為「其他」填寫原因。", { error: true });
    return;
  }
  state.pendingTargetRelation = relation;
  $("targetSegmentKey").value = pending.targetSegmentKey;
  if ($("targetSegmentKey").value !== pending.targetSegmentKey) {
    const option = document.createElement("option");
    option.value = pending.targetSegmentKey;
    option.textContent = `${pending.targetRoad} · ${pending.targetSegmentKey}`;
    $("targetSegmentKey").appendChild(option);
    $("targetSegmentKey").value = pending.targetSegmentKey;
  }
  $("targetRoad").value = pending.targetRoad;
  $("targetRoadHint").textContent = "已建立錯落路口關聯；儲存規則時會記錄原因。";
  state.pendingOffsetTarget = null;
  $("offsetTargetDialog").close();
  refreshSegmentMapStyles();
  markFormDirty();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    if (response.status === 404) {
      throw new Error("伺服器版本過舊或功能不存在，請關閉舊 server 後重新啟動 server.py");
    }
    throw new Error(`伺服器回傳格式錯誤（HTTP ${response.status}）`);
  }
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function loadAreas() {
  state.areas = await fetchJson("/api/areas");
  if (!state.areas.admin_areas_available || !state.areas.districts.length) {
    setDataWarning(
      "admin_areas",
      "缺少行政區資料 admin_areas.json，因此無法選行政區。請執行 tools/extract_admin_areas.py <PBF 路徑> 後重新啟動 server。"
    );
  } else {
    setDataWarning("admin_areas");
  }
  setupCombo({
    inputId: "cityComboInput",
    valueId: "cityFilter",
    listId: "cityComboList",
    getOptions: () => state.areas.cities,
    onSelect: () => {
      $("districtFilter").value = "";
      $("districtComboInput").value = "";
      $("districtComboInput").placeholder = "請選擇行政區";
      state.segmentRequestId += 1;
      state.segmentTotal = 0;
      state.segmentLoaded = 0;
      state.segmentLoading = false;
      showSegmentListMessage("請選擇行政區後載入資料。", "0");
      state.mapRequestId += 1;
      renderMapSegments([]);
    },
  });
  setupCombo({
    inputId: "districtComboInput",
    valueId: "districtFilter",
    listId: "districtComboList",
    getOptions: visibleDistrictsForSelectedCity,
    onSelect: loadSelectedDistrict,
  });
}

function visibleDistrictsForSelectedCity() {
  const cityId = $("cityFilter").value;
  const city = state.areas.cities.find((item) => item.area_id === cityId);
  if (!city) return [];
  return state.areas.districts.filter((district) => {
    const b = district.bbox;
    const c = city.bbox;
    if (!b || !c) return false;
    const centerLng = (b.min_lng + b.max_lng) / 2;
    const centerLat = (b.min_lat + b.max_lat) / 2;
    return c.min_lng <= centerLng && centerLng <= c.max_lng && c.min_lat <= centerLat && centerLat <= c.max_lat;
  });
}

function setupCombo({ inputId, valueId, listId, getOptions, onSelect }) {
  const input = $(inputId);
  const value = $(valueId);
  const list = $(listId);
  input.value = "";

  function render(openAll = false) {
    const query = input.value.trim().toLowerCase();
    const options = getOptions();
    const filtered = openAll || !query ? options : options.filter((area) => optionLabel(area).toLowerCase().includes(query));
    list.innerHTML = "";

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "combo-empty";
      empty.textContent = inputId === "districtComboInput" && !$("cityFilter").value ? "請先選擇縣市" : "找不到符合項目";
      list.appendChild(empty);
    }

    for (const area of filtered.slice(0, 250)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "combo-option";
      button.textContent = optionLabel(area);
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        if (!confirmDirtyTransition()) return;
        value.value = area.area_id;
        input.value = optionLabel(area);
        list.hidden = true;
        onSelect();
      });
      list.appendChild(button);
    }
    list.hidden = false;
  }

  input.addEventListener("focus", () => render(true));
  input.addEventListener("click", () => render(true));
  input.addEventListener("input", () => {
    value.value = "";
    render(false);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") list.hidden = true;
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      list.hidden = true;
      if (!value.value) input.value = "";
    }, 120);
  });
}

async function loadMeta() {
  const meta = await fetchJson("/api/meta");
  $("meta").textContent = `路段 ${meta.segment_count ?? "-"} / 路口 ${meta.intersection_count ?? "-"} / 限制 ${meta.restriction_count ?? "-"} / 標註 ${meta.annotation_count ?? 0}`;
  const missing = meta.missing_required_files || [];
  if (missing.length) {
    setDataWarning(
      "required_files",
      `缺少必要生成資料：${missing.join(", ")}。GitHub 只交換 source code，不包含 outputs；請從同一份 PBF 重新執行資料抽取工具。`
    );
  } else {
    setDataWarning("required_files");
  }
}

function manualTargetLabel(target) {
  const labels = {
    check_motorcycle_turn_rule: "機車轉向/待轉",
    check_two_stage_turn_sign: "二段式標誌",
    check_waiting_zone: "待轉區",
    fill_lane_count: "OSM 缺車道數",
    fill_lane_movement: "OSM 缺 turn:lanes",
    split_forward_backward_lanes: "缺正反向車道",
    check_motorcycle_lane_access: "機車車道限制",
    check_motorcycle_access: "機車通行限制",
    check_intersection_geometry: "路口確認",
    check_lane_movements: "路口轉向確認",
  };
  return labels[target] || target;
}

function targetText(targets) {
  return (targets || []).map(manualTargetLabel).join(" / ") || "OSM 參考";
}

function showSegmentListMessage(message, countText = "") {
  $("resultCount").textContent = countText;
  const list = $("segmentList");
  list.innerHTML = "";
  const row = document.createElement("p");
  row.className = "list-message";
  row.textContent = message;
  list.appendChild(row);
}

function appendSegmentRows(items) {
  const list = $("segmentList");
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "segment-row";
    if (item.nav_segment_key === state.selectedKey) row.classList.add("active");

    const main = document.createElement("div");
    const title = document.createElement("div");
    title.className = "segment-name";
    title.textContent = item.road_name;
    const meta = document.createElement("div");
    meta.className = "segment-meta";
    const suggested = item.manual_targets?.length ? "高優先" : "一般";
    meta.textContent = `${item.nav_segment_key} · ${item.road_class || "unknown"} · lanes ${item.lane_count_total ?? "?"} · ${suggested}`;
    const targets = document.createElement("div");
    targets.className = "segment-meta";
    targets.textContent = targetText(item.manual_targets);
    main.append(title, meta, targets);

    const badges = document.createElement("div");
    const priority = document.createElement("span");
    priority.className = "badge hot";
    priority.textContent = `優先 ${item.candidate_priority}`;
    priority.title = "候選優先分數：分數越高，越建議優先人工確認；不代表一定有待轉牌。";
    badges.append(priority);
    const fallbackStatus = item.annotation_status || (item.annotated ? "annotated" : null);
    const fallbackStatusMap = { annotated: "annotated", legacy: "legacy_v1", checked: "empty" };
    const annotationStatuses = Array.isArray(item.annotation_statuses)
      ? item.annotation_statuses
      : fallbackStatus
        ? [fallbackStatusMap[fallbackStatus] || fallbackStatus]
        : [];
    for (const annotationStatus of annotationStatuses) {
      const done = document.createElement("span");
      done.className = `badge done ${annotationStatus}`;
      done.textContent = {
        annotated: "已標註",
        empty: "有紀錄但目前無規則",
        legacy_v1: "v1舊資料",
      }[annotationStatus] || annotationStatus;
      badges.append(document.createElement("br"), done);
    }

    const triageLabels = { has_notes: "有備註", offset_intersection: "錯落路口", favourite: "我的最愛", priority: "高優先" };
    for (const tag of item.triage_tags || []) {
      if (!triageLabels[tag] || tag === "priority") continue;
      const badge = document.createElement("span");
      badge.className = `badge ${tag}`;
      badge.textContent = triageLabels[tag];
      badges.append(document.createElement("br"), badge);
    }
    row.append(main, badges);
    row.addEventListener("click", () => requestSegmentChange(item.nav_segment_key, { focusMap: true }));
    list.appendChild(row);
  }
}

async function loadSegments({ append = false } = {}) {
  const districtAreaId = $("districtFilter").value;
  if (!districtAreaId) {
    state.segmentRequestId += 1;
    state.segmentTotal = 0;
    state.segmentLoaded = 0;
    state.segmentLoading = false;
    showSegmentListMessage("請先選擇縣市與行政區。", "0");
    return;
  }
  if (append && (state.segmentLoading || state.segmentLoaded >= state.segmentTotal)) return;

  const requestId = append ? state.segmentRequestId : ++state.segmentRequestId;
  const list = $("segmentList");
  state.segmentLoading = true;
  if (!append) {
    state.segmentTotal = 0;
    state.segmentLoaded = 0;
    $("resultCount").textContent = "載入中";
    list.innerHTML = '<div class="list-loading"><span class="spinner" aria-hidden="true"></span><span>正在載入行政區資料...</span></div>';
  } else {
    list.querySelector(".list-tail")?.remove();
    list.insertAdjacentHTML("beforeend", '<div class="list-loading list-tail"><span class="spinner" aria-hidden="true"></span><span>正在載入更多路段...</span></div>');
  }
  const segmentScope = $("segmentScopeFilter").value;
  const params = new URLSearchParams({
    limit: state.limit,
    offset: append ? state.segmentLoaded : 0,
    q: $("searchInput").value,
    target: $("targetFilter").value,
    status: $("statusFilter").value,
    candidate_scope: segmentScope,
    triage_tags: selectedTagFilters().join(","),
    triage_mode: $("tagFilterMode").value,
    favourite_segment_keys: favouriteSegmentKeys().join(","),
    ...geoParams(),
  });
  try {
    const data = await fetchJson(`/api/segments?${params.toString()}`);
    if (requestId !== state.segmentRequestId) return;
    list.querySelector(".list-tail")?.remove();
    if (!append) list.innerHTML = "";
    state.segmentTotal = data.total;
    state.segmentLoaded += data.items.length;
    state.segmentLoading = false;
    $("resultCount").textContent = `${state.segmentLoaded}/${state.segmentTotal} 筆`;
    if (!data.items.length && !append) {
      showSegmentListMessage("此條件找不到路段。", "0 筆");
      return;
    }
    appendSegmentRows(data.items);
    const message = state.segmentLoaded < state.segmentTotal ? "向下捲動以載入更多路段" : "已載入全部路段";
    list.insertAdjacentHTML("beforeend", `<p class="list-message list-tail">${message}</p>`);
  } catch (error) {
    if (requestId !== state.segmentRequestId) return;
    state.segmentLoading = false;
    if (append) {
      list.querySelector(".list-tail")?.remove();
      list.insertAdjacentHTML("beforeend", `<p class="list-message list-tail">載入失敗：${error.message}</p>`);
    } else {
      showSegmentListMessage(`載入失敗：${error.message}`, "錯誤");
    }
  }
}

async function reloadAll() {
  state.offset = 0;
  await loadSegments();
}

async function loadDistrictMap() {
  const districtAreaId = $("districtFilter").value;
  const requestId = ++state.mapRequestId;
  renderMapSegments([]);
  if (!districtAreaId) return;
  focusMapOnSelectedDistrict();

  const params = new URLSearchParams({ district_area_id: districtAreaId });
  try {
    const data = await fetchJson(`/api/map-segments?${params.toString()}`);
    if (requestId !== state.mapRequestId) return;
    setDataWarning("map_segments");
    renderMapSegments(data.items);
  } catch (error) {
    if (requestId !== state.mapRequestId) return;
    setDataWarning("map_segments", `行政區地圖載入失敗：${error.message}`);
  }
}

function focusMapOnSelectedDistrict() {
  initMap();
  const districtAreaId = $("districtFilter").value;
  const district = state.areas.districts.find((item) => item.area_id === districtAreaId);
  const bbox = district?.bbox;
  if (!state.map || !bbox) return;
  state.map.fitBounds(
    [
      [bbox.min_lat, bbox.min_lng],
      [bbox.max_lat, bbox.max_lng],
    ],
    { padding: [16, 16] }
  );
  setTimeout(() => state.map.invalidateSize(), 0);
}

async function loadSelectedDistrict() {
  state.selectedKey = null;
  await Promise.all([reloadAll(), loadDistrictMap()]);
}

function drawGeometry(geometry) {
  const svg = $("geometryPreview");
  svg.innerHTML = "";
  const coords = normalizeGeometry(geometry)?.coordinates || [];
  if (!coords.length) return;

  const xs = coords.map((point) => point[0]);
  const ys = coords.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 22;
  const width = 320 - pad * 2;
  const height = 180 - pad * 2;
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const points = coords.map((point) => {
    const x = pad + ((point[0] - minX) / dx) * width;
    const y = 180 - pad - ((point[1] - minY) / dy) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", "arrowHead");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "8");
  marker.setAttribute("refX", "7");
  marker.setAttribute("refY", "4");
  marker.setAttribute("orient", "auto");
  const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrowPath.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
  arrowPath.setAttribute("fill", "#0b6e69");
  marker.appendChild(arrowPath);
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.appendChild(marker);
  svg.appendChild(defs);

  const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  polyline.setAttribute("points", points.join(" "));
  polyline.setAttribute("fill", "none");
  polyline.setAttribute("stroke", "#0b6e69");
  polyline.setAttribute("stroke-width", "5");
  polyline.setAttribute("stroke-linecap", "round");
  polyline.setAttribute("stroke-linejoin", "round");
  polyline.setAttribute("marker-end", "url(#arrowHead)");
  svg.appendChild(polyline);

  const [sx, sy] = points[0].split(",");
  const [ex, ey] = points[points.length - 1].split(",");
  addSvgCircle(svg, sx, sy, "#9a5b16");
  addSvgCircle(svg, ex, ey, "#0b6e69");
  addSvgText(svg, sx, sy - 10, "起點");
  addSvgText(svg, ex, ey - 10, "終點");
}

function addSvgCircle(svg, x, y, fill) {
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", x);
  circle.setAttribute("cy", y);
  circle.setAttribute("r", "5");
  circle.setAttribute("fill", fill);
  svg.appendChild(circle);
}

function addSvgText(svg, x, y, text) {
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", x);
  label.setAttribute("y", y);
  label.setAttribute("font-size", "11");
  label.setAttribute("fill", "#1d2621");
  label.setAttribute("text-anchor", "middle");
  label.textContent = text;
  svg.appendChild(label);
}

function renderDirectionInfo(geometry) {
  const coords = normalizeGeometry(geometry)?.coordinates || [];
  if (coords.length < 2) {
    $("directionInfo").textContent = "此路段沒有足夠幾何資訊可判斷方向。";
    return;
  }
  const start = coords[0];
  const end = coords[coords.length - 1];
  const bearing = bearingDegrees(start, end);
  $("directionInfo").innerHTML = `
    <strong>forward = 起點到終點，約往 ${bearingText(bearing)} (${Math.round(bearing)}°)</strong><br>
    起點：${formatCoord(start)}<br>
    終點：${formatCoord(end)}<br>
    如果看不出是哪條路，請按 Open Map，在地圖上對照起點/終點位置。
  `;
}

function initMap() {
  if (state.map || typeof L === "undefined") return;
  state.map = L.map("map", { preferCanvas: true }).setView([23.8, 121.0], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);
  state.segmentLayer = L.geoJSON([], {
    style: (feature) => ({
      color: mapSegmentColor(feature.properties),
      weight: feature.properties.nav_segment_key === state.selectedKey ? 8 : 5,
      opacity: 0.9,
    }),
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(feature.properties.label);
      layer.on("click", (event) => {
        if (event.originalEvent?.ctrlKey) {
          selectTargetSegmentFromMap(feature.properties.nav_segment_key, feature.properties.road_name);
          return;
        }
        requestSegmentChange(feature.properties.nav_segment_key, { focusMap: true });
      });
    },
  }).addTo(state.map);
  state.intersectionLayer = L.geoJSON([], {
    pointToLayer: (feature, latlng) =>
      L.circleMarker(latlng, {
        radius: 5,
        color: "#a13a3a",
        fillColor: "#a13a3a",
        fillOpacity: 0.8,
        weight: 1,
      }),
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(feature.properties.label);
      layer.on("click", () => {
        const found = state.selectedNearbyIntersections.find((item) => item.nav_intersection_key === feature.properties.nav_intersection_key);
        if (found) selectNearbyIntersection(found);
      });
    },
  }).addTo(state.map);
  state.directionLayer = L.layerGroup().addTo(state.map);
  state.selectedIntersectionLayer = L.layerGroup().addTo(state.map);
  setTimeout(() => state.map.invalidateSize(), 0);
}

function renderMapSegments(items) {
  initMap();
  if (!state.map || !state.segmentLayer) return;
  const features = items
    .filter((item) => item.geometry)
    .map((item) => ({
      type: "Feature",
      properties: {
        nav_segment_key: item.nav_segment_key,
        annotated: item.annotated,
        suggested: Boolean(item.manual_targets?.length || item.candidate_priority >= 70),
        road_name: item.road_name,
        label: `${item.road_name || `未命名道路 (${item.nav_segment_key})`} · ${item.nav_segment_key}`,
      },
      geometry: normalizeGeometry(item.geometry),
    }));
  state.segmentLayer.clearLayers();
  state.segmentLayer.addData({ type: "FeatureCollection", features });
  if (features.length) {
    const bounds = state.segmentLayer.getBounds();
    if (bounds.isValid() && !state.selectedKey) state.map.fitBounds(bounds.pad(0.15));
  }
  setTimeout(() => state.map.invalidateSize(), 0);
}

function renderMapIntersections(items) {
  initMap();
  if (!state.map || !state.intersectionLayer) return;
  const features = items.slice(0, 160).map((item) => ({
    type: "Feature",
    properties: {
      nav_intersection_key: item.nav_intersection_key,
      label: `${item.intersection_name} · ${item.nav_intersection_key}`,
    },
    geometry: { type: "Point", coordinates: [item.coordinate.lng, item.coordinate.lat] },
  }));
  state.intersectionLayer.clearLayers();
  state.intersectionLayer.addData({ type: "FeatureCollection", features });
}

function focusMapOnGeometry(geometry) {
  if (!state.map || !geometry) return;
  const normalized = normalizeGeometry(geometry);
  const temp = L.geoJSON(normalized);
  const bounds = temp.getBounds();
  if (bounds.isValid()) state.map.fitBounds(bounds.pad(0.3));
  renderDirectionMarkers(normalized);
  setTimeout(() => state.map.invalidateSize(), 0);
}

function renderDirectionMarkers(geometry) {
  if (!state.directionLayer) return;
  state.directionLayer.clearLayers();
  const coords = geometry?.coordinates || [];
  if (coords.length < 2) return;
  const start = coords[0];
  const end = coords[coords.length - 1];
  L.circleMarker([start[1], start[0]], {
    radius: 7,
    color: "#9a5b16",
    fillColor: "#9a5b16",
    fillOpacity: 1,
    weight: 2,
  }).bindTooltip("OSM way 起點 / forward 起點", { permanent: true, direction: "top", className: "map-direction-tooltip" }).addTo(state.directionLayer);
  L.circleMarker([end[1], end[0]], {
    radius: 7,
    color: "#0b6e69",
    fillColor: "#0b6e69",
    fillOpacity: 1,
    weight: 2,
  }).bindTooltip("OSM way 終點 / forward 終點", { permanent: true, direction: "top", className: "map-direction-tooltip" }).addTo(state.directionLayer);
}

function highlightSelectedIntersection(intersection) {
  if (!state.selectedIntersectionLayer || !intersection?.coordinate) return;
  state.selectedIntersectionLayer.clearLayers();
  const latlng = [intersection.coordinate.lat, intersection.coordinate.lng];
  L.circleMarker(latlng, {
    radius: 13,
    color: "#a13a3a",
    fillColor: "#a13a3a",
    fillOpacity: 0.25,
    weight: 4,
  }).bindTooltip("正在編輯的路口", { direction: "right" }).addTo(state.selectedIntersectionLayer);
  if (state.map) state.map.panTo(latlng);
}

function selectNearbyIntersection(intersection, options = {}) {
  if (!options.skipGuard && !confirmDirtyTransition()) return false;
  state.selectedIntersectionKey = intersection.nav_intersection_key;
  $("approachDirection").value = "unknown";
  highlightSelectedIntersection(intersection);
  renderNearbyIntersections(state.selectedNearbyIntersections);
  $("appliesToIntersection").value = intersection.nav_intersection_key;
  $("saveStatus").textContent = "已選路口；請看方向預覽/Open Map，人工確認此路口要標 OSM forward 或 backward";
  if (options.scroll === true) {
    $("addMovementRule").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  loadActiveContext();
  return true;
}

function renderTags(tags) {
  const box = $("tagChips");
  box.innerHTML = "";
  const entries = Object.entries(tags || {});
  if (!entries.length) {
    box.textContent = "沒有抽到 selected tags";
    return;
  }
  for (const [key, value] of entries) {
    const chip = document.createElement("div");
    chip.className = "tag-chip";
    chip.innerHTML = `<strong>${key}</strong>: ${value}`;
    box.appendChild(chip);
  }
}

function renderOsmSummary(segment) {
  const osm = segment.osm_selected_tags || {};
  const tags = segment.lane_nav_tags || {};
  const items = [
    ["道路", `${osm.name || tags.road_name || "(unnamed)"} · ${osm.highway || tags.road_class || "unknown"}`],
    ["車道數", `lanes=${osm.lanes || tags.lane_count_total || "?"} / forward=${osm["lanes:forward"] || tags.lane_count_forward || "?"} / backward=${osm["lanes:backward"] || tags.lane_count_backward || "?"}`],
    ["車道轉向", `turn:lanes=${osm["turn:lanes"] || "-"} / forward=${osm["turn:lanes:forward"] || "-"} / backward=${osm["turn:lanes:backward"] || "-"}`],
    ["車道變換", `change:lanes=${osm["change:lanes"] || "-"} / forward=${osm["change:lanes:forward"] || "-"} / backward=${osm["change:lanes:backward"] || "-"}`],
    ["機車通行", `motorcycle=${osm.motorcycle || "-"} / motorcycle:lanes=${osm["motorcycle:lanes"] || "-"} / conditional=${osm["motorcycle:conditional"] || "-"}`],
    ["車道通行", `access:lanes=${osm["access:lanes"] || "-"} / motor_vehicle:lanes=${osm["motor_vehicle:lanes"] || "-"} / vehicle:lanes=${osm["vehicle:lanes"] || "-"}`],
    ["轉向限制", `restriction=${osm.restriction || "-"} / restriction:motorcycle=${osm["restriction:motorcycle"] || "-"} / except=${osm.except || "-"}`],
    ["橋隧層級", `bridge=${osm.bridge || "-"} / tunnel=${osm.tunnel || "-"} / layer=${osm.layer || "-"}`],
  ];
  $("osmSummary").innerHTML = items.map(([label, value]) => `
    <div class="summary-card">
      <strong>${label}</strong>
      <span>${value}</span>
    </div>
  `).join("");
}

function renderLaneOsmReference(segment) {
  const box = $("laneOsmReference");
  if (!box) return;
  const osm = segment?.osm_selected_tags || {};
  const tags = segment?.lane_nav_tags || {};
  const rows = [
    ["車道數", `lanes=${osm.lanes || tags.lane_count_total || "-"} / forward=${osm["lanes:forward"] || tags.lane_count_forward || "-"} / backward=${osm["lanes:backward"] || tags.lane_count_backward || "-"}`],
    ["OSM 轉向", `turn:lanes=${osm["turn:lanes"] || "-"} / forward=${osm["turn:lanes:forward"] || "-"} / backward=${osm["turn:lanes:backward"] || "-"}`],
    ["機車車道", `motorcycle:lanes=${osm["motorcycle:lanes"] || "-"} / forward=${osm["motorcycle:lanes:forward"] || "-"} / backward=${osm["motorcycle:lanes:backward"] || "-"}`],
    ["車道通行", `access:lanes=${osm["access:lanes"] || "-"} / motor_vehicle:lanes=${osm["motor_vehicle:lanes"] || "-"} / vehicle:lanes=${osm["vehicle:lanes"] || "-"}`],
    ["變換車道", `change:lanes=${osm["change:lanes"] || "-"} / forward=${osm["change:lanes:forward"] || "-"} / backward=${osm["change:lanes:backward"] || "-"}`],
  ];
  box.innerHTML = rows.map(([label, value]) => `
    <div>
      <strong>${label}</strong>
      <span>${value}</span>
    </div>
  `).join("");
}

function renderNearbyIntersections(rows) {
  const box = $("nearbyIntersections");
  box.innerHTML = "";
  const select = $("appliesToIntersection");
  select.innerHTML = `<option value="">先選附近路口</option>`;
  if (!rows.length) {
    box.textContent = "60m 內沒有候選路口。若現場是路口，請在備註寫 OSM intersection missing。";
    return;
  }
  for (const item of rows) {
    const presentation = intersectionPresentation(item);
    const status = intersectionDisplayStatus(item.nav_intersection_key);
    const option = document.createElement("option");
    option.value = item.nav_intersection_key;
    option.textContent = `${presentation.displayName} (${item.nav_intersection_key}, ${item.distance_m}m)`;
    option.selected = item.nav_intersection_key === state.selectedIntersectionKey;
    select.appendChild(option);

    const div = document.createElement("div");
    div.className = "nearby-item";
    if (item.nav_intersection_key === state.selectedIntersectionKey) div.classList.add("active");
    const link = item.map_links?.google_maps || item.map_links?.openstreetmap;
    const statusControl = status && status.kind !== "checked"
      ? `<span class="intersection-status ${status.kind}">${status.label}</span>`
      : `<button type="button" class="review-toggle${status?.kind === "checked" ? " active" : ""}">${status?.kind === "checked" ? "✓ 已檢查" : "標為已檢查"}</button>`;
    div.innerHTML = `
      <div class="intersection-heading">
        <strong>${presentation.displayName}</strong>
        ${statusControl}
      </div>
      ${item.nav_intersection_key} · ${item.distance_m}m · ${targetText(item.manual_targets)}${link ? `<br><a href="${link}" target="_blank" rel="noreferrer">Open Map</a>` : ""}
    `;
    const reviewButton = div.querySelector(".review-toggle");
    if (reviewButton) {
      reviewButton.addEventListener("click", (event) => toggleIntersectionReview(event, item));
    }
    const favouriteKey = favouriteIntersectionKey(state.selectedKey, item.nav_intersection_key);
    const favouriteButton = document.createElement("button");
    favouriteButton.type = "button";
    favouriteButton.className = "review-toggle";
    favouriteButton.textContent = state.favouriteIntersectionKeys.has(favouriteKey) ? "★ 已收藏" : "☆ 我的最愛";
    favouriteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.favouriteIntersectionKeys.has(favouriteKey)) state.favouriteIntersectionKeys.delete(favouriteKey);
      else state.favouriteIntersectionKeys.add(favouriteKey);
      persistFavouriteIntersectionKeys();
      renderNearbyIntersections(state.selectedNearbyIntersections);
      reloadAll();
    });
    div.querySelector(".intersection-heading")?.appendChild(favouriteButton);
    div.addEventListener("click", () => {
      selectNearbyIntersection(item);
    });
    box.appendChild(div);
  }
}

function latestLaneTags(annotation) {
  return annotation?.lane_nav_tags || {};
}

function buildContextKey(segmentKey, scope, direction, intersectionKey = null) {
  return modelContextKey({
    nav_segment_key: segmentKey,
    context_scope: scope,
    intersection_key: intersectionKey,
    approach_direction: direction,
  });
}

function segmentDirectionAnnotation(direction) {
  if (!state.selectedSegment) return null;
  const key = buildContextKey(
    state.selectedSegment.object_identity.nav_segment_key,
    "segment_direction",
    direction
  );
  return state.contextAnnotations.find((row) => row.object_identity?.nav_context_key === key) || null;
}

function firstLaneProfile(annotation) {
  return contextLaneData(annotation).laneProfiles[0] || null;
}

function renderIntersectionRuleOverview() {
  const section = $("intersectionRuleOverview");
  const box = $("intersectionRuleOverviewList");
  if (!state.selectedIntersectionKey) {
    section.hidden = true;
    box.innerHTML = "";
    return;
  }
  section.hidden = false;
  const rows = intersectionRuleOverview({
    intersectionKey: state.selectedIntersectionKey,
    contextAnnotations: state.contextAnnotations,
    legacyAnnotation: state.legacyAnnotation,
  });
  if (!rows.length) {
    box.innerHTML = `<p class="hint">此入口尚無已記錄規則。</p>`;
    return;
  }
  box.innerHTML = rows.map((rule) => {
    const direction = rule.approach_direction === "forward"
      ? "OSM 正向"
      : rule.approach_direction === "backward" ? "OSM 反向" : "方向未指定";
    const origin = rule.data_origin === "legacy" ? "舊版資料" : "新版資料";
    const rows = [
      ["轉向", rule.movement || "unknown"], ["目標道路", rule.target_road || rule.to_segment_key || "unknown"],
      ["目標 OSM way", rule.to_segment_key || "unknown"], ["汽車規則", rule.vehicle_rule || "unknown"],
      ["機車規則", rule.motorcycle_turn_rule || "unknown"], ["待轉牌", rule.two_stage_sign_exists || "unknown"],
      ["待轉區", rule.waiting_zone_exists || "unknown"], ["待轉區位置", rule.waiting_zone_position || "unknown"],
    ];
    if (rule.target_relation) rows.push(["錯落路口", rule.target_relation.reason + (rule.target_relation.note ? `：${rule.target_relation.note}` : "")]);
    return `<div class="rule-item overview-rule overview-rule-card"><div><strong>${direction}</strong> <span class="overview-origin ${rule.data_origin}">${origin}</span></div><dl class="overview-fields">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl></div>`;
  }).join("");
}

function parentLaneProfile(direction) {
  const contextAnnotation = segmentDirectionAnnotation(direction);
  if (contextAnnotation) {
    const contextParent = firstLaneProfile(contextAnnotation);
    return contextParent ? { profile: contextParent, origin: "context_v2" } : null;
  }
  const legacyProfile = contextLaneData(state.legacyAnnotation).laneProfiles.find(
    (profile) => profile.direction === direction
  ) || null;
  return legacyProfile ? { profile: legacyProfile, origin: "legacy" } : null;
}

function renderLaneInheritance() {
  const box = $("laneInheritanceStatus");
  const direction = $("approachDirection").value;
  if (!state.selectedSegment || !["forward", "backward"].includes(direction)) {
    box.textContent = "選定 OSM 方向後，這裡會顯示父層車道資料。";
    box.className = "inheritance-status";
    return;
  }
  if (currentContextScope() === "segment_direction") {
    box.textContent = "目前編輯整段道路方向的父層車道配置。";
    box.className = "inheritance-status";
    return;
  }
  const parentData = parentLaneProfile(direction);
  const parent = parentData?.profile || null;
  const child = state.laneProfiles[0] || null;
  if (!parent) {
    box.textContent = "此方向沒有整段道路父層車道配置。";
    box.className = "inheritance-status";
    return;
  }
  const resolved = resolveLaneProfile(parent, child);
  if (resolved.laneCountMismatch) {
    box.textContent = `父層 ${parent.lane_count} 車道、此路口 ${child.lane_count} 車道，車道數不同；不自動繼承，請人工確認完整路口配置。`;
    box.className = "inheritance-status warning";
    return;
  }
  const inherited = resolved.inherited.length ? resolved.inherited.join("、") : "無";
  const origin = parentData.origin === "legacy" ? "沿用舊版路段配置；" : "";
  box.textContent = `${origin}整段父層：${parent.lane_count} 車道；目前從父層繼承：${inherited}。`;
  box.className = "inheritance-status";
}

function contextLaneData(annotation) {
  const laneTags = latestLaneTags(annotation);
  return {
    movementRules: laneTags.taiwan_motorcycle_tags?.movement_rules || [],
    laneProfiles: laneTags.lane_detail_tags?.lane_profiles || [],
  };
}

function legacyLaneData(annotation, scope, direction, intersectionKey) {
  const data = contextLaneData(annotation);
  const legacyVerifiedAt = annotation?.annotation_metadata?.verified_at || null;
  return {
    movementRules: scope === "intersection_approach"
      ? data.movementRules.filter((rule) =>
        rule.approach_direction === direction && rule.applies_to_intersection_key === intersectionKey)
        .map((rule) => ({
          ...structuredClone(rule),
          data_origin: "legacy",
          legacy_verified_at: legacyVerifiedAt,
        }))
      : [],
    laneProfiles: scope === "segment_direction"
      ? data.laneProfiles.filter((profile) => profile.direction === direction)
      : [],
  };
}

function setFormFromSegment(segment, annotation, laneData = null) {
  const laneTags = latestLaneTags(annotation);
  const review = laneTags.osm_review_tags || {};
  const taiwan = laneTags.taiwan_motorcycle_tags || {};
  const laneDetail = laneTags.lane_detail_tags || {};
  $("navSegmentKey").value = segment.object_identity.nav_segment_key;
  $("osmLaneStatus").value = review.osm_lane_status || "not_checked";
  $("osmTurnLaneStatus").value = review.osm_turn_lane_status || "not_checked";
  $("osmMotorcycleStatus").value = review.osm_motorcycle_status || "not_checked";
  $("osmReviewNote").value = review.osm_review_note || "";
  const selectedData = laneData || {
    movementRules: taiwan.movement_rules,
    laneProfiles: laneDetail.lane_profiles,
  };
  state.movementRules = Array.isArray(selectedData.movementRules) ? structuredClone(selectedData.movementRules) : [];
  state.laneProfiles = Array.isArray(selectedData.laneProfiles) ? structuredClone(selectedData.laneProfiles) : [];
  renderMovementRules();
  renderLaneProfiles();
  $("confidence").value = annotation?.annotation_metadata?.confidence || "medium";
  $("verifiedBy").value = annotation?.annotation_metadata?.verified_by || localStorage.getItem("lanePilotVerifiedBy") || "";
  $("evidenceType").value = annotation?.annotation_metadata?.evidence_type || "streetview";
  $("note").value = annotation?.annotation_metadata?.note || "";
}

function resetTransientEditors() {
  setMovementRuleStatus();
  $("targetSegmentKey").value = "";
  $("targetRoad").value = "";
  $("movementType").value = "left";
  $("vehicleMovementRule").value = "normal";
  $("motorcycleTurnRule").value = "unknown";
  $("twoStageSignExists").value = "unknown";
  $("waitingZoneExists").value = "unknown";
  $("waitingZonePosition").value = "unknown";
  $("laneMovements").value = "";
  $("laneMotorcycleAccess").value = "";
  $("selectedRoad").value = currentRoadLabel();
  $("targetSegmentKey").hidden = true;
  $("targetSegmentAssist").hidden = true;
  $("targetRoadHint").textContent = "未選路口時，車道配置屬於目前路段方向。";
  if (state.selectedIntersectionKey) {
    const intersection = state.selectedNearbyIntersections.find(
      (item) => item.nav_intersection_key === state.selectedIntersectionKey
    );
    if (intersection) setSelectedRoadFields(intersection);
  }
  refreshSegmentMapStyles();
}

function loadActiveContext() {
  const scope = currentContextScope();
  renderIntersectionRuleOverview();
  if (!state.selectedSegment) {
    state.activeDraftIdentity = null;
    state.formBaseline = null;
    state.dirty = false;
    updateDirtyStatus();
    setContextStatus(scope === "intersection_approach"
      ? "請先選擇路段與路口，再人工確認 OSM 方向。"
      : "請先選擇路段，再人工確認 OSM 方向。", "empty");
    return;
  }
  const direction = $("approachDirection").value;
  const intersectionKey = scope === "intersection_approach" ? state.selectedIntersectionKey : null;
  const segmentKey = state.selectedSegment.object_identity.nav_segment_key;
  const contextKey = buildContextKey(segmentKey, scope, direction, intersectionKey);
  resetTransientEditors();
  if (!contextKey) {
    setFormFromSegment(state.selectedSegment, null);
    renderLaneInheritance();
    setContextStatus(scope === "intersection_approach"
      ? "請先選擇路口並人工確認 OSM 方向。"
      : "請先人工確認 OSM 方向。", "empty");
    activateDraftContext();
    return;
  }

  const exact = state.contextAnnotations.find(
    (row) => row.object_identity?.nav_context_key === contextKey
  );
  if (exact) {
    state.selectedAnnotation = exact;
    setFormFromSegment(state.selectedSegment, exact);
    renderLaneInheritance();
    setContextStatus(`正在編輯既有資料：${contextKey}`, "existing");
    activateDraftContext();
    return;
  }

  if (scope === "intersection_approach") {
    const segmentContextKey = buildContextKey(segmentKey, "segment_direction", direction);
    const segmentFallback = state.contextAnnotations.find(
      (row) => row.object_identity?.nav_context_key === segmentContextKey
    );
    if (segmentFallback) {
      state.selectedAnnotation = null;
      setFormFromSegment(state.selectedSegment, null, {
        movementRules: [],
        laneProfiles: [],
      });
      renderLaneInheritance();
      setContextStatus(`尚無此路口資料；目前顯示整段方向 ${segmentContextKey} 的車道配置作為參考，儲存後會建立 ${contextKey}。`, "inherited");
      activateDraftContext();
      return;
    }
  }

  if (state.legacyAnnotation) {
    state.selectedAnnotation = null;
    const fallback = legacyLaneData(state.legacyAnnotation, scope, direction, intersectionKey);
    const legacyParent = scope === "intersection_approach" && parentLaneProfile(direction)?.origin === "legacy";
    if (fallback.movementRules.length || fallback.laneProfiles.length || legacyParent) {
      setFormFromSegment(state.selectedSegment, state.legacyAnnotation, fallback);
      renderLaneInheritance();
      const profileWarning = legacyParent ? " 沿用舊版路段配置；入口若不同再另外編輯。" : "";
      setContextStatus(`正在沿用舊版資料：${segmentKey} 的同方向資料；儲存後會建立 ${contextKey}。${profileWarning}`, "legacy");
      activateDraftContext();
      return;
    }
  }

  state.selectedAnnotation = null;
  setFormFromSegment(state.selectedSegment, null);
  renderLaneInheritance();
  setContextStatus(`此範圍尚未標註；儲存後會建立 ${contextKey}。`, "empty");
  activateDraftContext();
}

async function loadSegmentDetail(key, options = {}) {
  state.selectedKey = key;
  const params = new URLSearchParams({ key, ...geoParams() });
  const data = await fetchJson(`/api/segment?${params.toString()}`);
  state.selectedSegment = data.segment;
  state.selectedAnnotation = null;
  state.legacyAnnotation = data.legacy_annotation || data.annotation || null;
  state.contextAnnotations = data.context_annotations || [];
  state.selectedNearbyIntersections = data.nearby_intersections || [];
  state.selectedIntersectionKey = null;
  await loadIntersectionReviews();
  if (state.selectedIntersectionLayer) state.selectedIntersectionLayer.clearLayers();

  const segment = data.segment;
  const tags = segment.lane_nav_tags || {};
  const osm = segment.osm_selected_tags || {};
  $("detailTitle").textContent = tags.road_name || osm.name || key;
  $("detailSubtitle").textContent = `${key} · ${tags.road_class || osm.highway || "unknown"} · priority ${tags.candidate_priority ?? "-"}`;

  const links = $("mapLinks");
  links.innerHTML = "";
  for (const [label, href] of Object.entries(segment.map_links || {})) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = label === "openstreetmap" ? "Open OSM" : "Open Map";
    links.appendChild(a);
  }

  drawGeometry(segment.geometry);
  renderDirectionInfo(segment.geometry);
  renderOsmSummary(segment);
  renderLaneOsmReference(segment);
  renderTags(segment.osm_selected_tags);
  renderNearbyIntersections(state.selectedNearbyIntersections);
  renderMapIntersections(state.selectedNearbyIntersections);
  setFormFromSegment(segment, null);
  loadActiveContext();
  if (options.focusMap) focusMapOnGeometry(segment.geometry);
  refreshSegmentMapStyles();
  await loadSegments();
}

function renderMovementRules() {
  const box = $("movementRulesList");
  box.innerHTML = "";
  if (!state.movementRules.length) {
    box.innerHTML = `<p class="hint">尚未新增機車例外規則。若 OSM 已足夠且沒有二段式/待轉資訊要補，可以直接儲存審核狀態。</p>`;
    return;
  }
  state.movementRules.forEach((rule, index) => {
    const item = document.createElement("div");
    item.className = "rule-item";
    const title = `${rule.approach_direction} · ${rule.movement} · ${rule.target_road || rule.to_segment_key || "目標待確認"}`;
    const originBadge = rule.data_origin === "legacy" ? `<span class="rule-origin">舊版資料</span>` : "";
    item.innerHTML = `
      <div>
        <strong>${title}</strong>${originBadge}<br>
        <span>${rule.applies_to_intersection_key || "未選路口"} · 機車 ${rule.motorcycle_turn_rule} · 待轉區 ${rule.waiting_zone_exists}</span>
      </div>
      <button type="button">移除</button>
    `;
    item.querySelector("button").addEventListener("click", async () => {
      const [removedRule] = state.movementRules.splice(index, 1);
      renderMovementRules();
      markFormDirty();
      saveCurrentDraft();
      setMovementRuleStatus("規則刪除中...");
      try {
        await persistAnnotation({ preserveTargetSelection: true });
        setMovementRuleStatus("規則已移除並同步 JSON");
      } catch (error) {
        state.movementRules.splice(index, 0, removedRule);
        renderMovementRules();
        markFormDirty();
        setMovementRuleStatus(`移除規則失敗：${error.message}`, true);
      }
    });
    box.appendChild(item);
  });
}

function splitLaneList(value) {
  return value.split("|").map((item) => item.trim()).filter(Boolean);
}

function parseLaneMovementList(value) {
  return splitLaneList(value).map((lane) =>
    lane.split(";").map((movement) => movement.trim()).filter(Boolean).join(";")
  );
}

const ALLOWED_LANE_MOVEMENTS = new Set([
  "left",
  "through",
  "right",
  "slight_left",
  "slight_right",
  "merge_to_left",
  "merge_to_right",
  "reverse",
  "unknown",
]);

const ALLOWED_MOTORCYCLE_LANE_ACCESS = new Set(["yes", "no", "designated", "unknown"]);

function findInvalidValues(values, allowed) {
  return values.filter((value) => !allowed.has(value));
}

function findInvalidLaneMovements(lanes) {
  return lanes.flatMap((lane) => findInvalidValues(lane.split(";"), ALLOWED_LANE_MOVEMENTS));
}

function renderLaneProfiles() {
  const box = $("laneProfilesList");
  box.innerHTML = "";
  if (!state.laneProfiles.length) {
    const direction = $("approachDirection").value;
    const inherited = currentContextScope() === "intersection_approach" &&
      ["forward", "backward"].includes(direction)
      ? parentLaneProfile(direction)
      : null;
    if (inherited?.profile) {
      const profile = inherited.profile;
      const item = document.createElement("div");
      item.className = "rule-item inherited-profile";
      item.innerHTML = `
        <div>
          <strong>${profile.direction || direction} · ${profile.lane_count} 車道（沿用整段道路）</strong><br>
          <span>轉向 ${profile.lane_movements?.join("|") || "未標"} · 機車 ${profile.motorcycle_access_by_lane?.join("|") || "未標"}</span><br>
          <span class="hint">這是父層配置；若要移除，請回到未選路口的相同 OSM 方向。</span>
        </div>
      `;
      box.appendChild(item);
      return;
    }
    box.innerHTML = `<p class="hint">尚未新增人工車道配置。若 OSM turn:lanes 已正確，可以不填；系統會以 OSM 作為預設。</p>`;
    return;
  }
  state.laneProfiles.forEach((profile, index) => {
    const item = document.createElement("div");
    item.className = "rule-item";
    item.innerHTML = `
      <div>
        <strong>${profile.direction} · ${profile.lane_count} 車道</strong><br>
        <span>轉向 ${profile.lane_movements?.join("|") || "沿用父層/未標"} · 機車 ${profile.motorcycle_access_by_lane?.join("|") || "沿用父層/未標"}</span>
      </div>
      <button type="button">移除</button>
    `;
    item.querySelector("button").addEventListener("click", async () => {
      const [removedProfile] = state.laneProfiles.splice(index, 1);
      renderLaneProfiles();
      renderLaneInheritance();
      markFormDirty();
      saveCurrentDraft();
      $("saveStatus").textContent = "車道配置刪除中...";
      try {
        await persistAnnotation({ preserveTargetSelection: true });
        $("saveStatus").textContent = "車道配置已移除並同步 JSON";
      } catch (error) {
        state.laneProfiles.splice(index, 0, removedProfile);
        renderLaneProfiles();
        renderLaneInheritance();
        markFormDirty();
        $("saveStatus").textContent = `移除車道配置失敗：${error.message}`;
      }
    });
    box.appendChild(item);
  });
}

async function addLaneProfileFromForm() {
  if (!["forward", "backward"].includes($("approachDirection").value)) {
    $("saveStatus").textContent = "請先人工確認 OSM 正向或反向";
    return;
  }
  const movements = parseLaneMovementList($("laneMovements").value);
  const motorcycleAccess = splitLaneList($("laneMotorcycleAccess").value);
  if (!movements.length && !motorcycleAccess.length) {
    $("saveStatus").textContent = "請至少輸入車道轉向或機車可行性其中一項";
    return;
  }
  const invalidMovements = findInvalidLaneMovements(movements);
  if (invalidMovements.length) {
    $("saveStatus").textContent = `車道轉向有未約定值：${invalidMovements.join(", ")}`;
    return;
  }
  const invalidMotorcycleAccess = findInvalidValues(motorcycleAccess, ALLOWED_MOTORCYCLE_LANE_ACCESS);
  if (invalidMotorcycleAccess.length) {
    $("saveStatus").textContent = `機車可行性有未約定值：${invalidMotorcycleAccess.join(", ")}`;
    return;
  }
  if (movements.length && motorcycleAccess.length && motorcycleAccess.length !== movements.length) {
    $("saveStatus").textContent = "機車可行性欄位數量要和車道轉向數量相同";
    return;
  }
  const laneCount = movements.length || motorcycleAccess.length;
  state.laneProfiles = [{
    direction: $("approachDirection").value,
    lane_count: laneCount,
    lane_movements: movements.length ? movements : null,
    motorcycle_access_by_lane: motorcycleAccess.length ? motorcycleAccess : null,
    source: "manual",
  }];
  $("laneMovements").value = "";
  $("laneMotorcycleAccess").value = "";
  $("saveStatus").textContent = "";
  renderLaneProfiles();
  renderLaneInheritance();
  markFormDirty();
  saveCurrentDraft();
  const button = $("addLaneProfile");
  button.disabled = true;
  $("saveStatus").textContent = "車道配置儲存中...";
  try {
    await persistAnnotation({ preserveTargetSelection: true });
    $("saveStatus").textContent = "車道配置已新增並同步 JSON";
  } catch (error) {
    saveCurrentDraft();
    $("saveStatus").textContent = `新增車道配置失敗：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function addMovementRuleFromForm() {
  if (!$("appliesToIntersection").value) {
    setMovementRuleStatus("請先選擇適用路口", true);
    return;
  }
  if (!["forward", "backward"].includes($("approachDirection").value)) {
    setMovementRuleStatus("請先人工確認 OSM 正向或反向", true);
    return;
  }
  const targetSegmentKey = $("targetSegmentKey").value;
  const targetRoad = $("targetRoad").value.trim();
  if (!targetRoad) {
    setMovementRuleStatus("請輸入目標道路", true);
    return;
  }
  syncTwoStageDefaults();
  const fromContextKey = buildContextKey(
    $("navSegmentKey").value,
    "intersection_approach",
    $("approachDirection").value,
    $("appliesToIntersection").value
  );
  const movement = $("movementType").value;
  const key = movementIdentity(fromContextKey, targetSegmentKey, targetRoad, movement);
  const rule = {
    movement_key: key,
    from_context_key: fromContextKey,
    to_segment_key: targetSegmentKey || null,
    applies_to_intersection_key: $("appliesToIntersection").value || null,
    approach_segment_key: $("navSegmentKey").value,
    selected_road: $("selectedRoad").value.trim() || currentRoadName() || null,
    approach_direction: $("approachDirection").value,
    movement,
    target_road: targetRoad,
    vehicle_rule: $("vehicleMovementRule").value,
    motorcycle_turn_rule: $("motorcycleTurnRule").value,
    two_stage_sign_exists: $("twoStageSignExists").value,
    waiting_zone_exists: $("waitingZoneExists").value,
    waiting_zone_position: $("waitingZonePosition").value,
    ...(state.pendingTargetRelation ? { target_relation: state.pendingTargetRelation } : {}),
    data_origin: "context_v2",
  };
  const existingIndex = state.movementRules.findIndex((item) => item.movement_key === key);
  if (existingIndex >= 0) state.movementRules[existingIndex] = rule;
  else state.movementRules.push(rule);
  $("vehicleMovementRule").value = "normal";
  $("motorcycleTurnRule").value = "unknown";
  $("twoStageSignExists").value = "unknown";
  $("waitingZoneExists").value = "unknown";
  $("waitingZonePosition").value = "unknown";
  setMovementRuleStatus("規則儲存中...");
  renderMovementRules();
  markFormDirty();
  saveCurrentDraft();
  const button = $("addMovementRule");
  button.disabled = true;
  try {
    await persistAnnotation({ preserveTargetSelection: true });
    setMovementRuleStatus("規則已新增並儲存");
  } catch (error) {
    saveCurrentDraft();
    setMovementRuleStatus(`新增規則儲存失敗：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function buildAnnotationPayload() {
  const segment = state.selectedSegment;
  if (!segment) throw new Error("尚未選擇路段");
  const scope = currentContextScope();
  const direction = $("approachDirection").value;
  const intersectionKey = scope === "intersection_approach" ? state.selectedIntersectionKey : null;
  const segmentKey = $("navSegmentKey").value;
  const contextKey = buildContextKey(segmentKey, scope, direction, intersectionKey);
  if (!contextKey) {
    throw new Error(scope === "intersection_approach"
      ? "請先選擇路口並人工確認 OSM 方向"
      : "請先人工確認 OSM 方向");
  }
  return {
    object_identity: {
      schema_version: 2,
      object_type: "nav_context_annotation",
      nav_context_key: contextKey,
      nav_segment_key: segmentKey,
      context_scope: scope,
      applies_to_intersection_key: intersectionKey,
      approach_direction: direction,
      source_osm: segment.object_identity.source_osm,
      split_index: segment.object_identity.split_index,
    },
    osm_reference: {
      osm_selected_tags: segment.osm_selected_tags,
      map_links: segment.map_links,
      nearby_intersections: state.selectedNearbyIntersections,
    },
    lane_nav_tags: {
      osm_review_tags: {
        osm_lane_status: $("osmLaneStatus").value,
        osm_turn_lane_status: $("osmTurnLaneStatus").value,
        osm_motorcycle_status: $("osmMotorcycleStatus").value,
        osm_review_note: $("osmReviewNote").value.trim() || null,
      },
      taiwan_motorcycle_tags: {
        movement_rules: scope === "intersection_approach" ? state.movementRules : [],
      },
      lane_detail_tags: {
        lane_profiles: state.laneProfiles,
      },
    },
    geometry: segment.geometry,
    annotation_metadata: {
      created_from: "manual_form",
      evidence_type: $("evidenceType").value,
      manual_verified: "yes",
      verified_by: $("verifiedBy").value.trim() || "unknown",
      verified_at: localHourString(),
      verified_at_precision: "hour",
      verified_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
      confidence: $("confidence").value,
      note: $("note").value.trim(),
    },
  };
}

async function persistAnnotation(options) {
  options = options || {};
  const preserveTargetSelection = Boolean(options.preserveTargetSelection);
  const targetSelection = preserveTargetSelection
    ? {
        targetSegmentKey: $("targetSegmentKey").value,
        targetRoad: $("targetRoad").value,
      }
    : null;
  localStorage.setItem("lanePilotVerifiedBy", $("verifiedBy").value.trim());
  const payload = buildAnnotationPayload();
  await fetchJson("/api/annotations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  clearCurrentDraft();
  state.contextAnnotations = state.contextAnnotations.filter(
    (row) => row.object_identity?.nav_context_key !== payload.object_identity.nav_context_key
  );
  state.contextAnnotations.push(payload);
  if (payload.object_identity.context_scope === "intersection_approach") {
    state.intersectionReviews.delete(intersectionReviewKey(
      payload.object_identity.nav_segment_key,
      payload.object_identity.applies_to_intersection_key
    ));
  }
  loadActiveContext();
  if (targetSelection) {
    $("targetSegmentKey").value = targetSelection.targetSegmentKey;
    $("targetRoad").value = targetSelection.targetRoad;
    $("targetRoadHint").textContent = "已保留剛才的目標 OSM way；請以地圖藍線確認。";
    refreshSegmentMapStyles();
  }
  renderNearbyIntersections(state.selectedNearbyIntersections);
  await Promise.allSettled([loadMeta(), loadSegments()]);
  return payload;
}

async function saveAnnotation(event) {
  event.preventDefault();
  $("saveStatus").textContent = "儲存中...";
  try {
    await persistAnnotation();
    $("saveStatus").textContent = "已儲存到 annotations.jsonl";
  } catch (error) {
    saveCurrentDraft();
    $("saveStatus").textContent = error.message;
  }
}

function bindEvents() {
  const debouncedReload = debounce(reloadAll, 500);
  $("searchInput").addEventListener("input", debouncedReload);
  $("segmentScopeFilter").addEventListener("change", () => {
    if (!$("segmentScopeFilter").value) $("targetFilter").value = "";
    reloadAll();
  });
  $("targetFilter").addEventListener("change", reloadAll);
  $("statusFilter").addEventListener("change", loadSegments);
  $("segmentList").addEventListener("scroll", () => {
    const list = $("segmentList");
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (nearBottom && !state.segmentLoading && state.segmentLoaded < state.segmentTotal) {
      loadSegments({ append: true });
    }
  });
  $("appliesToIntersection").addEventListener("change", () => {
    const found = state.selectedNearbyIntersections.find((item) => item.nav_intersection_key === $("appliesToIntersection").value);
    if (found && !selectNearbyIntersection(found, { scroll: false })) {
      $("appliesToIntersection").value = state.selectedIntersectionKey || "";
    }
  });
  $("approachDirection").addEventListener("change", handleContextSelectorChange);
  $("targetSegmentKey").addEventListener("change", handleTargetSegmentChange);
  $("targetSegmentKey").addEventListener("change", () => { state.pendingTargetRelation = null; });
  $("tagFilterToggle").addEventListener("click", () => { const panel = $("tagFilterPanel"); panel.hidden = !panel.hidden; $("tagFilterToggle").setAttribute("aria-expanded", String(!panel.hidden)); });
  document.querySelectorAll(".tag-filter-option").forEach((input) => input.addEventListener("change", () => { updateTagFilterLabel(); reloadAll(); }));
  $("tagFilterMode").addEventListener("change", reloadAll);
  $("clearTagFilter").addEventListener("click", () => { document.querySelectorAll(".tag-filter-option").forEach((input) => { input.checked = false; }); updateTagFilterLabel(); reloadAll(); });
  document.querySelectorAll('input[name="offsetReason"]').forEach((input) => input.addEventListener("change", syncOffsetReasonNote));
  $("confirmOffsetTarget").addEventListener("click", (event) => { event.preventDefault(); confirmOffsetTarget(); });
  $("cancelOffsetTarget").addEventListener("click", () => { state.pendingOffsetTarget = null; });
  $("twoStageSignExists").addEventListener("change", syncTwoStageDefaults);
  $("waitingZoneExists").addEventListener("change", syncTwoStageDefaults);
  $("motorcycleTurnRule").addEventListener("change", syncTwoStageDefaults);
  $("verifiedBy").addEventListener("input", () => {
    localStorage.setItem("lanePilotVerifiedBy", $("verifiedBy").value.trim());
  });
  $("addMovementRule").addEventListener("click", addMovementRuleFromForm);
  $("addLaneProfile").addEventListener("click", addLaneProfileFromForm);
  const contextControls = new Set(["approachDirection", "appliesToIntersection"]);
  const handleFormChange = (event) => {
    if (!contextControls.has(event.target.id)) markFormDirty();
  };
  $("annotationForm").addEventListener("input", handleFormChange);
  $("annotationForm").addEventListener("change", handleFormChange);
  $("annotationForm").addEventListener("submit", saveAnnotation);
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    saveCurrentDraft();
    event.preventDefault();
    event.returnValue = "";
  });
}

async function boot() {
  state.favouriteIntersectionKeys = loadFavouriteIntersectionKeys();
  updateTagFilterLabel();
  bindEvents();
  await loadAreas();
  initMap();
  await loadMeta();
  await reloadAll();
}

boot();
