import { useEffect, useRef, useState } from "react";
import { IS_MAC } from "./platform";

/** 밖에서 떨군 그림을 받는다 — **앱과 브라우저는 받는 방법이 다르다.**
 *
 *  ★Tauri 는 창에 떨어진 파일을 **자기가 가로챈다**. 그래서 HTML5 `drop` 이벤트는
 *    **아예 오지 않는다** (`dragDropEnabled` 기본값 true, tauri-utils config.rs:1944
 *    *"Disabling it is required to use HTML5 drag and drop on the frontend on Windows"*).
 *    대신 `onDragDropEvent` 로 **진짜 경로**가 온다 — 이게 오히려 낫다: 바이트를 안 싣고
 *    경로만 보내면 서버가 직접 읽는다 (강화의 `enhance_from` 과 같은 취지).
 *  ★브라우저(개발·QA)에는 그 이벤트가 없으니 HTML5 drop 으로 받고 base64 로 싣는다.
 *
 *  두 갈래를 부르는 쪽이 몰라도 되게, 결과는 한 모양으로 준다.
 */
/** `rel` 은 **아웃풋 루트 기준** 경로 — 파일 관리에서 고른 것이 이 모양으로 온다 */
export type Dropped = { name: string; path?: string; rel?: string; data?: string };

const IMG = /\.(png|jpe?g|webp)$/i;
const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 앱 창에 떨어진 **경로**를 한 자리에서 받는다 (Tauri 전용).
 *
 *  ★창 하나에 드롭존이 여럿이므로 **좌표로 가려낸다** — 이벤트는 창 전체로 온다.
 *    좌표는 물리 픽셀이라 dpr 로 나눠야 CSS 좌표가 된다.
 *  ★`useImageDrop` 과 `ImageInputPanel` 의 고르기 단추가 **같은 이 함수**를 쓴다 —
 *    좌표 계산을 두 벌 두면 한쪽만 고쳐져 조용히 갈린다.
 */
export function useTauriDrop(
  ref: React.RefObject<HTMLElement | null>,
  accept: RegExp,
  onPaths: (paths: string[]) => void,
  onOver?: (over: boolean) => void,
  /** ★**창 어디에 떨궈도 받는다** — 다만 *다른* 드롭존(`[data-drop-file]`) 위는 비켜 준다.
   *  그 자리는 주인이 따로 있다 (베이스 그림 단추 등). */
  wide = false,
) {
  const cb = useRef(onPaths);
  cb.current = onPaths;
  const hov = useRef(onOver);
  hov.current = onOver;

  useEffect(() => {
    if (!inTauri()) return;
    let stop: (() => void) | undefined;
    let dead = false;
    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const mine = (p: { x: number; y: number }) => {
        /* ★★맥은 좌표가 **이미 논리 픽셀**로 온다 — wry 가 `draggingLocation`(포인트)을 그대로 넘기고 Tauri 는
             이름만 물리 좌표로 붙인다 (wry 0.55 `wkwebview/drag_drop.rs`). 윈도우는 물리 픽셀이라 배율로 나눈다. */
        const dpr = IS_MAC ? 1 : window.devicePixelRatio || 1;
        const el = document.elementFromPoint(p.x / dpr, p.y / dpr);
        if (el && ref.current?.contains(el)) return true;
        // ★넓게 받는 자리: **다른 드롭존이 아닌 곳**이면 내 것이다
        return wide && !el?.closest?.("[data-drop-file]");
      };
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "leave") return hov.current?.(false);
        if (p.type === "enter" || p.type === "over") return hov.current?.(mine(p.position));
        if (p.type === "drop") {
          hov.current?.(false);
          if (!mine(p.position)) return;
          const paths = p.paths.filter((x) => accept.test(x));
          if (paths.length) cb.current(paths);
        }
      });
      if (dead) un();
      else stop = un;
    })();
    return () => {
      dead = true;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const readAsData = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error(f.name));
    r.readAsDataURL(f);
  });

/** @param accept 받을 확장자. ★기본은 그림뿐이다 — 드롭 가져오기만 `.naiv4vibe` 를 더한다
 *   (그 파일은 그림이 아니라 인코딩이 든 JSON 이다, `lib/naiVibeFile`). */
export function useImageDrop(onDrop: (items: Dropped[]) => void, wide = false, accept = IMG) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [over, setOver] = useState(false);
  const cb = useRef(onDrop);
  cb.current = onDrop;
  /** ★정규식은 **처음 것을 붙들어 둔다.** 부르는 쪽이 리터럴을 그 자리에 쓰면 렌더마다 새
   *  객체라, 그대로 딸림값에 넣으면 창 리스너가 렌더마다 붙었다 떨어진다. */
  const acc = useRef(accept);

  useTauriDrop(
    ref,
    acc.current,
    (paths) => cb.current(paths.map((x) => ({ name: x.split(/[\\/]/).pop() || x, path: x }))),
    setOver,
    wide,
  );

  /** 브라우저(개발·QA)에서 **창 전체로** 받는 갈래. 앱에서는 위 `useTauriDrop` 이 한다.
   *  ★판정은 두 갈래가 **같은 표식**으로 한다 — 다른 드롭존 위는 비켜 준다. */
  useEffect(() => {
    if (!wide || inTauri()) return;
    const mine = (e: DragEvent) => !(e.target as HTMLElement | null)?.closest?.("[data-drop-file]");
    const onOver = (e: DragEvent) => {
      if (!mine(e)) return;
      e.preventDefault();
      setOver(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setOver(false);
    };
    const onDropAny = async (e: DragEvent) => {
      if (!mine(e)) return;
      e.preventDefault();
      setOver(false);
      const fs = [...(e.dataTransfer?.files ?? [])].filter((f) => acc.current.test(f.name));
      if (!fs.length) return;
      cb.current(await Promise.all(fs.map(async (f) => ({ name: f.name, data: await readAsData(f) }))));
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDropAny);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDropAny);
    };
  }, [wide]);

  /** 브라우저 쪽 손잡이. Tauri 에서는 이 이벤트가 안 오므로 그냥 놀고 있는다. */
  const zone = {
    ref,
    "data-drop": true,
    /** ★**파일 드롭존 표식** — 넓게 받는 자리(`wide`)가 「여긴 주인이 따로 있다」를 이것으로 안다 */
    "data-drop-file": true,
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: async (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const fs = [...e.dataTransfer.files].filter((f) => acc.current.test(f.name));
      if (!fs.length) return;
      cb.current(await Promise.all(fs.map(async (f) => ({ name: f.name, data: await readAsData(f) }))));
    },
  } as const;

  /** 파일 고르기 대화상자 — 떨구기 말고 눌러서 고르는 길 (v2 도 둘 다 있었다) */
  const pick = () =>
    new Promise<void>((res) => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "image/png,image/jpeg,image/webp";
      inp.multiple = true;
      inp.onchange = async () => {
        const fs = [...(inp.files || [])];
        if (fs.length)
          cb.current(await Promise.all(fs.map(async (f) => ({ name: f.name, data: await readAsData(f) }))));
        res();
      };
      inp.click();
    });

  return { zone, over, pick };
}
