import type { PluginInfo } from "./pluginHost";

/** 남의 플러그인이 오르는 목록 저장소 — 만드는 법·올리는 법(PR)은 저 README 가 정본이다. 앱에는 링크만 둔다
 *  (같은 안내를 앱에도 적으면 두 곳이 되고, 절차가 바뀔 때마다 앱을 다시 배포해야 한다. 사용자 결정 2026-09-08).
 *  백엔드의 기본 목록 주소(`server.py` `PLUGIN_REGISTRY`)와 같은 저장소다. */
export const PLUGIN_LIST_REPO = "https://github.com/mrm987/peropix-plugins";
/** 공식 플러그인이 사는 자리 — 앱 저장소의 `plugins-official/<id>` (README 를 보러 가는 링크) */
const OFFICIAL_TREE = "https://github.com/mrm987/PeroPix3/tree/master/plugins-official/";

/** 플러그인의 GitHub(또는 홈) 주소 — README 를 보러 가는 링크 (사용자 지시 2026-09-08).
 *  매니페스트의 `homepage` 가 있으면 그것, 없으면 출처에서 만든다: 번들 → 앱 저장소의 폴더, 목록(repo) → 그 저장소, zip → 그 주소.
 *  폴더에 직접 넣은 것(출처 없음)은 링크가 없다. */
export function linkOf(x: { homepage?: string; source?: string; repo?: string; zip?: string; id: string; origin?: PluginInfo["origin"] }): string {
  if (x.homepage) return x.homepage;
  const src = x.source ?? x.origin?.source;
  const repo = x.repo ?? x.origin?.repo;
  const zip = x.zip ?? x.origin?.zip;
  if (src === "bundled") return OFFICIAL_TREE + x.id;
  if (src === "repo" && repo) return `https://github.com/${repo}`;
  if (src === "zip" && zip) return zip;
  return "";
}
