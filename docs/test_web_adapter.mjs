// web-adapter.js 的無瀏覽器煙霧測試（schema v2）：stub window/document/localStorage/fetch，
// 用 docs/data/ 的真實 shard 走過 app.js 會呼叫的每一條 /api/* 路徑。
// 執行：node docs/test_web_adapter.mjs（在 repo 根目錄）
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const docsDir = path.dirname(fileURLToPath(import.meta.url));

// ---- 瀏覽器環境 stub ----
const storage = new Map();
storage.set("lanePilotRepo", "LanePilot-Team/LanePilot");
storage.set("lanePilotBranch", "online");
storage.set("lanePilotToken", "existing-token");
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
};
globalThis.document = {
  readyState: "loading",
  addEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  createElement: () => ({ set innerHTML(_) {}, addEventListener() {} }),
};
const fileFetch = async (url) => {
  const text = String(url);
  if (text.startsWith("./")) {
    try {
      const body = await readFile(path.join(docsDir, text.slice(2).split("?")[0]), "utf-8");
      return new Response(body, { status: 200 });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }
  // GitHub（合併版 / 佇列）在離線測試回 404 → adapter 應視為「尚無線上標註」
  return new Response("offline test", { status: 404 });
};
globalThis.window = {
  fetch: fileFetch,
  location: { origin: "http://localhost" },
  LANEPILOT_WEB_CONFIG: { repo: "LanePilot-Team/LanePilot", branch: "online" },
};

// ---- 載入 adapter（IIFE，會把 window.fetch 換成 API 路由器） ----
await import("./web-adapter.js");
const assert = (cond, msg) => { if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); } console.log(`ok: ${msg}`); };
assert(storage.get("lanePilotRepo") === "LanePilot-Team/lane-annotator-online", "舊 repo 設定自動搬到 public repo");
assert(storage.get("lanePilotBranch") === "main", "舊 online branch 設定自動搬到 public main");
assert(storage.get("lanePilotToken") === "existing-token", "設定搬移保留既有 token");
storage.delete("lanePilotToken");
const api = async (url, options) => {
  const res = await window.fetch(url, options);
  return { status: res.status, data: JSON.parse(await res.text()) };
};

const NANZI = "area/4212599";

