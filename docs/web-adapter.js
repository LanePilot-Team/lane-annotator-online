// GitHub Pages 版資料層（web adapter）— 對應 lane-annotator schema v2（approach-scoped contexts）
//
// 設計：app.js / annotation_model.js 一行不改。app.js 所有資料存取都走 fetch("/api/...")，
// 這裡在 app.js 載入前攔截 window.fetch，把 server.py 的查詢邏輯在瀏覽器內重做：
//   讀：docs/data/ 的行政區 shard（靜態檔）
//       + GitHub 上的 annotations.jsonl / intersection_reviews.jsonl（合併版）
//       + annotations/、intersection-reviews/ 佇列目錄（已存、尚未被 Action 合併）
//   寫：GitHub Contents API，每筆標註/已檢查事件存佇列一個 json 檔，
//       由 GitHub Action（merge-annotations.yml）自動合併回正式檔。
// 同學之後更新 lane-annotator 前端時，把新檔複製過來即可，本檔只在 server.py 端點變動時要跟。
//
// v2 重點：一個路段可有多筆標註，儲存 key = object_identity.nav_context_key
//（例 way/A@node/J/forward）；沒有 nav_context_key 的是 legacy 整段標註（key = nav_segment_key）。
(() => {
  const LEGACY_REPO = "LanePilot-Team/LanePilot";
  const PUBLIC_REPO = "LanePilot-Team/lane-annotator-online";

  function migrateLegacyStorageSettings() {
    const storedRepo = localStorage.getItem("lanePilotRepo");
    const storedBranch = localStorage.getItem("lanePilotBranch");
    if (storedRepo === LEGACY_REPO && (!storedBranch || storedBranch === "online")) {
      localStorage.setItem("lanePilotRepo", PUBLIC_REPO);
      localStorage.setItem("lanePilotBranch", "main");
    }
  }

  migrateLegacyStorageSettings();

  const CONFIG = Object.assign(
    {
      repo: PUBLIC_REPO,
      branch: "main",
      annotationsDir: "annotations",
      reviewsDir: "intersection-reviews",
      mergedAnnotationsPath: "exports/annotations.jsonl",
      mergedReviewsPath: "exports/intersection_reviews.jsonl",
      dataBase: "./data",
    },
    window.LANEPILOT_WEB_CONFIG || {}
  );

  const settings = {
    get repo() { return localStorage.getItem("lanePilotRepo") || CONFIG.repo; },
    get branch() { return localStorage.getItem("lanePilotBranch") || CONFIG.branch; },
    get token() { return localStorage.getItem("lanePilotToken") || ""; },
  };

  // 與 server.py CITY_BBOXES 相同（縣市下拉備援）
  const CITY_BBOXES = {
    keelung: { name: "基隆市", min_lng: 121.62, min_lat: 25.05, max_lng: 122.02, max_lat: 25.21 },
    taipei: { name: "臺北市", min_lng: 121.45, min_lat: 24.96, max_lng: 121.67, max_lat: 25.22 },
    new_taipei: { name: "新北市", min_lng: 121.25, min_lat: 24.67, max_lng: 122.01, max_lat: 25.31 },
    taoyuan: { name: "桃園市", min_lng: 120.97, min_lat: 24.58, max_lng: 121.48, max_lat: 25.13 },
    hsinchu_city: { name: "新竹市", min_lng: 120.88, min_lat: 24.72, max_lng: 121.03, max_lat: 24.86 },
    hsinchu_county: { name: "新竹縣", min_lng: 120.95, min_lat: 24.4, max_lng: 121.35, max_lat: 24.95 },
    miaoli: { name: "苗栗縣", min_lng: 120.62, min_lat: 24.25, max_lng: 121.28, max_lat: 24.75 },
    taichung: { name: "臺中市", min_lng: 120.46, min_lat: 23.99, max_lng: 121.46, max_lat: 24.45 },
    changhua: { name: "彰化縣", min_lng: 120.25, min_lat: 23.78, max_lng: 120.7, max_lat: 24.2 },
    nantou: { name: "南投縣", min_lng: 120.62, min_lat: 23.45, max_lng: 121.35, max_lat: 24.25 },
    yunlin: { name: "雲林縣", min_lng: 120.08, min_lat: 23.45, max_lng: 120.75, max_lat: 23.85 },
    chiayi_city: { name: "嘉義市", min_lng: 120.38, min_lat: 23.42, max_lng: 120.52, max_lat: 23.55 },
    chiayi_county: { name: "嘉義縣", min_lng: 120.1, min_lat: 23.18, max_lng: 120.95, max_lat: 23.65 },
    tainan: { name: "臺南市", min_lng: 120.02, min_lat: 22.88, max_lng: 120.66, max_lat: 23.42 },
    kaohsiung: { name: "高雄市", min_lng: 120.17, min_lat: 22.47, max_lng: 121.05, max_lat: 23.48 },
    pingtung: { name: "屏東縣", min_lng: 120.42, min_lat: 21.88, max_lng: 120.9, max_lat: 22.9 },
    yilan: { name: "宜蘭縣", min_lng: 121.45, min_lat: 24.3, max_lng: 121.95, max_lat: 24.98 },
    hualien: { name: "花蓮縣", min_lng: 120.98, min_lat: 23.1, max_lng: 121.75, max_lat: 24.38 },
    taitung: { name: "臺東縣", min_lng: 120.7, min_lat: 21.88, max_lng: 121.6, max_lat: 23.45 },
    penghu: { name: "澎湖縣", min_lng: 119.3, min_lat: 23.15, max_lng: 119.75, max_lat: 23.85 },
    kinmen: { name: "金門縣", min_lng: 118.1, min_lat: 24.35, max_lng: 118.55, max_lat: 24.62 },
    lienchiang: { name: "連江縣", min_lng: 119.88, min_lat: 25.9, max_lng: 120.55, max_lat: 26.4 },
  };

  const GRID_SIZE = 0.01; // 與 server.py INTERSECTION_GRID_SIZE 一致

  const store = {
    manifest: undefined, // undefined=未載入, null=載入失敗
    areaId: null,
    segments: [],
    mapSegments: [],
    segmentsByKey: new Map(),
    intersectionGrid: new Map(),
    intersectionWayIndex: new Map(),
    // 標註：key 一律用 storage key（nav_context_key 或 legacy 的 nav_segment_key）
    merged: new Map(),
    pending: new Map(), // storageKey -> {name, download_url}（佇列最新一筆）
    pendingFetched: new Map(),
    session: new Map(),
    // 已檢查（intersection reviews）：key = "{segKey}@{intersectionKey}"
    mergedReviews: new Map(),
    pendingReviews: new Map(), // reviewKey -> row（由佇列檔名合成）或 null（off 事件）
    sessionReviews: new Map(), // reviewKey -> row 或 null（本工作階段取消）
    annotationsLoadedAt: null,
    annotationsError: null,
  };

  function warn(key, message) {
    if (typeof window.setDataWarning === "function") window.setDataWarning(key, message || "");
  }
  function setStatus(message) {
    const el = document.getElementById("lpWebStatus");
    if (el) el.textContent = message;
  }

  // ---------- key <-> 佇列檔名 ----------
  // storage key 形如 way/123、way/123#1、way/123/forward、way/123@node/456/forward
  // review key 形如 way/123@node/456
  function keyToSlug(key) {
    return key.replace(/\//g, "_").replace(/@/g, "~").replace(/#/g, "+");
  }
  function slugToKey(slug) {
    return slug.replace(/~/g, "@").replace(/\+/g, "#").replace(/_/g, "/");
  }
  function timeStamp() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  }
  function safeAuthor(author) {
    return (author || "unknown").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 24) || "unknown";
  }
  // storage key → 所屬路段 key（way/123 或 way/123#1 前綴）
  function segmentKeyOfStorageKey(storageKey) {
    const m = /^way\/\d+(?:#\d+)?/.exec(storageKey);
    return m ? m[0] : storageKey;
  }
  function storageKeyOf(record) {
    const identity = record?.object_identity || {};
    return identity.nav_context_key || identity.nav_segment_key;
  }
  function segmentKeyOf(record) {
    return record?.object_identity?.nav_segment_key;
  }

  // ---------- schema v2 context 驗證（annotation_contexts.py 移植） ----------
  function buildContextKey(navSegmentKey, scope, direction, intersectionKey) {
    if (scope !== "segment_direction" && scope !== "intersection_approach") throw new Error("invalid context scope");
    if (direction !== "forward" && direction !== "backward") throw new Error("direction must be forward or backward");
    if (scope === "intersection_approach") {
      if (!intersectionKey) throw new Error("intersection is required for an intersection approach");
      return `${navSegmentKey}@${intersectionKey}/${direction}`;
    }
    return `${navSegmentKey}/${direction}`;
  }
  function validateContextIdentity(identity) {
    if (identity.schema_version !== 2 || identity.object_type !== "nav_context_annotation") {
      throw new Error("schema v2 context identity is required");
    }
    const expected = buildContextKey(
      identity.nav_segment_key,
      identity.context_scope,
      identity.approach_direction,
      identity.applies_to_intersection_key
    );
    if (identity.nav_context_key !== expected) throw new Error(`nav_context_key must be ${expected}`);
  }

  // ---------- 幾何工具（server.py 移植） ----------
  function geometryCenter(geometry) {
    const coords = (geometry && geometry.coordinates) || [];
    if (!coords.length) return null;
    if (geometry.type === "Point" && coords.length >= 2) return { lng: coords[0], lat: coords[1] };
    const points = coords.filter((p) => Array.isArray(p) && p.length >= 2);
    if (!points.length) return null;
    return {
      lng: points.reduce((s, p) => s + p[0], 0) / points.length,
      lat: points.reduce((s, p) => s + p[1], 0) / points.length,
    };
  }

  function pointToSegmentDistanceKm(point, a, b) {
    const metersPerLat = 111320;
    const metersPerLng = 111320 * Math.cos((point.lat * Math.PI) / 180);
    const px = point.lng * metersPerLng, py = point.lat * metersPerLat;
    const ax = a[0] * metersPerLng, ay = a[1] * metersPerLat;
    const bx = b[0] * metersPerLng, by = b[1] * metersPerLat;
    const dx = bx - ax, dy = by - ay;
    if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay) / 1000;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) / 1000;
  }

  function gridCell(lng, lat) {
    return `${Math.floor(lng / GRID_SIZE)},${Math.floor(lat / GRID_SIZE)}`;
  }

  // ---------- shard 載入 ----------
  async function fetchStatic(path) {
    const res = await realFetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`讀取 ${path} 失敗（HTTP ${res.status}）`);
    return res;
  }

  async function ensureManifest() {
    if (store.manifest !== undefined) return store.manifest;
    try {
      const res = await fetchStatic(`${CONFIG.dataBase}/region_manifest.json`);
      store.manifest = await res.json();
      warn("lp_web_manifest");
    } catch (error) {
      store.manifest = null;
      warn("lp_web_manifest", `網頁版資料未就緒：${error.message}。請確認 docs/data/ 已放入行政區 shard。`);
    }
    return store.manifest;
  }

  async function ensureDistrict(areaId) {
    if (!areaId) { const err = new Error("district_area_id is required"); err.httpStatus = 400; throw err; }
    if (store.areaId === areaId && store.segments.length) return;
    const manifest = await ensureManifest();
    if (!manifest) throw new Error("網頁版資料未就緒（缺 region_manifest.json）");
    const region = (manifest.regions || []).find((r) => r.area_id === areaId);
    if (!region) {
      const err = new Error(`此網頁版目前只放入正在標註的行政區，尚未包含 ${areaId}。需要新增請聯絡資料維護者把該區 shard 放進 docs/data/regions/。`);
      err.httpStatus = 409;
      throw err;
    }
    const segPath = region.files?.["segments.jsonl"]?.path;
    const intPath = region.files?.["intersections.jsonl"]?.path;
    if (!segPath || !intPath) { const err = new Error(`manifest 缺 ${areaId} 的檔案路徑`); err.httpStatus = 409; throw err; }

    const parseJsonl = (text) => text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const contextRegions = [region, ...(region.context_area_ids || []).map((id) => (manifest.regions || []).find((item) => item.area_id === id))];
    if (contextRegions.some((item) => !item)) { const err = new Error(`找不到 ${areaId} 的相鄰區資料`); err.httpStatus = 409; throw err; }
    const loaded = await Promise.all(contextRegions.map(async (item) => {
      const [segText, intText] = await Promise.all([
        fetchStatic(`${CONFIG.dataBase}/${item.files["segments.jsonl"].path}`).then((r) => r.text()),
        fetchStatic(`${CONFIG.dataBase}/${item.files["intersections.jsonl"].path}`).then((r) => r.text()),
      ]);
      return { segments: parseJsonl(segText), intersections: parseJsonl(intText) };
    }));
    const segments = loaded[0].segments;
    segments.sort((a, b) => (b.lane_nav_tags?.candidate_priority ?? 0) - (a.lane_nav_tags?.candidate_priority ?? 0));
    const mapSegments = [...new Map(loaded.flatMap((item) => item.segments).map((item) => [item.object_identity.nav_segment_key, item])).values()];
    const intersections = [...new Map(loaded.flatMap((item) => item.intersections).map((item) => [item.object_identity.nav_intersection_key, item])).values()];
    intersections.sort((a, b) => (b.lane_nav_tags?.candidate_priority ?? 0) - (a.lane_nav_tags?.candidate_priority ?? 0));

    const grid = new Map();
    const wayIndex = new Map();
    for (const intersection of intersections) {
      const coords = intersection.geometry?.coordinates || [];
      if (coords.length >= 2) {
        const cell = gridCell(coords[0], coords[1]);
        if (!grid.has(cell)) grid.set(cell, []);
        grid.get(cell).push(intersection);
      }
      for (const way of intersection.connected_ways || []) {
        if (way.osm_way_id === undefined || way.osm_way_id === null) continue;
        const id = Number(way.osm_way_id);
        if (!wayIndex.has(id)) wayIndex.set(id, []);
        wayIndex.get(id).push(intersection);
      }
    }

    store.areaId = areaId;
    store.segments = segments;
    store.mapSegments = mapSegments;
    store.segmentsByKey = new Map(mapSegments.map((s) => [s.object_identity.nav_segment_key, s]));
    store.intersectionGrid = grid;
    store.intersectionWayIndex = wayIndex;
  }

  // ---------- 線上標註 / 已檢查載入 ----------
  async function fetchJsonlMap(rawPath, keyFn) {
    // 有 token 走 Contents API 帶認證（private repo 也能讀）；沒 token 走 raw（公開 repo 免認證）
    let res;
    if (settings.token) {
      res = await realFetch(
        `https://api.github.com/repos/${settings.repo}/contents/${rawPath}?ref=${settings.branch}&nocache=${Date.now()}`,
        { headers: { Authorization: `Bearer ${settings.token}`, Accept: "application/vnd.github.raw+json" } }
      );
    } else {
      res = await realFetch(`https://raw.githubusercontent.com/${settings.repo}/${settings.branch}/${rawPath}?nocache=${Date.now()}`);
    }
    const map = new Map();
    if (res.ok) {
      for (const line of (await res.text()).split("\n")) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        const key = keyFn(rec);
        if (key) map.set(key, rec);
      }
    } else if (res.status !== 404) {
      throw new Error(`HTTP ${res.status}`);
    }
    return map;
  }

  async function listQueueDir(dir) {
    const headers = { Accept: "application/vnd.github+json" };
    if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
    const url = `https://api.github.com/repos/${settings.repo}/contents/${dir}?ref=${settings.branch}&nocache=${Date.now()}`;
    const res = await realFetch(url, { headers });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = await res.json();
    return (Array.isArray(entries) ? entries : [])
      .filter((e) => e.type === "file" && e.name.endsWith(".json"))
      .sort((a, b) => (a.name < b.name ? -1 : 1)); // 檔名含時間戳，後者較新
  }

  async function ensureAnnotations(force = false) {
    if (!force && store.annotationsLoadedAt) return;
    store.annotationsError = null;

    try {
      store.merged = await fetchJsonlMap(CONFIG.mergedAnnotationsPath, storageKeyOf);
    } catch (error) {
      store.annotationsError = `線上標註載入失敗（${error.message}）；已標路段可能顯示不完整。`;
    }
    try {
      store.mergedReviews = await fetchJsonlMap(CONFIG.mergedReviewsPath, (r) => r.review_key);
    } catch (error) {
      store.annotationsError = (store.annotationsError || "") + ` 已檢查狀態載入失敗（${error.message}）。`;
    }

    try {
      store.pending = new Map();
      for (const file of await listQueueDir(CONFIG.annotationsDir)) {
        const storageKey = slugToKey(file.name.split("__")[0]);
        store.pending.set(storageKey, { name: file.name, download_url: file.download_url });
      }
    } catch (error) {
      store.annotationsError = (store.annotationsError || "") + ` 標註佇列讀取失敗（${error.message}）。`;
    }
    try {
      store.pendingReviews = new Map();
      for (const file of await listQueueDir(CONFIG.reviewsDir)) {
        // 檔名 {slug}__{ts}__{author}__{on|off}.json
        const parts = file.name.replace(/\.json$/, "").split("__");
        const reviewKey = slugToKey(parts[0]);
        const isOn = parts[3] !== "off";
        const [segKey, intKey] = reviewKey.split("@");
        store.pendingReviews.set(reviewKey, isOn ? {
          object_type: "intersection_review",
          review_key: reviewKey,
          nav_segment_key: segKey,
          nav_intersection_key: intKey,
          status: "checked",
          checked_by: parts[2] || "unknown",
          checked_at: parts[1] || "",
        } : null);
      }
    } catch (error) {
      store.annotationsError = (store.annotationsError || "") + ` 已檢查佇列讀取失敗（${error.message}）。`;
    }

    store.annotationsLoadedAt = new Date();
    warn("lp_web_annotations", store.annotationsError || "");
    setStatus(annotationStatusText());
  }

  function annotationStatusText() {
    const at = store.annotationsLoadedAt;
    const stamp = at ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : "-";
    const queued = [...store.pending.keys()].filter((k) => !store.merged.has(k)).length;
    return `線上標註 ${allLatestRecords().size} 筆（待合併 ${queued}）· 同步於 ${stamp} · 寫入 ${settings.repo}@${settings.branch}${settings.token ? "" : " · 尚未設定 token（只能瀏覽）"}`;
  }

  /** 合併版 + 佇列（已抓內容者）+ 本工作階段 → storage key → 最新紀錄 */
  function allLatestRecords() {
    const latest = new Map(store.merged);
    for (const [key, rec] of store.pendingFetched) latest.set(key, rec);
    for (const [key, rec] of store.session) latest.set(key, rec);
    return latest;
  }

  // ---------- 狀態徽章（server.py annotation_statuses 系列移植，上游 20d9e3c） ----------
  function annotationHasEffectiveContent(annotation) {
    const laneTags = (annotation ?? {}).lane_nav_tags ?? {};
    const rules = laneTags.taiwan_motorcycle_tags?.movement_rules ?? [];
    const profiles = laneTags.lane_detail_tags?.lane_profiles ?? [];
    return !!(rules.length || profiles.length);
  }
  function annotationDisplayStatus(annotation) {
    if (!annotation) return null;
    const isContext = !!annotation.object_identity?.nav_context_key;
    if (annotationHasEffectiveContent(annotation)) return isContext ? "annotated" : "legacy";
    return isContext ? "checked" : null;
  }
  function annotationDisplayRank(annotation) {
    return { annotated: 4, legacy: 3, checked: 2 }[annotationDisplayStatus(annotation)] ?? 1;
  }
  const SEGMENT_STATUS_ORDER = ["annotated", "empty", "legacy_v1"];

  /** server.py latest_annotations_by_segment 移植：路段 key → 顯示等級最高的代表紀錄 */
  function annotationsBySegment() {
    const grouped = new Map();
    for (const rec of allLatestRecords().values()) {
      const segKey = segmentKeyOf(rec);
      if (!segKey) continue;
      const current = grouped.get(segKey);
      if (!current || annotationDisplayRank(rec) > annotationDisplayRank(current)) grouped.set(segKey, rec);
    }
    return grouped;
  }

  /** 合併版 → 佇列 → 本工作階段疊加後的「已檢查」全集 */
  function combinedReviews() {
    const rows = new Map(store.mergedReviews);
    for (const [key, row] of store.pendingReviews) { if (row) rows.set(key, row); else rows.delete(key); }
    for (const [key, row] of store.sessionReviews) { if (row) rows.set(key, row); else rows.delete(key); }
    return rows;
  }

  /** server.py annotation_statuses_by_segment 移植 + 佇列中未抓內容的檔案以檔名近似 */
  function annotationStatusesBySegment() {
    const statuses = new Map();
    const add = (segKey, status) => {
      if (!segKey) return;
      if (!statuses.has(segKey)) statuses.set(segKey, new Set());
      statuses.get(segKey).add(status);
    };
    const latest = allLatestRecords();
    for (const rec of latest.values()) {
      const segKey = segmentKeyOf(rec);
      if (!rec.object_identity?.nav_context_key) add(segKey, "legacy_v1");
      else if (annotationHasEffectiveContent(rec)) add(segKey, "annotated");
      else add(segKey, "empty");
    }
    // 佇列裡還沒抓內容的：檔名可判 context/legacy，內容效力未知 → 先視為已標（防重複標註）
    for (const storageKey of store.pending.keys()) {
      if (latest.has(storageKey)) continue;
      const segKey = segmentKeyOfStorageKey(storageKey);
      add(segKey, storageKey === segKey ? "legacy_v1" : "annotated");
    }
    for (const review of combinedReviews().values()) {
      if (review.status === "checked") add(review.nav_segment_key, "annotated");
    }
    const out = new Map();
    for (const [key, values] of statuses) {
      out.set(key, SEGMENT_STATUS_ORDER.filter((s) => values.has(s)));
    }
    return out;
  }

  function annotationsGroupedBySegment() {
    const grouped = new Map();
    for (const record of allLatestRecords().values()) {
      const key = segmentKeyOf(record);
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(record);
    }
    return grouped;
  }

  function triageTagsForSegment({ segment, annotations, annotationStatuses, favouriteSegmentKeys }) {
    const tags = new Set(annotationStatuses || []);
    const laneTags = segment.lane_nav_tags || {};
    if ((laneTags.manual_targets || []).length || (laneTags.candidate_priority ?? 0) >= 70) tags.add("priority");
    if (favouriteSegmentKeys.has(segment.object_identity.nav_segment_key)) tags.add("favourite");
    for (const annotation of annotations || []) {
      const reviewNote = annotation.lane_nav_tags?.osm_review_tags?.osm_review_note;
      if (String(annotation.annotation_metadata?.note || "").trim() || String(reviewNote || "").trim()) tags.add("has_notes");
      const rules = annotation.lane_nav_tags?.taiwan_motorcycle_tags?.movement_rules || [];
      const offsetRelations = annotation.lane_nav_tags?.offset_relations || [];
      if (rules.some((rule) => rule.target_relation?.kind === "offset_intersection") || offsetRelations.some((relation) => relation?.kind === "offset_intersection")) tags.add("offset_intersection");
    }
    return tags;
  }

  function matchesTriageTags(tags, requestedTags, mode) {
    if (!requestedTags.size) return true;
    return mode === "or"
      ? [...requestedTags].some((tag) => tags.has(tag))
      : [...requestedTags].every((tag) => tags.has(tag));
  }

  async function fetchPendingContent(storageKey) {
    if (store.pendingFetched.has(storageKey) || !store.pending.has(storageKey)) return;
    const info = store.pending.get(storageKey);
    if (!info.download_url) return; // 本工作階段剛寫的，session 已有
    try {
      const res = await realFetch(info.download_url);
      if (res.ok) store.pendingFetched.set(storageKey, await res.json());
    } catch { /* 抓不到就退回合併版 */ }
  }

  /** /api/segment 用：該路段的 legacy + context 標註（含佇列與本階段） */
  async function annotationsForSegment(navSegmentKey) {
    for (const storageKey of store.pending.keys()) {
      if (segmentKeyOfStorageKey(storageKey) === navSegmentKey) await fetchPendingContent(storageKey);
    }
    const rows = [...allLatestRecords().values()].filter((r) => segmentKeyOf(r) === navSegmentKey);
    return {
      legacy_annotation: rows.find((r) => !r.object_identity?.nav_context_key) ?? null,
      context_annotations: rows.filter((r) => !!r.object_identity?.nav_context_key),
    };
  }

  /** 已檢查狀態：疊加後過濾到單一路段 */
  function reviewsForSegment(navSegmentKey) {
    return [...combinedReviews().values()].filter((r) => r.nav_segment_key === navSegmentKey);
  }

  // ---------- server.py 查詢邏輯移植 ----------
  function summarizeSegment(segment, annotation, annotationStatuses, triageTags = new Set()) {
    const identity = segment.object_identity;
    const tags = segment.lane_nav_tags || {};
    const osm = segment.osm_selected_tags || {};
    const geometry = segment.geometry || {};
    const coords = geometry.coordinates || [];
    const first = coords.length ? coords[0] : null;
    const annotationStatus = annotationDisplayStatus(annotation);
    if (annotationStatuses == null) {
      annotationStatuses = { annotated: ["annotated"], legacy: ["legacy_v1"], checked: ["empty"] }[annotationStatus] ?? [];
    }
    return {
      nav_segment_key: identity.nav_segment_key,
      osm_id: identity.source_osm.osm_id,
      road_name: tags.road_name || osm.name || "未命名道路",
      road_class: tags.road_class || osm.highway,
      oneway: tags.oneway,
      lane_count_total: tags.lane_count_total,
      lane_count_forward: tags.lane_count_forward,
      lane_count_backward: tags.lane_count_backward,
      candidate_priority: tags.candidate_priority ?? 0,
      manual_targets: tags.manual_targets || [],
      annotated: annotationStatuses.includes("annotated"),
      annotation_status: annotationStatus,
      annotation_statuses: annotationStatuses,
      triage_tags: [...triageTags],
      verified: annotation ? annotation.annotation_metadata?.manual_verified : "no",
      first_coordinate: Array.isArray(first) && first.length >= 2 ? { lng: first[0], lat: first[1] } : null,
      center_coordinate: geometryCenter(geometry),
      geometry,
    };
  }

  function segmentMatchesQuery(segment, q) {
    if (!q) return true;
    const identity = segment.object_identity || {};
    const tags = segment.lane_nav_tags || {};
    const roadName = tags.road_name || segment.osm_selected_tags?.name || "未命名道路";
    const haystack = [identity.nav_segment_key, roadName, tags.road_class]
      .map((v) => String(v ?? ""))
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  }

  function filterSegments(params) {
    const q = (params.get("q") || "").trim().toLowerCase();
    const target = (params.get("target") || "").trim();
    const status = (params.get("status") || "").trim();
    const candidateScope = (params.get("candidate_scope") ?? "suggested").trim();
    const offset = parseInt(params.get("offset") || "0", 10) || 0;
    const limit = parseInt(params.get("limit") || "80", 10) || 80;
    const bySegment = annotationsBySegment();
    const statusesBySegment = annotationStatusesBySegment();
    const recordsBySegment = annotationsGroupedBySegment();
    const requestedTags = new Set(String(params.get("triage_tags") || "").split(",").filter(Boolean));
    const triageMode = params.get("triage_mode") === "or" ? "or" : "and";
    const favouriteSegmentKeys = new Set(String(params.get("favourite_segment_keys") || "").split(",").filter(Boolean));

    const allScope = candidateScope === "" && !target;
    const rows = [];
    let total = 0;
    for (const segment of store.segments) {
      const tags = segment.lane_nav_tags || {};
      const manualTargets = tags.manual_targets || [];
      const priority = tags.candidate_priority ?? 0;
      const isSuggested = manualTargets.length > 0 || priority >= 70;

      if (candidateScope === "suggested" && !isSuggested) continue;
      if (candidateScope === "normal" && isSuggested) continue;
      if (target && !manualTargets.includes(target)) continue;
      if (!segmentMatchesQuery(segment, q)) continue;

      const key = segment.object_identity.nav_segment_key;
      const annotationStatuses = statusesBySegment.get(key) ?? [];
      const triageTags = triageTagsForSegment({
        segment,
        annotations: recordsBySegment.get(key) ?? [],
        annotationStatuses,
        favouriteSegmentKeys,
      });
      const isAnnotated = annotationStatuses.includes("annotated");
      if (status === "annotated" && !isAnnotated) continue;
      if (status === "unannotated" && isAnnotated) continue;
      if (!matchesTriageTags(triageTags, requestedTags, triageMode)) continue;

      if (allScope) {
        rows.push(summarizeSegment(segment, bySegment.get(key) ?? null, annotationStatuses, triageTags));
      } else if (total >= offset && rows.length < limit) {
        rows.push(summarizeSegment(segment, bySegment.get(key) ?? null, annotationStatuses, triageTags));
      }
      total += 1;
    }
    let out = rows;
    if (allScope) {
      out = rows.sort((a, b) => {
        const aSuggested = (a.manual_targets || []).length > 0 || (a.candidate_priority ?? 0) >= 70;
        const bSuggested = (b.manual_targets || []).length > 0 || (b.candidate_priority ?? 0) >= 70;
        if (aSuggested !== bSuggested) return aSuggested ? -1 : 1;
        if ((b.candidate_priority ?? 0) !== (a.candidate_priority ?? 0)) return (b.candidate_priority ?? 0) - (a.candidate_priority ?? 0);
        return a.nav_segment_key < b.nav_segment_key ? -1 : 1;
      }).slice(offset, offset + limit);
    }
    return { total, offset, limit, items: out };
  }

  function summarizeIntersection(intersection) {
    const identity = intersection.object_identity;
    const tags = intersection.lane_nav_tags || {};
    return {
      nav_intersection_key: identity.nav_intersection_key,
      osm_id: identity.source_osm.osm_id,
      intersection_name: tags.intersection_name || "(unnamed intersection)",
      connected_way_count: tags.connected_way_count,
      connected_ways: intersection.connected_ways || [],
      road_classes: tags.road_classes || [],
      candidate_priority: tags.candidate_priority ?? 0,
      manual_targets: tags.manual_targets || [],
      coordinate: geometryCenter(intersection.geometry || {}),
      map_links: intersection.map_links || {},
    };
  }

  function gridIntersectionsForSegment(coords, maxDistanceKm) {
    if (!coords.length || !store.intersectionGrid.size) return [];
    const meanLat = coords.reduce((s, p) => s + p[1], 0) / coords.length;
    const latPad = maxDistanceKm / 111.32;
    const lngScale = Math.max(Math.cos((meanLat * Math.PI) / 180), 0.2);
    const lngPad = maxDistanceKm / (111.32 * lngScale);
    const minLng = Math.min(...coords.map((p) => p[0])) - lngPad;
    const maxLng = Math.max(...coords.map((p) => p[0])) + lngPad;
    const minLat = Math.min(...coords.map((p) => p[1])) - latPad;
    const maxLat = Math.max(...coords.map((p) => p[1])) + latPad;
    const [minCx, minCy] = [Math.floor(minLng / GRID_SIZE), Math.floor(minLat / GRID_SIZE)];
    const [maxCx, maxCy] = [Math.floor(maxLng / GRID_SIZE), Math.floor(maxLat / GRID_SIZE)];
    const rows = [];
    const seen = new Set();
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (const intersection of store.intersectionGrid.get(`${cx},${cy}`) || []) {
          const key = intersection.object_identity?.nav_intersection_key;
          if (!seen.has(key)) { seen.add(key); rows.push(intersection); }
        }
      }
    }
    return rows;
  }

  function nearbyIntersections(segment, limit = 100, maxDistanceKm = 0.06) {
    const coords = segment.geometry?.coordinates || [];
    if (coords.length < 2) return [];
    const osmWayId = segment.object_identity?.source_osm?.osm_id;
    const indexed = osmWayId !== undefined && osmWayId !== null ? store.intersectionWayIndex.get(Number(osmWayId)) || [] : [];
    const candidates = indexed.length ? indexed : gridIntersectionsForSegment(coords, maxDistanceKm);
    const rows = [];
    for (const intersection of candidates) {
      const center = geometryCenter(intersection.geometry || {});
      if (!center) continue;
      let best = Infinity;
      for (let i = 0; i < coords.length - 1; i++) {
        best = Math.min(best, pointToSegmentDistanceKm(center, coords[i], coords[i + 1]));
      }
      if (best <= maxDistanceKm) {
        const row = summarizeIntersection(intersection);
        row.distance_m = Math.round(best * 1000);
        rows.push(row);
      }
    }
    rows.sort((a, b) => a.distance_m - b.distance_m || b.candidate_priority - a.candidate_priority);
    return rows.slice(0, limit);
  }

  // ---------- GitHub 寫入 ----------
  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  async function githubPutFile(path, contentText, message) {
    if (!settings.token) {
      throw new Error("尚未設定 GitHub Token：請在頁面上方「線上儲存設定」貼上個人 token（Contents 讀寫權限）後再儲存。");
    }
    const url = `https://api.github.com/repos/${settings.repo}/contents/${path}`;
    const res = await realFetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${settings.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, content: utf8ToBase64(contentText), branch: settings.branch }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail = (await res.json()).message || detail; } catch { /* 保留 HTTP 狀態 */ }
      if (res.status === 401) throw new Error(`GitHub 驗證失敗（${detail}）：請確認 token 是否有效。`);
      if (res.status === 403 || res.status === 404) {
        throw new Error(`GitHub 拒絕寫入（${detail}）：請確認 token 有 ${settings.repo} 的 Contents 讀寫權限，且 branch「${settings.branch}」存在。`);
      }
      throw new Error(`GitHub 寫入失敗（${detail}）`);
    }
  }

  async function saveAnnotationToGitHub(payload) {
    const identity = payload?.object_identity || {};
    if (identity.nav_context_key) validateContextIdentity(identity);
    const storageKey = storageKeyOf(payload);
    if (!storageKey) { const err = new Error("missing annotation storage key"); err.httpStatus = 400; throw err; }
    const author = safeAuthor(payload.annotation_metadata?.verified_by);
    const fileName = `${keyToSlug(storageKey)}__${timeStamp()}__${author}.json`;
    await githubPutFile(
      `${CONFIG.annotationsDir}/${fileName}`,
      JSON.stringify(payload, null, 2) + "\n",
      `[標註] ${storageKey}（${author}）`
    );
    store.session.set(storageKey, payload);
    store.pending.set(storageKey, { name: fileName, download_url: null });
    // 與 server.py upsert 相同的副作用：intersection_approach 標註自動設「已檢查」
    //（正式檔由 merge 工具從標註內容推導；這裡先更新畫面狀態）
    if (identity.context_scope === "intersection_approach") {
      const reviewKey = `${identity.nav_segment_key}@${identity.applies_to_intersection_key}`;
      store.sessionReviews.set(reviewKey, {
        object_type: "intersection_review",
        review_key: reviewKey,
        nav_segment_key: identity.nav_segment_key,
        nav_intersection_key: identity.applies_to_intersection_key,
        status: "checked",
        checked_by: payload.annotation_metadata?.verified_by || "unknown",
        checked_at: payload.annotation_metadata?.verified_at || "",
      });
    }
    setStatus(annotationStatusText());
    return { ok: true, annotation_file: `${settings.repo}@${settings.branch}:${CONFIG.annotationsDir}/${fileName}` };
  }

  async function saveReviewToGitHub(payload) {
    const segKey = payload?.nav_segment_key;
    const intKey = payload?.nav_intersection_key;
    if (!segKey || !intKey) { const err = new Error("missing nav_segment_key or nav_intersection_key"); err.httpStatus = 400; throw err; }
    const reviewKey = `${segKey}@${intKey}`;
    const checked = !!payload.checked;
    const author = safeAuthor(payload.checked_by);
    const stamp = timeStamp();
    const fileName = `${keyToSlug(reviewKey)}__${stamp}__${author}__${checked ? "on" : "off"}.json`;
    const row = {
      object_type: "intersection_review",
      review_key: reviewKey,
      nav_segment_key: segKey,
      nav_intersection_key: intKey,
      status: "checked",
      checked_by: payload.checked_by || "unknown",
      checked_at: new Date().toISOString().slice(0, 19),
      checked: checked, // 事件語意：on/off（合併工具用）
    };
    await githubPutFile(
      `${CONFIG.reviewsDir}/${fileName}`,
      JSON.stringify(row, null, 2) + "\n",
      `[已檢查${checked ? "" : "取消"}] ${reviewKey}（${author}）`
    );
    store.sessionReviews.set(reviewKey, checked ? row : null);
    if (checked) return { ok: true, checked: true, review: row };
    return { ok: true, checked: false, review_key: reviewKey };
  }

  // ---------- 下載合併後 JSONL（給 nav_simulator 匯入用） ----------
  async function downloadMergedJsonl() {
    setStatus("整理標註中...");
    await ensureAnnotations(true);
    for (const storageKey of store.pending.keys()) await fetchPendingContent(storageKey);
    const latest = allLatestRecords();
    const keys = [...latest.keys()].sort();
    const jsonl = keys.map((k) => JSON.stringify(latest.get(k))).join("\n") + (keys.length ? "\n" : "");
    const blob = new Blob([jsonl], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "annotations.jsonl";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(annotationStatusText());
  }

  // ---------- /api/* 路由 ----------
  async function handleApi(rawUrl, options) {
    const url = new URL(rawUrl, window.location.origin);
    const params = url.searchParams;

    if (options && options.method === "POST") {
      const body = JSON.parse(options.body);
      if (url.pathname === "/api/annotations") return saveAnnotationToGitHub(body);
      if (url.pathname === "/api/intersection-reviews") return saveReviewToGitHub(body);
      const err = new Error("not found"); err.httpStatus = 404; throw err;
    }

    switch (url.pathname) {
      case "/api/areas": {
        const manifest = await ensureManifest();
        await ensureAnnotations().catch(() => {});
        const districts = manifest
          ? (manifest.regions || []).map((r) => ({
              area_id: r.area_id, name: r.name, name_en: r.name_en, admin_level: r.admin_level, bbox: r.bbox,
            })).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"))
          : [];
        const cities = Object.entries(CITY_BBOXES).map(([id, v]) => ({
          area_id: `bbox/${id}`, name: v.name, name_en: id, admin_level: "bbox",
          bbox: { min_lng: v.min_lng, min_lat: v.min_lat, max_lng: v.max_lng, max_lat: v.max_lat },
        })).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
        return { cities, districts, admin_areas_available: !!manifest, admin_areas_path: "(web)", region_shards_available: !!manifest };
      }
      case "/api/meta": {
        const manifest = await ensureManifest();
        await ensureAnnotations().catch(() => {});
        const regions = manifest?.regions || [];
        return {
          dataset_version: manifest?.dataset_version,
          region_count: regions.length,
          segment_count: regions.reduce((s, r) => s + (r.files?.["segments.jsonl"]?.count ?? 0), 0),
          intersection_count: regions.reduce((s, r) => s + (r.files?.["intersections.jsonl"]?.count ?? 0), 0),
          annotation_count: allLatestRecords().size,
          missing_required_files: manifest ? [] : ["region_manifest"],
        };
      }
      case "/api/segments": {
        const areaId = (params.get("district_area_id") || "").trim();
        if (!areaId) return { total: 0, offset: 0, limit: 0, items: [], requires_district: true };
        await ensureDistrict(areaId);
        await ensureAnnotations().catch(() => {});
        return filterSegments(params);
      }
      case "/api/map-segments": {
        const areaId = (params.get("district_area_id") || "").trim();
        await ensureDistrict(areaId);
        await ensureAnnotations().catch(() => {});
        const bySegment = annotationsBySegment();
        const statusesBySegment = annotationStatusesBySegment();
        const items = store.mapSegments.map((segment) => {
          const key = segment.object_identity.nav_segment_key;
          return summarizeSegment(segment, bySegment.get(key) ?? null, statusesBySegment.get(key) ?? []);
        });
        return { total: items.length, items };
      }
      case "/api/segment": {
        const key = params.get("key") || "";
        const areaId = (params.get("district_area_id") || "").trim();
        await ensureDistrict(areaId);
        const segment = store.segmentsByKey.get(key);
        if (!segment) { const err = new Error("segment not found"); err.httpStatus = 404; throw err; }
        await ensureAnnotations().catch(() => {});
        const records = await annotationsForSegment(key);
        return {
          segment,
          annotation: records.legacy_annotation,
          legacy_annotation: records.legacy_annotation,
          context_annotations: records.context_annotations,
          nearby_intersections: nearbyIntersections(segment),
        };
      }
      case "/api/intersection-reviews": {
        await ensureAnnotations().catch(() => {});
        const segKey = params.get("nav_segment_key") || "";
        return { items: reviewsForSegment(segKey) };
      }
      default: {
        const err = new Error(`web 版尚未支援 ${url.pathname}`);
        err.httpStatus = 404;
        throw err;
      }
    }
  }

  // ---------- fetch 攔截 ----------
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    const urlText = typeof input === "string" ? input : input?.url || "";
    if (urlText.startsWith("/api/")) {
      try {
        const data = await handleApi(urlText, options);
        return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: error.httpStatus || 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
    }
    return realFetch(input, options);
  };

  // ---------- 設定列 UI ----------
  function injectSettingsBar() {
    const bar = document.createElement("div");
    bar.className = "lp-web-bar";
    bar.innerHTML = `
      <details class="lp-web-settings">
        <summary>線上儲存設定</summary>
        <div class="lp-web-fields">
          <label>Repo <input id="lpRepo" placeholder="owner/repo" /></label>
          <label>Branch <input id="lpBranch" placeholder="main" /></label>
          <label>GitHub Token <input id="lpToken" type="password" placeholder="fine-grained PAT（Contents 讀寫）" /></label>
          <button type="button" id="lpSaveSettings">儲存設定</button>
        </div>
        <p class="lp-web-hint">Token 只存在自己這台瀏覽器的 localStorage，不會出現在網頁原始碼。申請：GitHub → Settings → Developer settings → Fine-grained tokens，Repository access 只勾本 repo，權限 Contents: Read and write。</p>
      </details>
      <div class="lp-web-actions">
        <button type="button" id="lpRefreshAnnotations">重新載入線上標註</button>
        <button type="button" id="lpDownloadJsonl">下載標註 JSONL</button>
        <span id="lpWebStatus" class="lp-web-status"></span>
      </div>
    `;
    const header = document.querySelector("header.topbar");
    header.insertAdjacentElement("afterend", bar);

    document.getElementById("lpRepo").value = settings.repo;
    document.getElementById("lpBranch").value = settings.branch;
    document.getElementById("lpToken").value = settings.token;
    document.getElementById("lpSaveSettings").addEventListener("click", async () => {
      localStorage.setItem("lanePilotRepo", document.getElementById("lpRepo").value.trim() || CONFIG.repo);
      localStorage.setItem("lanePilotBranch", document.getElementById("lpBranch").value.trim() || CONFIG.branch);
      localStorage.setItem("lanePilotToken", document.getElementById("lpToken").value.trim());
      await ensureAnnotations(true);
    });
    document.getElementById("lpRefreshAnnotations").addEventListener("click", async () => {
      setStatus("重新同步中...");
      await ensureAnnotations(true);
      if (typeof window.reloadAll === "function") window.reloadAll();
      if (typeof window.loadDistrictMap === "function") window.loadDistrictMap();
    });
    document.getElementById("lpDownloadJsonl").addEventListener("click", () => {
      downloadMergedJsonl().catch((error) => setStatus(`下載失敗：${error.message}`));
    });
    setStatus(annotationStatusText());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectSettingsBar);
  } else {
    injectSettingsBar();
  }
})();
