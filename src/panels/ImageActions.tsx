import { useState } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import { fitSizeToBase, useGen } from "../store/gen";
import { useImageInput } from "../store/imageInput";
import { pushUndo } from "../lib/undo";
import { useUi } from "../store/ui";
import { ask } from "../store/ask";
import { toast } from "../store/toast";
import {
  applyMeta,
  applyMetaParams,
  applyMetaVibes,
  applyRecordedBase,
} from "./GalleryMeta";
import { usePrompt } from "../store/prompt";
import type { ShotEnv } from "../store/workspace";
import { api } from "../lib/backend";
import { upscaleCost } from "../lib/anlas";
import { useCurrentSub } from "../store/sub";
import { currentAccountId } from "../store/accounts";
import { useWs, type Rec } from "../store/workspace";
import type { ImageMeta } from "../store/gallery";
import { sendToTagger } from "./tools/TaggerTool";

/** 크게 본 그림 **아래에 붙는 한 줄** — "이 장으로 무엇을 할까" (페로픽스파이 `result-meta` 이식).
 *
 *  ★**세 자리가 같은 줄을 쓴다** (싱글 · 멀티 라이트박스 · 갤러리). 크게 보는 자리마다 따로
 *    만들면 어디서는 되고 어디서는 안 되는 상태가 생긴다 — 실제로 강화·보관이 라이트박스에만
 *    있었다 (사용자 지적 2026-08-05).
 *  ★**자리마다 없는 것은 넘기지 않으면 안 나온다.** 강화·보관은 워크스페이스 파일에만 뜻이
 *    있어서 갤러리(보관함)에서는 빠진다 — 버튼을 띄워 놓고 눌러야 실패하는 것보다 낫다.
 *  ★i2i·인페인트는 **생성 모드로 데려간다.** 안 그러면 눌러도 아무 일이 없어 보인다.
 */
