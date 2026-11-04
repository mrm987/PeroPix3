import { TYPE } from "../styles/type";
import { useState, type ReactNode, type PointerEvent } from "react";
import { useRename } from "../components/useRename";
import { Icon } from "../components/Icon";
import { dragSourceStyle } from "../cards/dragStore";
import { FittedImg } from "../cards/FittedImg";
import { BANNER_BG, BANNER_CUT, BANNER_IMG_W, BANNER_SCRIM, BANNER_STEP, bannerEmptyFill } from "../cards/banner";

/** 배너 위의 작은 단추 — **앱 전체에서 이 하나를 쓴다** (사용자 지적 2026-08-20:
 *  스택 쪽 단추가 카드 단추와 달라 보였다). 크기·모서리·바탕·아이콘 정렬이 여기서 정해진다.
 *
 *  ★★**클릭을 여기서 멈춘다.** 배너·스택 카드는 **누르면 접히거나 펼쳐지는** 자리라,
 *    멈추지 않으면 단추를 눌렀는데 그 동작까지 같이 돈다 (사용자 지적 2026-08-20:
 *    「앞으로 가져오기」를 누르면 펼치기/접기가 함께 일어났다).
 *  ★`pointerdown` 도 멈춘다 — 배너의 역드래그(덱으로 저장)가 걸리지 않게.
 *  ★`mousedown` 의 기본 동작만 막는다 — 이름 입력칸이 흐려지지 않게 하려는 것이고,
 *    `pointerdown` 에서 막으면 호환 click 이 통째로 사라진다 (CLAUDE.md 「잊기 쉬운 것」). */
