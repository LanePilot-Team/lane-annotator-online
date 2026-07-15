// GitHub Pages 版預設設定。頁面上的「線上儲存設定」可覆寫（存 localStorage）。
// 佈署流程：online branch 測試時 branch 填 "online"；merge 回 main 後改成 "main"。
window.LANEPILOT_WEB_CONFIG = {
  repo: "LanePilot-Team/lane-annotator-online",
  branch: "main",
  // 標註佇列目錄（repo 根目錄）：每筆標註一個 json 檔，GitHub Action 會自動合併
  annotationsDir: "annotations",
  // 合併後的正式標註檔（team 契約：以此為準）
  mergedAnnotationsPath: "exports/annotations.jsonl",
  mergedReviewsPath: "exports/intersection_reviews.jsonl",
  // 行政區 shard 靜態資料（相對 docs/）
  dataBase: "./data",
};