// /api/areas
{
  const { status, data } = await api("/api/areas");
  assert(status === 200 && data.region_shards_available, "/api/areas 可用");
  assert(data.districts.some((d) => d.area_id === NANZI), "行政區清單含楠梓");
  assert(data.cities.some((c) => c.name === "高雄市"), "縣市清單含高雄市");
}
// /api/meta
{
  const { data } = await api("/api/meta");
  assert(data.segment_count === 4488 && data.intersection_count === 3643, `meta 筆數正確（楠梓+橋頭 ${data.segment_count}/${data.intersection_count}）`);
  assert(data.missing_required_files.length === 0, "meta 無缺檔");
}
// /api/segments：未選行政區
{
  const { data } = await api("/api/segments?limit=120&offset=0");
  assert(data.requires_district === true, "未選行政區 → requires_district");
}
// /api/segments：楠梓高優先候選
let firstKey;
{
  const { data } = await api(`/api/segments?district_area_id=${encodeURIComponent(NANZI)}&limit=120&offset=0&candidate_scope=suggested&q=&target=&status=`);
  assert(data.total > 0 && data.items.length > 0, `高優先候選 ${data.total} 筆`);
  const priorities = data.items.map((i) => i.candidate_priority);
  assert(priorities.every((p, i) => i === 0 || priorities[i - 1] >= p), "依優先分數遞減");
  assert(data.items.every((i) => Array.isArray(i.annotation_statuses)), "清單項目含 annotation_statuses 徽章陣列（上游 20d9e3c）");
  firstKey = data.items[0].nav_segment_key;
}
{
  const { data } = await api(`/api/segments?district_area_id=${encodeURIComponent(NANZI)}&limit=120&offset=0&candidate_scope=&q=&target=&status=&triage_tags=favourite&triage_mode=and&favourite_segment_keys=${encodeURIComponent(firstKey)}`);
  assert(data.total === 1 && data.items[0].nav_segment_key === firstKey, "favourite triage filter runs before pagination");
  assert(data.items[0].triage_tags.includes("favourite"), "segment item exposes triage tags");
}
// /api/segments：搜尋大學南路
{
  const { data } = await api(`/api/segments?district_area_id=${encodeURIComponent(NANZI)}&limit=120&offset=0&candidate_scope=&q=${encodeURIComponent("大學南路")}&target=&status=`);
  assert(data.total > 0 && data.items.every((i) => i.road_name.includes("大學南路")), `搜尋大學南路 ${data.total} 筆`);
}
// /api/map-segments
{
  const { data } = await api(`/api/map-segments?district_area_id=${encodeURIComponent(NANZI)}`);
  assert(data.total === 3184, "map-segments 全區 3184 筆");
  assert(data.items[0].geometry?.type === "LineString", "map-segments 含幾何");
}
// /api/segment 細節（v2 回傳形狀）+ 附近路口含 connected_ways
{
  const { data } = await api(`/api/segment?key=${encodeURIComponent(firstKey)}&district_area_id=${encodeURIComponent(NANZI)}`);
  assert(data.segment.object_identity.nav_segment_key === firstKey, "segment 細節 key 相符");
  assert("legacy_annotation" in data && Array.isArray(data.context_annotations), "v2 回傳含 legacy_annotation + context_annotations");
  assert(Array.isArray(data.segment.node_refs) && data.segment.node_refs.length === data.segment.geometry.coordinates.length, "segment 含 node_refs 且長度==座標數");
  assert(Array.isArray(data.nearby_intersections), `附近路口 ${data.nearby_intersections.length} 筆`);
  for (const row of data.nearby_intersections) {
    assert(row.distance_m <= 60 && Array.isArray(row.connected_ways), "附近路口 ≤60m 且含 connected_ways");
    break;
  }
}
// /api/intersection-reviews GET
{
  const { status, data } = await api(`/api/intersection-reviews?nav_segment_key=${encodeURIComponent(firstKey)}`);
  assert(status === 200 && Array.isArray(data.items), "intersection-reviews GET 回 items 陣列");
}
// /api/segment 不存在
{
  const { status } = await api(`/api/segment?key=way/1&district_area_id=${encodeURIComponent(NANZI)}`);
  assert(status === 404, "不存在路段 → 404");
}
// 不支援的行政區
{
  const { status, data } = await api(`/api/segments?district_area_id=area/999999&limit=10&offset=0&candidate_scope=suggested`);
  assert(status === 409 && data.error.includes("尚未包含"), "未收錄行政區 → 409 + 說明");
}
// POST annotations：context identity 驗證（schema v2）
{
  const { status, data } = await api("/api/annotations", {
    method: "POST",
    body: JSON.stringify({
      object_identity: {
        object_type: "nav_context_annotation",
        schema_version: 2,
        nav_segment_key: firstKey,
        context_scope: "intersection_approach",
        approach_direction: "forward",
        applies_to_intersection_key: "node/123",
        nav_context_key: "way/錯誤key",
      },
    }),
  });
  assert(status === 500 && data.error.includes("nav_context_key must be"), "context key 驗證與 server 一致");
}
// POST annotations 未設 token
{
  const { status, data } = await api("/api/annotations", {
    method: "POST",
    body: JSON.stringify({ object_identity: { nav_segment_key: firstKey } }),
  });
  assert(status === 500 && data.error.includes("Token"), "未設 token 儲存標註 → 給設定指引");
}
// POST intersection-reviews 未設 token
{
  const { status, data } = await api("/api/intersection-reviews", {
    method: "POST",
    body: JSON.stringify({ nav_segment_key: firstKey, nav_intersection_key: "node/123", checked: true, checked_by: "test" }),
  });
  assert(status === 500 && data.error.includes("Token"), "未設 token 勾已檢查 → 給設定指引");
}
console.log("ALL PASS");
