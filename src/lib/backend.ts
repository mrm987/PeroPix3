/** 백엔드 주소는 Rust 가 알려준다 — 프론트에 포트를 하드코딩하지 않는다.
 *  브라우저(vite dev)에서 열었을 땐 Tauri 가 없으므로 기본값으로 떨어진다. */

const FALLBACK = "http://127.0.0.1:8770";

let cached: string | null = null;

export async function backendUrl(): Promise<string> {
  if (cached) return cached;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    cached = await invoke<string>("backend_url");
  } catch {
    cached = FALLBACK;
  }
  return cached!;
}

/** 휴지통 한 줄 — **원래 자리**와 **휴지통에서의 자리**. 지울 때 받아 두었다가
 *  「되돌리기」에 그대로 되돌려준다 (`backend/trash.py` 머리 주석).
 *  ★모양을 화면마다 다르게 만들지 말 것 — 되살리는 창구가 여럿이라 어긋나면 조용히 실패한다. */
export type TrashEntry = { file: string; at: string };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await backendUrl();
  const res = await fetch(base + path, init);
  if (!res.ok) {
    /* ★★**서버가 말한 까닭을 싣는다** (사용자 실측 2026-09-02: 토큰을 넣었더니 「400 Bad Request」만 떴다).
       백엔드는 거절할 때 `detail` 에 무엇이 틀렸는지 적어 보내는데(공백·`pst-` 아님·NAI 401 …),
       상태 줄만 던지면 그 답이 화면에 닿지 않는다. 상태는 앞에 남긴다 — 409 처럼 번호로 가르는 곳이 있다. */
    let why = "";
    try {
      const d = (await res.json()) as { detail?: unknown };
      if (typeof d.detail === "string") why = d.detail;
    } catch {
      /* 본문이 JSON 이 아니면 상태 줄만 */
    }
    throw new Error(`${res.status} ${res.statusText}${why ? `: ${why}` : ""}`);
  }
  return (await res.json()) as T;
}