export function ImageActions({
  url,
  name,
  seed,
  loadMeta,
  loadEnv,
  loadBase,
  ensureFile,
  hideSettings,
  dims,
  revealPath,
  revealApi = "/api/files/reveal",
  onEnhance,
  upscale,
  multi,
  onKeep,
  onConvert,
  onClone,
  onLeave,
  extra,
  right,
}: {
  /** 원본 주소 — i2i·인페인트가 이걸 읽어 베이스 이미지로 만든다 */
  url: string;
  name: string;
  seed?: number;
  /** 실제 해상도 — 페로픽스파이 `res-tag`. 그림을 띄우는 쪽이 `onLoad` 로 재서 준다 */
  dims?: { w: number; h: number } | null;
  /** 뿌리 기준 경로 — 있으면 「폴더 열기」가 뜬다 (페로픽스파이 📂 Folder) */
  /** 탐색기에서 열 경로. ★함수로 주면 **누를 때** 정한다 — 미저장 그림은 그때 저장하고
   *  새 경로를 돌려주면 된다 (`Canvas` 의 `ensureSaved`) */
  revealPath?: string | (() => Promise<string | null>);
  /** ★뿌리가 자리마다 다르다 — 워크스페이스 파일은 아웃풋 루트, 보관함은 `<APP>/gallery`.
   *  버튼은 하나로 두고 **창구만** 갈아 끼운다 (몸통 모양은 둘이 같다). */
  revealApi?: string;
  /** 이 그림의 생성 설정. 없으면 「설정 불러오기」가 안 뜬다 */
  loadMeta?: () => Promise<ImageMeta | null>;
  /** 파일이 있어야 하는 일 **앞에** 부른다 — 미저장 그림이면 저장하고 새 경로를 돌려준다.
   *  ★없으면 지금 경로를 그대로 쓴다 (갤러리·저장된 그림). 이 갈래를 부르는 쪽이 안다. */
  ensureFile?: () => Promise<string | null>;
  /** 생성할 때 남겨 둔 **그때 구조** (`gen.ts` 의 `env`). 있으면 설정 불러오기가 이걸 먼저 쓴다 */
  loadEnv?: () => Promise<ShotEnv | null>;
  /** 그 그림을 뽑을 때의 **베이스 이미지**(i2i·인페인트). 워크스페이스 그림에만 있다 */
  loadBase?: () => Promise<Parameters<typeof applyRecordedBase>[0]>;
  /** ★갤러리에서는 「설정 불러오기」를 안 띄운다 (사용자 지시 2026-08-19) — 거기서 되돌리는
   *  창구는 **「새 탭으로 복제」 하나**다. 보고 있던 탭이 조용히 갈리는 길을 남기지 않는다. */
  hideSettings?: boolean;
  onEnhance?: () => void;
  /** 업스케일 — **워크스페이스 파일에만** 뜻이 있다 (갤러리 보관함에는 안 뜬다).
   *  ★배율을 안 받는다: 공홈이 언제나 4 로 보낸다 (`nai.py UPSCALE_SCALE`) */
  upscale?: { ws: string; file: string; files?: string[] };
  /** ★씬 줄에서 **여러 장을 골랐다** (사용자 지시 2026-08-29). 2 이상이면 다중 처리가 되는
   *  단추(복제·인핸스·업스케일·보관·일괄 변환·삭제)만 남긴다 — 한 장 전용(프롬프트 보기·
   *  설정 불러오기·i2i·인페인트·폴더 열기·시드)은 어느 장의 것인지 애매하다. */
  multi?: number;
  onKeep?: () => void | Promise<void>;
  /** 「일괄 변환으로 보내기」 — 워크스페이스 파일에만 뜻이 있다 (캔버스가 준다) */
  onConvert?: () => void | Promise<void>;
  /** 「새 탭으로 복제」 — **워크스페이스 파일에만** 뜻이 있다 (보관함에서는 안 넘어온다).
   *  ★미저장 그림에도 안 뜬다: 그때는 부르는 쪽이 이 줄 대신 다른 줄을 그린다 (`SceneActions`) */
  onClone?: () => void | Promise<void>;
  /** 생성 모드로 갈 때 이 화면을 닫는다 (라이트박스·갤러리 큰 보기) */
  onLeave?: () => void;
  /** 이 줄에 함께 두고 싶은 것 (싱글의 「별표만 보기」) */
  extra?: React.ReactNode;
  /** ★**오른쪽 무리**에 서는 것 (사용자 지시 2026-08-25: *"확대축소는 오른쪽에
   *  배치해. 좌측 버튼들과 섞지 말고"*). 왼쪽은 **이 그림에 하는 일**(지우기·강화·
   *  보관…)이고, 오른쪽은 **보는 방식과 이 그림의 값**이다 — 성격이 다르다. */
  right?: React.ReactNode;
}) {
  const t = useI18n((s) => s.t);
  const [busy, setBusy] = useState(false);
  /** 시드 강조는 **커서를 올린 동안만** (사용자 지시 2026-08-19) */
  const [seedHot, setSeedHot] = useState(false);
  const opus = (useCurrentSub()?.tier ?? 0) >= 3;
  const [seen, setSeen] = useState<ImageMeta | null>(null);

  /** ★쿼리를 하나 붙여 받는다 — 같은 주소를 `<img>` 가 no-cors 로 먼저 캐시해 두면
   *  그 뒤의 `fetch` 가 CORS 로 막힌다 (실측으로 밟았다, 2026-08-04). */
  const asBase64 = async () => {
    /* ★★**미저장 그림은 주소가 `data:` 다** (자동 저장을 끈 결과 — `Canvas` 가 `takeSrc` 와 같은 꼴로
       준다). 거기에 `?b64=1` 을 붙이면 base64 가 깨져 i2i·인페인트가 실패했다 (사용자 지적
       2026-08-30). 이미 바이트를 들고 있으니 그대로 꺼낸다 — 서버에 물을 것이 없다. */
    if (url.startsWith("data:")) return url.split(",")[1] ?? "";
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "b64=1");
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const blob = await r.blob();
    return await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
      fr.onerror = () => rej(new Error(name));
      fr.readAsDataURL(blob);
    });
  };

  const toBase = async (mode: "img2img" | "inpaint") => {
    if (busy) return;
    setBusy(true);
    try {
      const b64 = await asBase64();
      const s = useImageInput.getState();
      // ★경로는 안 넘긴다 — Focused 는 **보낸 그림에서** 자른다 (사용자 지적 2026-08-20:
      //   경로를 요구하니 갤러리·드롭 그림에서 기능이 통째로 사라졌다)
      s.setBase(b64, name);
      // ★공홈처럼 **해상도를 그림에 맞춘다** — 안 맞추면 전송 직전 리샘플이 그림을 늘린다
      await fitSizeToBase(b64);
      // ★그림이 들어간 자리도 보여 준다 — 우측 패널이 접혀 있으면 펴진다
      /* ★그림이 들어간 자리를 **펴고 강조하고 그리로 데려간다** (사용자 지시 2026-08-19).
         이미지 입력은 **왼쪽 기둥**에 산다 (`OptionsPanel` 안) — 예전 `right` 는 옛 자리다.
         ★★데려가는 것은 **베이스 그림에 들어갈 때뿐**이다 (사용자 지시 2026-08-22).
           `reveal` 의 기본은 「안 데려감」이고, 참을 주는 자리는 둘이다 — 여기와 밖에서
           끌어다 놓는 길(`app/DropImport` 의 `asBase`, 2026-08-26에 맞췄다).
           **가는 곳이 같으니 거동도 같다.** 다른 자리로 늘리지 말 것. */
      useUi.getState().reveal("left", "base", true);
      s.patchBase({ baseMode: mode });
      useUi.getState().setMode("generate");
      onLeave?.();
      // ★인페인트는 **캔버스 자리에서** 칠한다 (모달이 아니다). 생성 모드로 옮긴 뒤
      //   편집을 켠다. 큰 그림이면 `startEdit` 이 Focused 를 켜 주고 알린다
      if (mode === "inpaint") {
        s.startEdit();
        return toast(t("act.sentInpaint"));
      }
      toast(t("act.sentI2i"));
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy(false);
    }
  };

  /** ★가르지 않는다 — **설정으로 쓰는 것 하나**다 (사용자 지시 2026-08-05).
   *  「프롬프트만」은 적용이 아니라 **보는 것**이라, 아래 `프롬프트 보기`로 갈라 나갔다. */
  /** 이 그림의 설정을 지금 화면으로 가져온다.
   *
   *  ★★**베이스 이미지도 되살린다** (사용자 지시 2026-08-22). i2i·인페인트로 뽑은 그림은
   *    그때 쓴 베이스가 기록에 남아 있는데(`resolved.parameters.image`) 읽는 창구가 없었다.
   *  ★★**블록 구조를 지킨다** (사용자 지적 2026-08-19: 한 뭉텅이로 왔다).
   *    메타데이터에는 **합쳐진 문자열**만 남아서, 그것만으로 되돌리면 블록이 한 덩어리가 되고
   *    캐릭터가 `#1`·`#2` 로 다시 만들어진다. 그래서 생성할 때 남겨 둔 **그때 구조**(`env`)를
   *    먼저 쓴다 — 「새 탭으로 복제」가 쓰는 것과 같은 것이다 (`gen.ts` 의 `env`).
   *    ★스냅샷이 없는 옛 그림·갤러리 그림만 메타데이터로 떨어진다. */
  const useSettings = async () => {
    if (!loadMeta || busy) return;
    setBusy(true);
    try {
      const m = await loadMeta();
      if (!m) return toast(t("act.noMeta"), "warn");
      /* ★★**되돌릴 수 있다** (사용자 지시 2026-08-30: 설정 불러오기도 취소 대상에). 불러오기는
         프롬프트·생성 옵션·이미지 입력(바이브·베이스) 셋을 한꺼번에 갈아 끼우므로, 셋을 **먼저
         찍어 두고** 끝나면 되돌리기 로그에 한 칸으로 담는다 — Ctrl+Z 한 번이면 전부 돌아온다. */
      const dataOf = <T extends object>(o: T) =>
        Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v !== "function")) as Partial<T>;
      const before = {
        prompt: usePrompt.getState().snapshot(),
        params: useGen.getState().params,
        input: dataOf(useImageInput.getState()),
      };
      const env = loadEnv ? await loadEnv().catch(() => null) : null;
      if (env?.prompt) {
        // 구조는 스냅샷에서, 값(해상도·시드·바이브)은 메타데이터에서
        usePrompt.getState().load(env.prompt);
        useUi.getState().reveal("left", "prompt");
        applyMetaParams(m);
        applyMetaVibes(m);
      } else applyMeta(m, "all");
      // ★베이스 이미지는 **그림에 안 남는다** — 기록에서 가져온다 (`applyRecordedBase` 의 ★주).
      //   ★구조를 못 찾은 옛 그림에도 건다: 베이스가 기록에 남는 것과 구조가 남는 것은 별개다
      if (loadBase)
        await applyRecordedBase(await loadBase().catch(() => null), name);
      pushUndo(t("common.undoSettings"), () => {
        usePrompt.getState().load(before.prompt);
        useGen.setState({ params: before.params });
        useImageInput.setState(before.input);
      });
      toast(t("act.applied"));
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy(false);
    }
  };

  /** ★여러 장 골랐다 — 다중 처리가 되는 단추만 남긴다 (`multi` prop 의 ★주) */
  const isMulti = (multi ?? 0) > 1;

  /** 업스케일 — 결과는 **원본의 다음 판**으로 붙는다 (원본은 그대로 남는다).
   *  ★배율은 서버가 정한다 (2026-08-21 규격 변경) */
  const cost = dims ? upscaleCost(dims.w, dims.h, opus) : -1;
  const runUpscale = async () => {
    if (!upscale || busy || cost < 0) return;
    setBusy(true);
    try {
      // ★미저장이면 **먼저 파일로 남긴다** — 업스케일은 서버가 그 파일을 연다
      const target = ensureFile ? await ensureFile() : upscale.file;
      if (!target) return;
      // ★여러 장 골랐으면 **전부** (사용자 지시 2026-08-29) — 한 장씩 차례로 보낸다
      const list = upscale.files?.length ? upscale.files : [target];
      /* ★다중일 때만 묻는다 (사용자 결정 2026-08-29) — 장수만큼 Anlas 가 한 번에 나간다.
         한 장은 공홈처럼 즉시다 (버튼의 비용 표기가 안내다). */
      if (
        list.length > 1 &&
        !(await ask({
          title: t("upscale.confirmMany", { n: list.length }),
          body: t("upscale.confirmManyBody"),
          ok: t("upscale.button"),
          cancel: t("common.cancel"),
        }))
      )
        return;
      for (const f of list) {
        const r = await api<{ file: string; record: Rec }>("/api/upscale", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // ★그 워크스페이스의 계정으로 — 잔액을 그쪽에서 쓴다 (`store/accounts`)
          body: JSON.stringify({ workspace: upscale.ws, file: f, account: currentAccountId() }),
        });
        // ★목록을 **다시 읽지 않는다** — 서버가 돌려준 레코드 한 줄만 얹으면 화면이 따라온다
        useWs.getState().addRecord(r.record);
      }
      toast(t("upscale.done"));
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy(false);
    }
  };

  /** 「새 탭으로 복제」 — 실제로 무엇을 옮기는지는 부르는 쪽이 안다 (`SceneActions`).
   *  여기서는 **한 번에 하나만** 돌게 잠그는 일만 한다 (다른 단추들과 같은 `busy`). */
  const runClone = async () => {
    if (!onClone || busy) return;
    setBusy(true);
    try {
      await onClone();
    } finally {
      setBusy(false);
    }
  };

  /** 이 그림의 프롬프트를 **읽기용**으로 연다 (설정을 건드리지 않는다) */
  const showPrompt = async () => {
    if (!loadMeta || busy) return;
    setBusy(true);
    try {
      const m = await loadMeta();
      if (!m) return toast(t("act.noMeta"), "warn");
      setSeen(m);
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy(false);
    }
  };

  /** Tagger로 보내기 (사용자 지시 2026-08-29: *"보조도구에 넣고 아무 이미지나 태거 돌리게.
   *  지금의 태거 버튼을 태거로 보내기로"*) — 결과 창구는 보조도구 › Tagger 하나다.
   *  일괄 변환으로 보내기와 같은 몸짓(`rel`)으로 싣는다. */
  const toTagger = async () => {
    if (!upscale || busy) return;
    setBusy(true);
    try {
      // ★여러 장 골랐으면 전부 싣는다 (사용자 지시 2026-08-29: "다중 선택도 대응")
      const files =
        isMulti && upscale.files?.length
          ? upscale.files
          : [ensureFile ? await ensureFile() : upscale.file];
      const items = files
        .filter((f): f is string => !!f)
        .map((f) => ({
          name: f.split("/").pop() ?? f,
          rel: `${upscale.ws}/${f}`,
        }));
      if (items.length) sendToTagger(items);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        data-image-actions
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          flexWrap: "wrap",
        }}
      >
        {/* ★★왼쪽 셋(프롬프트 보기·설정 불러오기·복제)도 **아이콘**이다 (사용자 지시 2026-08-29).
            2026-08-19 에는 「무엇을 어디로」가 걸린 일이라 글자로 뒀었는데, Tagger 가 아이콘으로
            끼면서 줄이 길어져 셋도 아이콘으로 바꿨다. 아이콘 단추는 **툴팁이 이름**이다.
            · 프롬프트 보기 = 태그 · Tagger = 태그+반짝(추출) · 설정 = 왼쪽으로 밀어 넣는 화살표 · 복제 = 겹친 판 */}
        {loadMeta && !isMulti && (
          <button
            data-act-prompt
            onClick={() => void showPrompt()}
            disabled={busy}
            data-tip={t("act.showPrompt")}
            style={iconBtn}
          >
            {Icon.tag}
          </button>
        )}
        {/* ★Tagger로 보내기 — 「프롬프트 보기」 바로 오른쪽. 워크스페이스 파일에만 뜻이 있다
            (`upscale` 과 같은 조건). ★여러 장 골랐을 때도 남는다 — 전부 싣는다. */}
        {upscale && (
          <button
            data-act-tagger
            onClick={() => void toTagger()}
            disabled={busy}
            data-tip={t("act.tagger")}
            style={iconBtn}
          >
            {Icon.tagger}
          </button>
        )}
        {loadMeta && !isMulti && !hideSettings && (
          <button
            data-act-settings
            onClick={() => void useSettings()}
            disabled={busy}
            data-tip={t("act.settings")}
            style={iconBtn}
          >
            {Icon.toLeft}
          </button>
        )}
        {/* ★「설정을 가져다 쓰는 것」 무리에 둔다 — 이 단추가 옮기는 것도 그림 한 장과
            **그 그림의 설정**이다 (페로픽스파이도 `.result-meta` 에서 「설정 불러오기」
            바로 옆에 「다른 워크스페이스로 복제」를 뒀다). 아래 줄은 이 그림을 **재료로**
            쓰는 무리라 성격이 다르다. */}
        {/* ★아이콘만 쓰는 자리는 **이름을 툴팁이 말한다** (사용자 지시 2026-08-19).
            글자로 남긴 것: i2i · 인페인트 · 업스케일(값이 붙는다) — 그림만으로는 뜻이 안 잡히는
            것들이다. 프롬프트 보기·설정·복제는 2026-08-29 에 아이콘으로 옮겼다 (위 ★★주). */}
        {onClone && (
          <button
            data-act-clone
            onClick={() => void runClone()}
            disabled={busy}
            data-tip={t("act.clone")}
            style={iconBtn}
          >
            {Icon.duplicate}
          </button>
        )}

        {!isMulti && (
          <>
            <span
              style={{
                width: 1,
                alignSelf: "stretch",
                background: "var(--line)",
              }}
            />

            <button
              data-act-i2i
              onClick={() => void toBase("img2img")}
              disabled={busy}
              style={btn}
            >
              {t("act.i2i")}
            </button>
            <button
              data-act-inpaint
              onClick={() => void toBase("inpaint")}
              disabled={busy}
              data-tip={t("act.inpaint")}
              style={iconBtn}
            >
              {Icon.brush}
            </button>
          </>
        )}
        {onEnhance && (
          <button
            data-act-enhance
            onClick={onEnhance}
            data-tip={t("enhance.button")}
            style={iconBtn}
          >
            {Icon.spark}
          </button>
        )}
        {upscale && dims && (
          <button
            data-act-upscale
            onClick={() => void runUpscale()}
            // ★1024x1024 를 넘으면 **공홈도 막는다.** 눌러야 실패하는 버튼을 두지 않는다
            disabled={busy || cost < 0}
            /* ★★**이름만 띄운다** (사용자 지시 2026-08-26: *"업스케일 힌트가 필요함? 그냥
                 「업스케일」이라고 하면 될 것 같은데"*). 값은 **단추에 이미 적혀 있고**
                 (아래 `{cost} Anlas`), 「다시 그리지 않는다」는 이름으로 짐작되는 성질이다.
               ★못 하는 경우만 사유를 띄운다 — 그것은 눌러 보기 전에는 알 수 없다. */
            data-tip={cost < 0 ? t("upscale.tooLarge") : t("upscale.button")}
            style={{
              ...btn,
              display: "inline-flex",
              alignItems: "center",
              opacity: cost < 0 ? 0.45 : 1,
            }}
          >
            {/* ★이름은 아이콘이 말하고(툴팁도 있다), **값은 글자로 남긴다** —
                누르면 얼마가 나가는지가 안전장치다 (v2 의 분해 표기와 같은 뜻) */}
            <span style={{ display: "grid", placeItems: "center" }}>
              {Icon.scaling}
            </span>
            <span style={{ marginLeft: 5, color: "var(--ink-faint)" }}>
              {cost < 0 ? "-" : `${cost} Anlas`}
            </span>
          </button>
        )}
        {revealPath && !isMulti && (
          <button
            data-act-reveal
            onClick={() =>
              void (async () => {
                const path =
                  typeof revealPath === "function"
                    ? await revealPath()
                    : revealPath;
                if (!path) return;
                await api(revealApi, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ path }),
                }).catch((e) => toast(String(e), "warn"));
              })()
            }
            data-tip={t("files.reveal")}
            style={iconBtn}
          >
            {Icon.folderOpen}
          </button>
        )}
        {onKeep && (
          <button
            data-act-keep
            onClick={() => void onKeep()}
            /* ★아이콘만 있는 단추라 툴팁이 **이름**을 맡는다 — 설명은 걷었다 (2026-08-26).
               ★문구를 코드에서 잇지 않는다 — 잇는 기호와 어순이 번역을 안 탄다 */
            data-tip={t("gallery.keep")}
            style={iconBtn}
          >
            {Icon.images}
          </button>
        )}
        {onConvert && (
          /* ★생성 직후 메타데이터를 지워 내보내는 길 (사용자 지시 2026-08-29) —
             파일 관리의 「일괄 이름 변환으로 보낸다」와 같은 창구로 간다 */
          <button
            data-act-convert
            onClick={() => void onConvert()}
            data-tip={t("tools.sendConvert")}
            style={iconBtn}
          >
            {Icon.external}
          </button>
        )}
        {extra}

        {/* ★시드·해상도는 **맨 뒤 우측**이다 (페로픽스파이 `.result-meta .seed`,
            styles.css:380 "길이가 바뀌어도 앞 버튼들이 안 밀린다").
            ★시드와 해상도는 **한 덩어리**로 — 따로 두면 줄이 넘칠 때 해상도만 다음 줄로
              떨어진다 (실측 2026-08-05) */}
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            flexShrink: 0,
          }}
        >
          {seed !== undefined && !isMulti && (
            <button
              data-act-seed
              /* ★★누르면 **복사하고 지금 시드로 넣는다** (사용자 지시 2026-08-21).
                 ★한때 「그 시드로 고정」이었다가 복사로 바뀐 적이 있는데, 그때 문제는
                   *동작*이 아니라 **강조가 계속 남는 것**이었다 (지금 시드와 같아지면 눌린
                   상태처럼 보였다). 강조를 커서 올린 동안만으로 고친 뒤라 둘 다 해도 된다.
                 ★**시드 규칙(고정/랜덤)은 건드리지 않는다** — 사용자가 고른 것이다. */
              onClick={() => {
                useGen.getState().set("seed", Number(seed));
                void navigator.clipboard?.writeText(String(seed));
                toast(t("act.seedApplied", { n: seed }));
              }}
              onPointerEnter={() => setSeedHot(true)}
              onPointerLeave={() => setSeedHot(false)}
              style={{
                border: "none",
                background: "none",
                padding: "0 2px",
                fontSize: "var(--text-2xs)",
                fontFamily: "var(--font-mono)",
                fontVariantNumeric: "tabular-nums",
                /* ★★**자리를 미리 잡아 둔다** (사용자 지시 2026-08-25: *"고정폭으로. 시드랑
                   해상도 텍스트 길이 변해도 UI 막 이동 안 하게"*). 시드는 한 자리에서
                   열 자리까지 오가는데, 장을 넘길 때마다 옆 표시가 따라 밀리면 눈이 쫓아간다.
                 ★`ch` 는 고정폭 글꼴의 **글자 한 칸**이라 자릿수와 정확히 맞는다
                   (`seed ` 다섯 칸 + 열 자리). */
                minWidth: "15ch",
                textAlign: "right",
                cursor: "pointer",
                textDecoration: seedHot ? "underline" : undefined,
                color: seedHot ? "var(--accent-ink)" : "var(--ink-faint)",
              }}
            >
              seed {seed}
            </button>
          )}
          {dims && !isMulti && (
            <span
              data-act-res
              style={{
                flexShrink: 0,
                fontSize: "var(--text-2xs)",
                /* ★시드와 **같은 글꼴·같은 요령**이다 — 한 덩어리로 읽히고 폭도 안 흔들린다 */
                fontFamily: "var(--font-mono)",
                fontVariantNumeric: "tabular-nums",
                minWidth: "11ch",
                textAlign: "right",
                color: "var(--ink-faint)",
              }}
            >
              {dims.w}×{dims.h}
            </span>
          )}
          {/* ★★**맨 오른쪽 끝**이다 (사용자 지시 2026-08-25: *"확대축소는 최우측에. 현재
            위치는 시드 때문에 자꾸 위치가 바뀜"*). 시드·해상도는 **있을 때만** 뜨는 값이라
            (미저장 그림에는 없다) 그 앞에 두면 그림을 넘길 때마다 좌우로 밀린다.
            줄의 끝에 붙여 두면 무엇이 있든 자리가 하나다. */}
          {right}
        </span>
      </div>

      {seen && <PromptView meta={seen} onClose={() => setSeen(null)} />}
    </>
  );
}

