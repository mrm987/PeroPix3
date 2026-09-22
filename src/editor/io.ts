/** 이미지 편집 — 그림을 **들여오고 내보내는** 창구. 세 갈래(`Dropped`: 아웃풋 루트 상대 `rel` · 절대 `path` · 바이트 `data`)를
 *  캔버스로 만들고, 합성 결과를 서버에 저장한다 (`/api/edit/save`).
 *  ★서버는 받은 바이트를 적을 뿐이다 — 메타데이터를 남기지 않는 것도 그쪽(`meta.strip`)이 한다. */
import { api, backendUrl } from "../lib/backend";
import { fileMgrImg } from "../lib/imgUrl";
import type { Dropped } from "../lib/dropImages";
import { canvasFrom } from "./pixels";

/** 바이트를 받는다 — `rel` 은 파일 관리의 그림 창구, `path` 는 떨군 파일 읽기, `data` 는 그대로 */
async function blobOf(item: Dropped, base: string): Promise<Blob> {
  if (item.data) {
    const r = await fetch(`data:image/png;base64,${item.data.split(",").pop()}`);
    return r.blob();
  }
  if (item.rel) {
    /* ★쿼리를 하나 붙인다 — 같은 주소를 `<img>` 가 no-cors 로 캐시해 두면 뒤의 `fetch` 가 CORS 로 막힌다
       (`panels/ImageActions` 의 그 자리와 같은 이유) */
    const r = await fetch(fileMgrImg(base, item.rel) + "?edit=1");
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.blob();
  }
  if (item.path) {
    const r = await api<{ name: string; data?: string }>("/api/tools/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: item.name, path: item.path }),
    });
    if (!r.data) throw new Error(item.name);
    const b = await fetch(`data:image/png;base64,${r.data.split(",").pop()}`);
    return b.blob();
  }
  throw new Error(item.name);
}

/** 그림 하나를 캔버스로. 이름은 파일 이름(확장자 포함) */
export async function loadItem(item: Dropped): Promise<{ cv: HTMLCanvasElement; name: string }> {
  const base = await backendUrl();
  const blob = await blobOf(item, base);
  const bmp = await createImageBitmap(blob);
  try {
    return { cv: canvasFrom(bmp), name: item.name };
  } finally {
    bmp.close();
  }
}

export type SaveReq = {
  image: string;
  name: string;
  fmt: "png" | "webp";
  mode: "overwrite" | "sub" | "folder";
  dest?: string;
  rel?: string;
  path?: string;
};

/** 합성 결과를 적는다. 돌려주는 `file` 은 루트 안이면 아웃풋 루트 기준 상대 경로, 밖이면 절대 경로 */
export function saveImage(req: SaveReq): Promise<{ file: string; name: string }> {
  return api<{ file: string; name: string }>("/api/edit/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}