export function BannerBtn({
  title,
  onClick,
  mark,
  off,
  children,
}: {
  title: string;
  onClick: () => void;
  /** 조작 테스트가 잡는 손잡이 */
  mark?: string;
  /** 지금은 할 수 없는 것 — ★**자리를 지킨 채** 흐려진다. 숨기면 옆 단추가 밀려
   *  맨 위·맨 아래 카드에서 「제거」가 다른 자리에 서게 된다 */
  off?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      {...(mark ? { [mark]: "" } : {})}
      data-tip={title}
      disabled={off}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        if (off) return;
        onClick();
      }}
      style={{
        display: "grid",
        placeItems: "center",
        width: 20,
        height: 20,
        borderRadius: 5,
        background: "rgba(0,0,0,0.42)",
        color: "#fff",
        fontSize: "calc(11px * var(--text-scale))",
        lineHeight: 1,
        opacity: off ? 0.3 : 1,
        cursor: off ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

/** 카드형 섹션 — **가로 배너가 곧 영역 구분선**이다 (목업 구조 그대로).
 *
 *  배너는 스타일·캐릭터 카드가 꽂히는 자리다. 카드의 그라데이션과 이름을 그대로 쓰며,
 *  실제 앱에서는 이 자리에 사용자의 생성물 썸네일이 들어간다.
 *  배너를 끌어 우하단 핸드에 넣으면 덱에 저장된다(역드래그) — 그래서 포인터 핸들러를 받는다. */
export function SectionCard({
  name,
  gradient,
  accent,
  dim,
  outline,
  overlay,
  onRename,
  renameTip = "",
  nameTag,
  bannerLead,
  bannerActions,
  hoverLift,
  thumb,
  zone,
  folded,
  onFold,
  onBannerPointerDown,
  innerRef,
  children,
}: {
  name: string;
  gradient: [string, string];
  /** 카드 종류 색 — 섹션 테두리에 옅게 반영된다 */
  accent?: string;
  /** 꺼진 섹션 — 컴파일에서 빠진다는 것을 흐림으로 보인다 */
  dim?: boolean;
  /** 드롭 강조: 1단계 = 점선(놓을 수 있다), 2단계 = 실선(지금 떼면 여기) */
  /** 놓을 수 있는 자리인가 — `dashed` = 받을 수 있다 · `solid` = 지금 그 위다.
   *  ★이름은 남았지만 **선을 그리지 않는다**: 어둠 위로 올려 밝기로 알린다 (아래 ★주) */
  outline?: "none" | "dashed" | "solid";
  /** **카드 전체**를 덮는 겹침 층 (드롭 존). 배너가 아니라 섹션 높이 전부를 받는다 */
  overlay?: ReactNode;
  /** ★이름을 **카드 안에서** 고친다 (사용자 지시 2026-08-19) — 시스템 `prompt()` 창을 쓰지
   *  않는다. 주면 이름을 두 번 눌러 그 자리에서 고칠 수 있고, 배너에 연필 단추가 선다. */
  onRename?: (v: string) => void;
  /** 연필 단추의 안내 문구 — i18n 은 부르는 쪽이 든다 */
  renameTip?: string;
  /** 이름 **뒤**에 붙는 것 — 캐릭터 카드의 인물 번호 (`CharPositioner` 의 `CharNo`) */
  nameTag?: ReactNode;
  /** 배너 우측 버튼 (켜기·삭제 등) */
  bannerActions?: ReactNode;
  /** 이름변경 **앞**에 서는 버튼 — 카드 자체를 다루는 것(차례 바꾸기)이 여기 온다 */
  bannerLead?: ReactNode;
  /** 배너를 끌 수 있음을 알리는 살짝 떠오름 */
  hoverLift?: boolean;
  /** 배너에 꽂아 둔 생성물 (없으면 그라데이션) */
  thumb?: { url: string; zoom: number; px: number; py: number } | null;
  /** 드롭 존 이름 — 핸드·캔버스와 같은 `data-zone` 규약이다. 조작 테스트가 잡는 지점이기도 하다 */
  zone?: string;
  /** 접힌 카드 — 배너만 남고 본문(탭·블록)이 빠진다. 카드가 여럿일 때 목록처럼 훑기 위한 것 */
  folded?: boolean;
  onFold?: () => void;
  onBannerPointerDown?: (e: PointerEvent) => void;
  innerRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  /** 이름 고치기 — ★규칙은 **앱에 하나**다 (`useRename`): 단추를 다시 누르면 저장하고 끝 */
  const rename = useRename(name, onRename);
  return (
    <div
      ref={innerRef}
      data-zone={zone}
      style={{
        position: "relative",
        marginBottom: "var(--sp-5)",
        border: `1px solid ${accent ? `color-mix(in srgb, ${accent} 45%, var(--line))` : "var(--line)"}`,
        borderRadius: "var(--r-4)",
        background: "var(--surface)",
        overflow: "hidden",
        opacity: dim ? 0.45 : 1,
        /* ★★받을 수 있는 자리는 **테두리가 아니라 밝기로** 알린다 (사용자 지시 2026-08-20).
           ★★**어둠 위로 올리는 것은 카드가 아니라 묶음 전체**다 (`Category` 의 `spot`) —
             카드마다 올리면 카드 사이 여백이 어두운 채라 자리가 조각조각 보인다
             (사용자 지적: "드롭영역 전체가 밝아져야하는데, 개별 카드만 밝아져").
           여기서는 **지금 그 위에 있는 카드**만 한 겹 더 밝힌다. */
        ...(outline === "solid" ? { filter: "brightness(1.18)" } : {}),
      }}
    >
      {/* 배너 */}
      <div
        onPointerDown={onBannerPointerDown}
        // ★역드래그가 없는 카드는 평범한 클릭으로 접는다 (있으면 `onTap` 이 받는다)
        onClick={onBannerPointerDown ? undefined : onFold}
        onMouseEnter={() => hoverLift && setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: "relative",
          height: 56,
          cursor: onBannerPointerDown ? "grab" : onFold ? "pointer" : "default",
          // ★살짝 떠오르게 해서 "끌 수 있다"를 알린다. 크게 움직이면 목록이 출렁인다
          transform: hover ? "translateY(-2px)" : undefined,
          boxShadow: hover ? "0 4px 12px rgba(0,0,0,0.28)" : undefined,
          transition: "transform 0.14s ease, box-shadow 0.14s ease",
          overflow: "hidden",
          // ★바탕은 **언제나 같은 단색**이다. 그림 자리 오른쪽은 이 색이 끝까지 이어지므로
          //   패널을 넓혀도 그림이 늘어나지 않고 단색만 늘어난다.
          background: BANNER_BG,
          ...(onBannerPointerDown ? dragSourceStyle : null),
        }}
      >
        {/* 그림 자리 — ★폭 240px 고정 (목업 .bimg). 패널을 넓혀도 여기는 안 늘어난다.
            ★**빈 상태에도 이 상자를 그린다** — 그림만 빠진 같은 실루엣이어야 두 상태가
              이어져 보인다 (사용자 지적 2026-08-03: 빈 배너가 전혀 다른 그림이었다). */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: BANNER_IMG_W,
            overflow: "hidden",
            pointerEvents: "none",
            // ★계단 컷 (design/banner-variants.html 의 G 안). 감쇠로 녹이지 않고 **잘라낸다** —
            //   감쇠는 끝점에서 기울기가 끊겨 선으로 보였다(실측). 자른 자리는 그 자체가
            //   의도된 모서리라 그 문제가 없고, 오른쪽은 순수 단색이 이어진다.
            maskImage: BANNER_CUT,
            WebkitMaskImage: BANNER_CUT,
            // 그림이 없으면 같은 실루엣에 카드 색만 — 종류를 알리는 자리이기도 하다
            background: thumb ? undefined : bannerEmptyFill(gradient),
          }}
        >
          {thumb && <FittedImg url={thumb.url} w={BANNER_IMG_W} h={56} view={thumb} />}
          {/* 중간 단 — 잘리기 전 구간을 한 번 어둡게 눕혀 계단을 만든다 */}
          <div style={{ position: "absolute", inset: 0, background: BANNER_STEP }} />
        </div>
        {/* 하단 스크림 — 일러스트가 화려해도 텍스트가 읽히게 */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: BANNER_SCRIM,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 11,
            bottom: 6,
            zIndex: 1,
            display: "flex",
            alignItems: "baseline",
            gap: "var(--sp-3)",
            color: "#fff",
            textShadow: "0 1px 2px rgba(0,0,0,0.75)",
          }}
        >
          {rename.editing ? (
            <input
              data-card-rename
              {...rename.inputProps}
              style={{
                width: 130,
                background: "rgba(0,0,0,0.45)",
                border: "1px solid rgba(255,255,255,0.5)",
                borderRadius: "var(--r-1)",
                padding: "0 4px",
                color: "#fff",
                ...TYPE.cardName,
              }}
            />
          ) : (
            <b
              onDoubleClick={onRename && ((e) => { e.stopPropagation(); rename.toggle(); })}
              style={{ ...TYPE.cardName, cursor: onRename ? "text" : undefined }}
            >
              {name}
            </b>
          )}
          {nameTag && <span style={{ alignSelf: "center", display: "flex" }}>{nameTag}</span>}
          {/* ★★카드 종류를 적지 않는다 (사용자 지시 2026-08-19) — 「스타일 카드」·
              「CHARACTER CARD」는 그 자리에 있는 것만으로 이미 아는 것이라, 이름 옆에서
              자리만 먹었다. 프롭도 함께 걷었다. */}
        </div>
        {(bannerActions || bannerLead || onRename) && (
          <div
            style={{
              position: "absolute",
              right: 8,
              bottom: 6,
              zIndex: 2,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {/* ★★단추 차례는 앱 전체에서 하나다: **(차례 바꾸기 ·) 이름변경 · 온오프 · 삭제**
                (사용자 지시 2026-08-19: 카드·블록마다 제멋대로였다.
                 2026-08-21: 차례 바꾸기는 이름변경 **앞**에 선다).
                ★이름 고치기는 **카드가 스스로** 단다 — 섹션마다 따로 만들면 어디는 있고
                  어디는 없는 상태가 된다 (스타일 카드에는 아예 없었다) */}
            {bannerLead}
            {onRename && (
              <BannerBtn
                mark="data-rename-btn"
                title={renameTip}
                /* ★고치는 중에 다시 누르면 **저장하고 끝낸다** — 규칙은 `useRename` 한 곳에 있다.
                   ★`btnProps` 를 안 펴 넣는 이유: 이 단추는 이미 `mousedown` 기본 동작을 막고
                     click 을 멈춘다 (배너의 역드래그 때문에) — 같은 일을 두 번 하지 않는다 */
                onClick={rename.toggle}
              >
                {Icon.pencil}
              </BannerBtn>
            )}
            {bannerActions}
          </div>
        )}
        {/* ★★접기에는 **아무 표시도 두지 않는다** (사용자 지시 2026-08-16).
            머리를 누르면 접힌다. 화살표는 단추가 아니어도 단추처럼 보여서 뺐다 —
            접혔는지는 몸통이 있고 없고로 안다.
            ★클릭과 끌기는 `useDragSource` 가 가른다: 4px 문턱을 안 넘고 떼면 `onTap`,
              넘으면 덱으로 저장하는 역드래그다 (그쪽 주석). */}
      </div>

      {/* ★★접혀 있다는 것을 **작은 바**로 알린다 (사용자 지시 2026-08-19).
          배너만 남으면 「짧은 카드」인지 「접힌 카드」인지 구별이 안 됐다. 접힌 카드 아래에
          한 줄이 삐져나온 모양이라, 아래에 뭔가 더 있다는 것이 그림으로 읽힌다. */}
      {folded && (
        <div
          data-card-folded
          onClick={onFold}
          style={{
            height: 7,
            margin: "0 8px",
            borderRadius: "0 0 var(--r-2) var(--r-2)",
            background: "var(--line)",
            cursor: onFold ? "pointer" : undefined,
          }}
        />
      )}

      {/* 내용 — 접으면 배너만 남는다 */}
      {!folded && (
        <div
          style={{
            padding: "var(--sp-2) 9px 9px",
            display: "flex",
            flexDirection: "column",
            gap: "var(--sp-2)",
          }}
        >
          {children}
        </div>
      )}

      {/* ★드롭 존은 배너가 아니라 **카드 전체**를 덮는다 — 위/아래 반씩 나눠 받으려면
          기준이 카드 높이여야 한다. 배너(56px) 안을 나누면 판정 영역이 손톱만 해진다 */}
      {overlay}
    </div>
  );
}
