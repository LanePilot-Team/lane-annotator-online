# docs/ — LanePilot 標註工具網頁版（GitHub Pages）

本機版（`04_osm_dataset_pipeline/annotation_tools/lane-annotator/`，需跑 `server.py`）的
線上版本：開瀏覽器就能標，標註即時存回 GitHub，全隊看得到彼此進度、不會重複標。

## 架構

```
瀏覽器（GitHub Pages 靜態頁）
 ├─ app.js / annotation_model.js   與本機版完全同一份，一行未改
 ├─ web-adapter.js                 攔截 /api/* fetch，在瀏覽器內重做 server.py 的查詢
 ├─ data/                          行政區 shard 靜態檔（目前：楠梓＋橋頭，含 node_refs）
 │
 ├─ 讀：raw.githubusercontent.com 的 annotations.jsonl / intersection_reviews.jsonl（合併版）
 │      + GitHub API 列 annotations/、intersection-reviews/ 佇列（已存、尚未合併）
 └─ 寫：GitHub Contents API →
        annotations/ 每筆標註一個 json 檔（schema v2，key = nav_context_key）
        intersection-reviews/ 每次勾/取消「已檢查」一個事件檔
                  ↓ push 觸發
            public GitHub Action（compact-annotations.yml）
                  ↓ 自動合併 + 刪佇列
            exports/annotations.jsonl
            exports/intersection_reviews.jsonl（public 正式檔）
                  ↓ private repo 每日同步一次
            LanePilot@online 的正式 JSONL
```

同一 storage key（context 或 legacy）以較新的標註為準；「已標」狀態 = 合併版 ∪ 佇列 ∪
本工作階段，所以別人剛存的標註（即使 Action 還沒跑完）也會顯示已標，避免重複標註。
儲存 intersection_approach 標註時，對應路口的「已檢查」也會自動設上（與 server.py 一致）。

## 開啟 GitHub Pages（repo 管理者做一次）

1. GitHub repo → Settings → Pages
2. Source 選 **Deploy from a branch**，Branch 選 `main`（或測試期用 `online`）、資料夾選 **/docs**
3. 存檔後幾分鐘，網址就是 `https://lanepilot-team.github.io/lane-annotator-online/`

## 每位標註者的一次性設定

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
2. Resource owner 選 `LanePilot-Team`；Repository access：**Only select repositories** → 勾選 `lane-annotator-online`（同一顆 token 若也要操作 private repo，可同時勾 `LanePilot`）
3. Permissions → Repository permissions → **Contents: Read and write**（其他都不用）
4. 打開標註網頁 → 上方「線上儲存設定」→ 貼上 token → 儲存設定

Token 只存在自己瀏覽器的 localStorage，不會進入網頁原始碼或 repo。從舊版升級時，網頁會把已儲存的 `LanePilot@online` 位置自動改為 `lane-annotator-online@main`，並保留 token；若該 token 尚未授權 public repo，需先在 GitHub 調整或重新建立。
每筆標註的 commit 都掛在自己的 GitHub 帳號下，誰標的一目了然。

沒設 token 也能瀏覽路段與現有標註，只是不能儲存。

## 下載標註（nav_simulator 匯入用）

- 頁面上方「下載標註 JSONL」：合併版 + 佇列中最新標註，整理成一份 `annotations.jsonl` 下載
- public 正式檔可直接從 `exports/annotations.jsonl` 讀取；private `LanePilot@online` 每日自動同步一份

## 新增開放標註的行政區

`docs/data/` 只放正在標的區（Pages 限整站 1 GB，全臺 shard 放不下也不需要）：

1. 把該區 `regions/area_xxx/` 資料夾複製到 `docs/data/regions/`
2. 把完整 `region_manifest.json` 裡該區的 region 條目，加進 `docs/data/region_manifest.json` 的 `regions` 陣列

## 跟上游 lane-annotator 同步

同學改了本機版的 `app.js` / `annotation_model.js` / `index.html` / `styles.css` 時：

- `app.js`、`annotation_model.js`：直接覆蓋（web-adapter 不動它們，永遠可直接覆蓋）
- `server.py` 加了新 API 端點時：要在 `web-adapter.js` 的 `handleApi` 補對應實作
- `index.html`：覆蓋後補回兩處——README 連結改成 GitHub 網址、`</body>` 前的
  `web-config.js` + `web-adapter.js` 兩行 script（要在 `app.js` 之前）
- `styles.css`：覆蓋後把檔尾「GitHub Pages 版設定列」區塊貼回去

## 測試

```
node docs/test_web_adapter.mjs        # 不用瀏覽器，走過全部 /api/* 路徑
python -m unittest scripts/test_compact_annotations.py -v
cd docs && python -m http.server 8899 # 手動整頁測試（讀取功能；寫入需 token）
```
