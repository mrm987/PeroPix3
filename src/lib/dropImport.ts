import { api } from "./backend.ts";
import type { Dropped } from "./dropImages";
import { NAI_VIBE_EXT, isNaiVibeFile, parseNaiVibeFile, type NaiVibeImport } from "./naiVibeFile.ts";
import type { ImageMeta } from "../store/gallery";

/** 밖에서 떨군 파일 하나를 **무엇인지 판정해** 읽어 온다 (v2 「드롭 확인 모달」의 앞단).
 *
 *  ★★**읽는 창구는 하나다** — `POST /api/tools/meta`. v2 이식 계획이 못 박은 자리다
 *    (`docs/v2-feature-catalog.md`: *"드래그드롭 → 설정 가져오기, EXIF 리더, Vibe 파일 인식이
 *    전부 이 하나를 쓴다 — 창구 하나"*). 판정 규칙을 두 벌 두면 EXIF 리더에서는 NAI 로 읽히는
 *    그림이 드롭에서는 안 읽히는 상태가 조용히 생긴다.
 *  ★거기에 `full` 만 켠다. 앱(Tauri)에는 **경로만** 와서 화면에 원본 바이트가 없는데,
 *    떨군 그림을 베이스 이미지·바이브로 넣으려면 그 바이트가 있어야 한다
 *    (`preview` 는 320px JPEG 이라 못 쓴다).
 *  ★`.naiv4vibe` 는 **그림이 아니라 JSON** 이라 이 경로로 못 간다 — 글로 읽어야 한다.
 */

/** 서버가 돌려주는 것 — 내부 메타데이터에 드롭이 쓰는 넷을 얹은 모양 (`backend/tools.read_meta`) */
export type DropMeta = ImageMeta & {
  /** 형식 배지 — `nai` · `peropix` · `comfyui` · `vibe` · `custom`. 빈 문자열이면 모르는 것 */
  kind?: string;
  /** 줄인 미리보기 (data URL) */
  preview?: string;
  /** 원본 바이트 (base64, 접두어 없음) — `full` 을 켰을 때만 온다 */
  data?: string;
  bytes?: number;
  /** 바이브 캐시 PNG 일 때 그 tEXt 에 든 것. `data` 가 **구워 둔 인코딩**이다 */
  vibe?: { model?: string; strength?: string; info_extracted?: string; data?: string };
};

export type DropRead =
  | { kind: "vibefile"; name: string; vibe: NaiVibeImport }
  | { kind: "image"; name: string; meta: DropMeta };

/** 형식 배지에 쓸 이름 (`kind`) — ★i18n 키를 문자열로 이어 만들지 않는다 (회귀 테스트가 잡는다).
 *  ★EXIF 리더와 드롭 가져오기가 **같은 이 표**를 쓴다. */
export const KIND_LABEL: Record<string, string> = {
  nai: "NAI",
  peropix: "PeroPix",
  comfyui: "ComfyUI",
  vibe: "Vibe Cache",
  custom: "Custom",
};

/** 받는 확장자 — 그림 + NAI 바이브 파일 */
export const DROP_ACCEPT = new RegExp(`\\.(png|jpe?g|webp|${NAI_VIBE_EXT.slice(1)})$`, "i");

/** data URL(또는 맨 base64)을 글로 되돌린다.
 *  ★브라우저(개발·QA)에서만 쓴다 — 거기서는 파일이 `FileReader.readAsDataURL` 로 실려 온다.
 *    `atob` 는 **바이트**를 주므로 UTF-8 로 다시 풀어야 한글 이름이 안 깨진다. */
export function textFromDataUrl(url: string): string {
  const b64 = url.includes(",") ? url.slice(url.indexOf(",") + 1) : url;
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export async function readDrop(it: Dropped): Promise<DropRead> {
  if (isNaiVibeFile(it.name)) {
    // ★앱은 경로만 준다 — 서버가 글로 읽어 준다 (`/api/tools/read` 의 `TEXT_EXT`).
    //   브라우저는 이미 바이트를 들고 있으므로 다녀오지 않는다.
    const text = it.data
      ? textFromDataUrl(it.data)
      : ((
          await api<{ text?: string }>("/api/tools/read", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: it.name, path: it.path }),
          })
        ).text ?? "");
    return { kind: "vibefile", name: it.name, vibe: parseNaiVibeFile(text, it.name) };
  }
  const r = await api<{ meta: DropMeta }>("/api/tools/meta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...it, full: true }),
  });
  return { kind: "image", name: it.name, meta: r.meta };
}

/** 이 그림에 **바이브 캐시가 구워져 있는가** — 있으면 그대로 써서 Anlas 가 안 나간다.
 *  ★숫자는 tEXt 라 **문자열로 온다** (`backend/tools.read_meta`). 못 읽는 값은 안 쓴다 —
 *    0 으로 메우면 강도 0 짜리 바이브가 조용히 들어간다. */
export function vibeFromCachePng(m: DropMeta, name: string): NaiVibeImport | null {
  if (m.kind !== "vibe" || !m.data) return null;
  const num = (s?: string, fallback = 0) => {
    const v = Number(s);
    return Number.isFinite(v) && s?.trim() ? v : fallback;
  };
  const ie = num(m.vibe?.info_extracted, 1);
  const enc = m.vibe?.data;
  return {
    name,
    image: m.data,
    strength: num(m.vibe?.strength, 0.6),
    info_extracted: ie,
    ...(enc
      ? { encoded: enc, encoded_model: m.vibe?.model || undefined, encoded_info_extracted: ie }
      : null),
  };
}
