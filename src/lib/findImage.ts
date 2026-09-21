/** **그림 하나를 가리키는 말**을 바이트로 바꾼다 — 조수의 이미지 입력 도구가 쓰는 하나의 창구
 *  (사용자 지시 2026-09-21: *"그림 경로는 그냥 로컬 폴더 아무데나(설치 폴더 밖이어도 됨).
 *  유저가 말해준곳. 앱 내의 명칭으로 지목해도 찾을 수 있게. (갤러리에 있는 첫번째 이미지 등)"*).
 *
 *  ★★**못 찾거나 여럿이면 오류다** — `lib/findAt` 과 같은 규칙이다. 조수가 고르게 두면
 *    엉뚱한 그림으로 i2i 가 나가고 Anlas 가 나간다. 후보를 실어 돌려주면 대개 한 번에 고친다.
 *
 *  받는 말은 넷이다.
 *
 *  | 꼴 | 보기 | 어디서 |
 *  |---|---|---|
 *  | 절대 경로 | `D:\사진\a.png` · `/home/me/a.png` | **아무 폴더나** — 설치 폴더 밖이어도 된다 |
 *  | `gallery:` + 번호 | `gallery:1` (최신이 1번) | 보관함 |
 *  | `gallery:` + 상대경로 | `gallery:작가/abc.png` | 보관함 |
 *  | `output:` + 상대경로 | `output:멀티/탭/씬/001.png` | 지금 워크스페이스 (`list_files` 가 주는 경로) |
 *
 *  접두가 없으면 **보관함에서 이름으로** 찾는다 (`abc.png`).
 */
import { api, backendUrl } from "./backend";
import { err, type ActionError } from "./actions.ts";
import { imgUrl, keepUrl } from "./imgUrl";
import { useWs } from "../store/workspace";

export type FoundImage = { data: string; name: string; from: string };

/** 절대 경로인가 — 윈도우 드라이브(`D:\`)·UNC(`\\서버`)·유닉스(`/`) */
const isAbsPath = (s: string) => /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\") || s.startsWith("/");

/** 주소 하나를 base64 로 — ★`?b64=1` 을 붙인다 (`panels/ImageActions` 의 그 자리와 같은 이유:
 *  같은 주소를 `<img>` 가 no-cors 로 먼저 캐시해 두면 뒤의 `fetch` 가 CORS 로 막힌다) */
async function urlToBase64(url: string): Promise<string> {
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "b64=1");
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const blob = await r.blob();
  return await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
    fr.onerror = () => rej(new Error("읽지 못했습니다"));
    fr.readAsDataURL(blob);
  });
}

/** 보관함 목록 — **최신이 먼저**다 (`backend/keep.images` 가 그 차례로 준다) */
async function keepList(): Promise<{ file: string; name: string }[]> {
  const r = await api<{ images: { file: string; name: string }[] }>(
    "/api/keep/images?folder=&page=1&limit=0",
  );
  return r.images ?? [];
}

/** ★보관함의 한 장을 바이트로 */
async function fromKeep(rel: string, base: string): Promise<FoundImage> {
  return { data: await urlToBase64(keepUrl(base, rel)), name: rel.split("/").pop() ?? rel, from: `gallery:${rel}` };
}

/** 그림 하나를 찾아 바이트까지 가져온다. 못 찾거나 여럿이면 오류를 돌려준다. */
export async function findImage(spec: string): Promise<FoundImage | { error: ActionError }> {
  const want = String(spec ?? "").trim();
  if (!want) return err("not_found", "어느 그림인지 적어 주세요.", { what: "image", retry: "never" });
  const base = await backendUrl();

  try {
    // 1) 절대 경로 — 서버가 읽어 준다 (`tools.read_dropped`, 뿌리를 안 가린다)
    if (isAbsPath(want)) {
      const r = await api<{ name: string; data?: string; text?: string }>("/api/tools/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: want.split(/[\\/]/).pop() || want, path: want }),
      });
      if (!r.data)
        return err("not_found", `그림이 아닙니다: ${want}`, { given: want, retry: "never" });
      return { data: r.data, name: r.name, from: want };
    }

    // 2) `output:` — 지금 워크스페이스의 생성물 (`list_files` 가 주는 상대경로)
    if (/^output:/i.test(want)) {
      const rel = want.slice(7).replace(/^[\\/]+/, "");
      const ws = useWs.getState().current;
      if (!ws) return err("no_workspace", "열린 워크스페이스가 없습니다.", { retry: "never" });
      return { data: await urlToBase64(imgUrl(base, ws, rel)), name: rel.split("/").pop() ?? rel,
               from: `output:${rel}` };
    }

    // 3) `gallery:` — 번호(최신이 1번)나 상대경로
    const gal = /^gallery:/i.test(want) ? want.slice(8).replace(/^[\\/]+/, "") : "";
    if (gal) {
      if (/^\d+$/.test(gal)) {
        const list = await keepList();
        const at = Number(gal) - 1;
        if (!list.length) return err("not_found", "보관함이 비어 있습니다.", { retry: "never" });
        if (at < 0 || at >= list.length)
          return err("not_found", `보관함에 ${list.length}장뿐입니다 (${gal}번은 없습니다).`,
                     { given: want, candidates: list.slice(0, 3).map((i) => `gallery:${i.file}`), retry: "never" });
        return await fromKeep(list[at].file, base);
      }
      return await fromKeep(gal, base);
    }

    // 4) 접두가 없다 — 보관함에서 **이름으로** 찾는다. 여럿이면 고르지 않는다
    const list = await keepList();
    const low = want.toLowerCase();
    const hit = list.filter((i) => i.file.toLowerCase() === low || i.name.toLowerCase() === low);
    const loose = hit.length ? hit : list.filter((i) => i.name.toLowerCase().includes(low));
    if (loose.length === 1) return await fromKeep(loose[0].file, base);
    if (loose.length > 1)
      return err("ambiguous", `「${want}」 에 여럿이 걸립니다. 경로로 정확히 지목해 주세요.`, {
        given: want, candidates: loose.slice(0, 3).map((i) => `gallery:${i.file}`), retry: "never",
      });
    return err("not_found", `그런 그림이 없습니다: ${want}`, {
      given: want,
      candidates: list.slice(0, 3).map((i) => `gallery:${i.file}`),
      retry: "never",
    });
  } catch (e) {
    // ★읽지 못한 것은 **모르는 것**이다 — 조수가 다시 시도해도 된다
    return err("not_found", `그림을 읽지 못했습니다: ${String(e)}`, { given: want, retry: "safe" });
  }
}