/** 이 그림의 프롬프트를 **최종 프롬프트와 같은 모양**으로 보여준다 (읽기 전용).
 *
 *  ★적용 버튼을 달지 않는다 — 적용은 옆의 「설정 불러오기」 하나뿐이다.
 *    같은 일을 두 곳에서 하게 두면 "어느 쪽이 뭘 바꾸나"가 흐려진다. */
function PromptView({
  meta,
  onClose,
}: {
  meta: ImageMeta;
  onClose: () => void;
}) {
  const t = useI18n((s) => s.t);
  const rows: { label: string; text: string; accent?: string }[] = [
    { label: t("prompt.tabPrompt"), text: meta.prompt ?? "" },
    {
      label: t("prompt.tabUc"),
      text: meta.negative ?? "",
      accent: "var(--uc-c)",
    },
    ...(meta.characters ?? []).map((c, i) => ({
      label: t("cards.charN", { n: i + 1 }),
      text: c.prompt,
    })),
  ];
  const all = rows.map((r) => `${r.label}\n${r.text}`).join("\n\n");

  return (
    <div
      data-prompt-view
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 88,
        background: "rgba(6,8,12,0.62)",
        display: "grid",
        placeItems: "center",
        padding: "var(--sp-6)",
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-4)",
          padding: "var(--sp-5)",
          width: "min(560px, 92vw)",
          maxHeight: "80vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-3)",
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}
        >
          <b style={{ fontSize: "var(--text-md)" }}>{t("act.promptOf")}</b>
          <span style={{ flex: 1 }} />
          <button
            data-prompt-copy
            onClick={() =>
              void navigator.clipboard
                ?.writeText(all)
                .then(() => toast(t("act.copied")))
            }
            style={btn}
          >
            {t("act.copy")}
          </button>
          <button data-prompt-close onClick={onClose} style={btn}>
            {t("act.close")}
          </button>
        </div>
        {rows.map((r, i) => (
          <div key={i}>
            {/* ★줄마다 복사 단추 (사용자 지시 2026-08-19) — 위의 것은 **전부**를 복사하는데,
                캐릭터 하나만 다른 데 옮겨 쓰는 일이 더 잦다 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-2)",
              }}
            >
              <div
                style={{
                  flex: 1,
                  fontSize: "var(--text-2xs)",
                  color: r.accent ?? "var(--ink-dim)",
                }}
              >
                {r.label}
              </div>
              <button
                data-prompt-copy-one={i}
                disabled={!r.text}
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(r.text)
                    .then(() => toast(t("act.copied")))
                }
                style={{
                  display: "grid",
                  placeItems: "center",
                  padding: 2,
                  borderRadius: "var(--r-1)",
                  color: r.text ? "var(--ink-faint)" : "var(--ink-ghost)",
                }}
                data-tip={t("act.copy")}
              >
                {Icon.copy}
              </button>
            </div>
            <pre
              style={{
                margin: "2px 0 0",
                padding: "var(--sp-2)",
                background: "var(--code-bg)",
                borderRadius: "var(--r-1)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-2xs)",
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                color: "var(--ink-soft)",
              }}
            >
              {r.text || t("prompt.empty")}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 아이콘만 있는 단추 — 글자 단추와 **같은 높이**로 선다 (줄이 들쭉날쭉하면 안 된다) */
/** ★단추 모양은 이 줄이 정본이다 — `extra` 로 끼워 넣는 쪽도 같은 자를 쓴다
 *  (갤러리의 지우기 단추). 자리마다 새로 만들면 한 줄 안에서 크기가 갈린다. */
export const iconBtn: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  padding: "3px var(--sp-2)",
  minWidth: 28,
};

const btn: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  padding: "3px var(--sp-3)",
  fontSize: "var(--text-2xs)",
};
