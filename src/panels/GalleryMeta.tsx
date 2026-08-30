import { Icon } from "../components/Icon";
import { reproWarn } from "../lib/reproWarn";
import { t, useI18n } from "../i18n";
import { makeBlock, parseSegs } from "../lib/blocks";
import { useGen } from "../store/gen";
import { DEFAULT_CENTER } from "../lib/charPos";
import { useGallery, type ImageMeta } from "../store/gallery";
import { CHAR_COLOR, usePrompt, type Char } from "../store/prompt";
import { useImageInput } from "../store/imageInput";
import { useUi } from "../store/ui";
import { keepScroll, LEFT_SCROLL } from "../lib/keepScroll";
import { useSceneFocus } from "../store/sceneFocus";
import { useWs } from "../store/workspace";
import { api } from "../lib/backend";
import { toast } from "../store/toast";
import { metaParams, PICK_ALL, type MetaPick } from "../lib/metaApply";

/** 그림 정보 — 우 패널. 고른 **한 장**의 메타데이터를 보여주고, 프롬프트로 되돌린다.
 *
 *  ★"프롬프트로 불러오기"가 v2 의 통합 Apply 모달 자리다 (feature-inventory G절).
 *    모달 대신 패널에 둔 이유: 그림을 넘겨 가며 비교하다 마음에 드는 것을 그대로 쓰는 흐름이라,
 *    창이 뜨면 비교가 끊긴다. */
export function GalleryMeta() {
  const t = useI18n((s) => s.t);
  const { focus, meta } = useGallery();

  // ★고른 그림이 없을 때 조작 안내를 또 적지 않는다 — 그 안내는 그리드 위 툴바에 이미 있다.
  //   여기는 "왜 비어 있는지"만 한 줄로 말한다.
  if (!focus) {
    return (
      <Frame>
        <div style={{ padding: "0 var(--sp-4)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
          —
        </div>
      </Frame>
    );
  }

  if (!meta) {
    return (
      <Frame>
        <div style={{ padding: "var(--sp-4)", color: "var(--ink-faint)" }}>
          <div style={{ fontSize: "var(--text-xs)" }}>{t("gallery.noMeta")}</div>
          <div style={{ fontSize: "var(--text-2xs)", marginTop: "var(--sp-2)" }}>
            {t("gallery.noMetaHint")}
          </div>
        </div>
      </Frame>
    );
  }

  /* ★★**「새 탭으로 복제」는 그림 아래 단추 줄에 있다** (`ImageActions` 의 `onClone`).
     사용자 지시 2026-08-25: *"갤러리에 「새 탭으로 복제」 버튼이 중복임. 오른쪽에 크게
     있을 이유가 없으니 오른쪽 큰 버튼 제거."* 이 패널은 **보는 자리**로 남는다.
     여기에 단추를 다시 두지 말 것 — 같은 일을 두 자리에 두면 어느 것이 무엇인지 흐려진다. */

  return (
    <Frame>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 var(--sp-4) var(--sp-4)" }}>
        <MetaBody m={meta} />
      </div>

    </Frame>
  );
}

/** 그 그림의 설정으로 **새 탭을 만든다** (갤러리의 유일한 되돌리기 창구).
 *
 *  ★★**워크스페이스 그림의 복제와 같은 자리를 쓴다** (`workspace.cloneToNewTab`) —
 *    사용자 지시 2026-08-19: *"슬롯에서 복제할때랑 동일한 로직 사용해"*. 갈래를 두 벌 두면
 *    한쪽만 고쳐져 갤러리에서만 조용히 빠지는 것이 생긴다 (실제로 그렇게 됐다:
 *    **슬롯 프롬프트가 통째로 사라지고, 그림이 슬롯에 안 앉았다**).
 *
 *  다른 것은 셋뿐이다:
 *    · 파일이 **보관함**에 있다 — 서버가 거기서 집어 새 슬롯에 앉힌다 (`from: "keep"`)
 *    · 구조를 찾아볼 자리가 **그 그림의 출처**다 (`/api/keep/origin` → 그 워크스페이스의 `env`).
 *      ★구조는 PNG 에 안 남는다 — 출처를 못 찾으면 되돌릴 것이 합쳐진 문자열뿐이다.
 *    · 그때는 **씬을 메타데이터에서** 받는다 (`slot_prompt`, v2 가 PNG 에 남긴 슬롯 프롬프트)
 *
 *  ★예전 이름 「설정 불러오기」는 **어디에 불러오는지**를 말하지 않아, 보고 있던 탭이
 *    통째로 갈리는 줄 모르고 누르게 됐다 (사용자 지적 2026-08-19).
 *
 *  @param file 보관함 안에서의 경로 (갤러리가 다루는 그 파일) */
export async function cloneMetaToNewTab(m: ImageMeta, file: string) {
  const ws = useWs.getState();
  if (!ws.current || !ws.spec) return;
  const origin = await api<{ origin: { workspace: string; file: string } | null }>(
    `/api/keep/origin?file=${encodeURIComponent(file)}`,
  )
    .then((r) => r.origin)
    .catch(() => null);

  const landed = await ws.cloneToNewTab(file, {
    excludeNo: useGen.getState().params.exclude_slot_number,
    from: "keep",
    origin: origin && { ws: origin.workspace, file: origin.file },
    seed: m.seed,
    // 출처를 못 찾았을 때만 쓰인다 — 그때 슬롯을 비우면 씬 프롬프트가 사라진다
    scene: m.slot_prompt
      ? { blocks: [makeBlock(t("slots.blockTags"), [], { tags: parseSegs(m.slot_prompt), src: m.slot_prompt, open: true })] }
      : undefined,
    // ★구조를 되살렸으면 **값만** 얹는다 (워크스페이스 복제와 같다). 못 되살렸을 때만
    //   메타데이터로 프롬프트까지 세운다 — 안 그러면 되살린 블록·카드를 한 뭉텅이가 덮는다.
    apply: ({ structure }) => {
      if (structure) {
        applyMetaParams(m);
        applyMetaVibes(m);
      } else {
        applyMeta(m, "all");
      }
    },
  });
  useUi.getState().setMode("generate");
  // ★새 탭의 씬 줄은 탭이 바뀔 때 고른 것을 놓는다 — 그 뒤에 세워야 남는다 (Canvas 와 같다)
  if (landed) useSceneFocus.getState().focus(landed.cell, landed.file);
  toast(t("act.cloned"));
}

/** 메타데이터를 지금 작업 상태로 되돌린다 — 프롬프트·캐릭터·생성 설정 전부.
 *
 *  ★블록 하나에 통째로 넣는다. 원래 어떤 블록으로 나뉘어 있었는지는 이미지에 안 남아 있고
 *    (NAI 는 합쳐진 문자열만 저장한다), 임의로 쪼개면 사용자가 안 만든 구조가 생긴다. */

/** 그 그림의 **설정·해상도·시드만** 얹는다 (프롬프트는 안 건드린다).
 *
 *  ★「새 탭으로 복제」가 쓴다. 거기서 프롬프트·스타일·캐릭터·슬롯은 **그 그림이 나온 탭과
 *    씬에서 구조째** 가져오고(`cloneToNewTab`), 메타데이터에서는 값만 얹는다 —
 *    메타데이터에는 합쳐진 문자열만 남아 구조가 없기 때문이다 (사용자 지시 2026-08-19).
 *  ★표는 `lib/metaApply` **하나**를 쓴다. `applyMeta` 도 이 함수를 부른다. */
/** **무엇을 가져올까** — 밖에서 떨군 그림에서 골라 넣는다 (사용자 지시 2026-08-25).
 *
 *  ★★공홈(NovelAI)이 드롭할 때 내는 목록과 같은 갈래다: Prompt · Undesired Content ·
 *    Characters(+Append) · Settings · Seed. *"드롭했을 때 저렇게 항목을 선택해서 넣을 수
 *    있음. 해당 기능 추가."*
 *  ★`append` 는 **캐릭터에만** 걸린다 — 지금 있는 인물 뒤에 덧붙인다(끄면 갈아 끼운다).
 *    프롬프트·UC 는 덧붙일 자리가 없다 (한 덩이라 합치면 무엇이 원래 것인지 사라진다).
 *  ★고르지 않은 것은 **손대지 않는다.** 「없는 값을 기본값으로 되돌리지 않는다」와 같은 규칙이다. */
/** 고르는 항목·기본값은 `lib/metaApply` 에 있다 (설정 스토어가 저장한다) — 여기서는 다시 내보낼 뿐 */
export { PICK_ALL, PICK_DROP, type MetaPick } from "../lib/metaApply";

export function applyMetaParams(m: ImageMeta, seed = true) {
  const g = useGen.getState();
  // ★★값이 밖에서 갈리면 **그 자리를 펴고 강조한다** (사용자 지시 2026-08-19) —
  //   왼쪽 패널이 접혀 있으면 무엇이 바뀌었는지 알 길이 없다 (`Category` 의 `flashKey`)
  // ★★강조만 한다 — **데려가지 않는다** (사용자 지시 2026-08-21). 불러오면 여러 자리가
  //   한꺼번에 바뀌어서, 그때마다 화면이 움직이면 무엇이 바뀌었는지 오히려 못 본다.
  useUi.getState().reveal("left", "params", false);
  useUi.getState().reveal("left", "size", false);
  // ★★**모델이 먼저다** (사용자 지시 2026-08-30) — 나머지 값은 그 모델의 규격 위에 얹는다
  if (m.nai_model) g.set("model", m.nai_model);
  useGen.setState({ params: { ...useGen.getState().params, ...metaParams(m) } });
  if (m.width !== undefined) g.set("width", m.width);
  if (m.height !== undefined) g.set("height", m.height);
  /* ★시드는 **따로 고를 수 있다** (`MetaPick.seed`, 2026-08-25) — 설정은 가져오되 시드는
     그대로 두고 싶은 경우가 흔하다 (같은 조건으로 **다른 그림**을 뽑는 자리다). */
  if (seed && m.seed !== undefined) g.set("seed", m.seed);
  /* ★★캐릭터 좌표 켜짐은 **`lib/metaApply` 표에 안 넣는다** — 시드·해상도와 같은 사정이다
     (그 파일 머리 주석): 쓰는 자리마다 뜻이 다르다. 강화는 캐릭터를 `{prompt, uc}` 로만
     실어 보내기로 정해 둔 자리라(`EnhanceDialog.metaJob` 의 ★주, v2 `index.html:24472`),
     표에 넣으면 **자리 없이 좌표만 켜져** 인물 전원이 한가운데로 겹친다.
     여기(갤러리의 「설정 불러오기」)는 `applyMetaInner` 가 자리까지 되살리므로 뜻이 맞는다. */
  if (m.use_coords !== undefined) g.set("use_coords", m.use_coords);
  // ★★**시드 규칙(고정/한 바퀴/씬마다)은 건드리지 않는다** (사용자 지시 2026-08-21).
  //   예전에는 시드를 되살리면 「고정」으로 바꿨는데, 그러면 사용자가 골라 둔 규칙이
  //   그림 하나 불러올 때마다 말없이 뒤집힌다. 값만 넣고 규칙은 사용자 것으로 둔다
  //   (그 시드로 다시 뽑고 싶으면 「고정」은 바로 옆에서 누를 수 있다).
}

/** 그 그림의 **바이브**를 되살린다 (인코딩이 남아 있어 다시 굽지 않는다).
 *
 *  ★이미지 입력도 **「그 그림을 뽑은 환경」의 일부**다 — 「새 탭으로 복제」도 이것을 부른다
 *    (사용자 지시 2026-08-19: 환경을 그대로 옮겨 이어서 쓰는 기능이다). */
export function applyMetaVibes(m: ImageMeta) {
  // ★바이브는 **인코딩으로** 되살린다 (v2 index.html:18114-18150).
  //
  //  그림 자체는 메타데이터에 없고 구워진 인코딩만 남아 있다. 그 인코딩이 곧 쓸 수 있는
  //  물건이라, 모델과 정보추출을 함께 실어 두면 **다시 굽지 않고** 그대로 나간다 (무료).
  //  ★그림 자리에는 1×1 투명 PNG 를 둔다 (v2 와 같다). 빈 문자열을 두면 모델을 바꿨을 때
  //    재인코딩이 빈 그림을 열다 죽는다.
  //  ★`map` 으로 기존 목록을 고치던 예전 방식은 **목록이 비어 있으면 아무것도 안 만들었다** —
  //    되살리기가 통째로 헛돌았다. 목록을 새로 만든다.
  //  ★세는 기준은 **인코딩(`images`)** 이다 (v2 `naiVibes.images.length`). 강도 배열로 세면
  //    인코딩이 없는 자리에도 1×1 투명 PNG 짜리 항목이 생겨, 생성할 때 그 빈 그림을
  //    인코딩하려다 죽는다. 강도가 없는 자리는 v2 와 같이 0.6 으로 채운다.
  const vibes = m.nai_vibes;
  const im = useImageInput.getState();
  if (vibes?.images?.length) {
    const model = m.nai_model || "nai-diffusion-4-5-full";
    im.setVibeOn(true);
    im.setVibes(
      vibes.images.map((enc, i) => {
        const ie = vibes.info_extracted?.[i] ?? 1;
        return {
          image: BLANK_PNG,
          name: `NAI Vibe ${i + 1}`,
          strength: vibes.strengths?.[i] ?? 0.6,
          info_extracted: ie,
          encoded: enc,
          encoded_model: model,
          encoded_info_extracted: ie,
        };
      }),
    );
  } else if (im.vibes.length) {
    // ★바이브가 없는 그림의 설정을 적용하면 **들고 있던 바이브를 비운다** (v2 index.html:18153-18161).
    //   안 비우면 이 그림에 없던 바이브가 섞인 채로 생성돼, 「이 그림을 재현한다」가 어긋난다.
    im.setVibes([]);
    im.setVibeOn(false);
  }
}

/** 그 그림을 뽑을 때의 **베이스 이미지**(i2i·인페인트)를 되살린다.
 *
 *  ★★그림에는 안 남는다 — NAI 가 돌려주는 PNG 에 베이스 그림은 없다. 우리는 보낸 페이로드를
 *    통째로 기록해 두므로 서버가 거기서 꺼내 준다 (`/api/workspaces/{ws}/base`).
 *    사용자 지시 2026-08-22: 「설정 불러오기」가 되살리게 해 달라.
 *  ★**없으면 비운다** — 바이브와 같은 규칙이다 (위 `applyMetaVibes` 의 ★주). 안 비우면 이
 *    그림에 없던 베이스가 섞인 채로 생성돼 「이 그림을 재현한다」가 어긋난다.
 *  ★되살아나는 것은 **전처리된 그림**이다 (해상도에 맞춰 리샘플·레터박스된 것). 그대로 다시
 *    뽑으면 같은 결과가 나오고, 그게 이 기능의 목적이다.
 *  ★강도 슬라이더는 **둘**이다 (`backend/nai.py` 의 인페인트 절) — 한 값으로 합치지 말 것. */
export async function applyRecordedBase(
  got: {
    image?: string;
    mask?: string;
    mode?: string;
    strength?: number;
    noise?: number;
    inpaint_strength?: number;
  } | null,
  name: string,
) {
  const im = useImageInput.getState();
  if (!got?.image) {
    if (im.baseImage) im.clearBase();
    return;
  }
  im.setBase(got.image, name);
  // ★`setBase` 가 마스크를 비우므로 **그 뒤에** 넣는다
  im.patchBase({
    baseMode: got.mode === "inpaint" ? "inpaint" : "img2img",
    baseMask: got.mask ?? "",
    ...(got.strength !== undefined ? { baseStrength: got.strength } : null),
    ...(got.noise !== undefined ? { baseNoise: got.noise } : null),
    ...(got.inpaint_strength !== undefined
      ? { baseInpaintStrength: got.inpaint_strength }
      : null),
  });
  // ★그림이 들어간 자리를 펴고 강조한다 — 접혀 있으면 무엇이 바뀌었는지 알 길이 없다.
  //   ★데려가지는 않는다 (불러오기는 여러 자리가 한꺼번에 바뀌는 자리다)
  useUi.getState().reveal("left", "base", false);
}

/** @param what `prompt` = 프롬프트만 · `all` = 설정·시드·이미지 입력까지 (그 그림을 재현한다) */
export function applyMeta(m: ImageMeta, what: "prompt" | "all" | MetaPick = "all") {
  // ★★**보던 자리를 고정한다** (사용자 지시 2026-08-21). 불러오면 좌측 패널에서 여러 가지가
  //   한꺼번에 벌어져(묶음 펴짐·프롬프트 교체·강조) 내용 높이가 변하고, 그러면 보던 자리가
  //   위아래로 밀린다. 「데려가지 않기」만으로는 안 잡히는 움직임이라 값을 재서 되돌린다.
  const pick: MetaPick =
    what === "all"
      ? PICK_ALL
      : what === "prompt"
        ? { ...PICK_ALL, settings: false, seed: false }
        : what;
  keepScroll(LEFT_SCROLL, () => applyMetaInner(m, pick));
}

function applyMetaInner(m: ImageMeta, pick: MetaPick) {
  const p = usePrompt.getState();
  /* ★★**모델부터 바꾼다** (사용자 지시 2026-08-30: 생성한 모델로 일단 변경한 뒤 데이터를 덮을 것).
     모델마다 규격이 달라서(캐릭터 상한 6/32 · 자유 좌표 · 퀄리티 프리셋 · 바이브 유무) 옛 모델
     위에 새 모델의 프롬프트·캐릭터를 얹으면 상한에 걸려 꺼지거나 없는 스위치가 남는다.
     「생성 설정」을 안 골라도 모델은 이 체크 하나로 따로 간다. */
  if (pick.model && m.nai_model) useGen.getState().set("model", m.nai_model);

  const block = (label: string, body?: string) =>
    /* ★★`src` 를 함께 담는다 — 그 그림이 실제로 쓴 글자다. 칩을 안 건드리면 다시 뽑을 때
       **한 글자도 다르지 않게** 나간다 (`lib/blocks` 의 `Block.src`). */
    body ? [makeBlock(label, [], { tags: parseSegs(body), src: body, open: true })] : [];

  const chars: Char[] = (m.characters ?? []).map((c, i) => ({
    id: `c${Date.now().toString(36)}${i}`,
    ref: null,
    name: `#${i + 1}`,
    color: CHAR_COLOR,
    thumb: null,
    prompt: block("Character", c.prompt),
    uc: block("UC", c.negative),
    on: true,
    // ★자리가 없던 그림은 한가운데 (백엔드 기본값과 같다 — `charPos.DEFAULT_CENTER`)
    center: c.center ?? DEFAULT_CENTER,
    stack: [],
  })) as Char[];

  /* ★★**고른 것만 갈아 끼운다** (2026-08-25). 예전에는 셋을 통째로 실어 보냈는데,
     그러면 「프롬프트만 가져오기」가 캐릭터를 **지우는** 일이 된다 — 안 고른 자리는
     지금 값을 그대로 다시 넣어야 한다.
     ★`append` 는 캐릭터를 **뒤에 잇는다** (공홈의 Append 와 같다). */
  p.load({
    base: pick.prompt ? block("Prompt", m.prompt) : p.base,
    baseUc: pick.uc ? block("UC", m.negative) : p.baseUc,
    chars: pick.characters ? (pick.append ? [...p.chars, ...chars] : chars) : p.chars,
  });

  // ★프롬프트가 통째로 바뀐다 — 좌측 패널을 펴고 알린다 (사용자 지시 2026-08-13)
  //   ★데려가지는 않는다 (2026-08-21) — 불러오기는 여러 자리가 함께 바뀐다
  if (pick.prompt || pick.uc || pick.characters) useUi.getState().reveal("left", "prompt", false);

  // 설정 — 있는 것만 덮는다. 없는 값을 기본값으로 되돌리면 사용자가 잡아 둔 것이 날아간다.
  // ★어느 필드가 어느 설정인가는 `lib/metaApply` **하나**가 정한다 — 강화도 같은 표를 쓴다
  //   (`EnhanceDialog`, v2 `buildEnhanceRequest`). 두 벌이면 "이 그림 설정대로"가 두 화면에서
  //   조용히 달라진다.
  if (pick.settings) {
    applyMetaParams(m, pick.seed);
    applyMetaVibes(m);
  } else if (pick.seed && m.seed !== undefined) {
    // ★설정은 그대로 두고 **시드만** — 「같은 자리에서 그 장면을 다시」가 이 경우다
    useGen.getState().set("seed", m.seed);
  }
}

/** 1×1 투명 PNG — 인코딩만 있고 원본이 없는 바이브의 자리 그림 (v2 `placeholderImage`) */
const BLANK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** ★제목은 패널 머리글(Shell)이 이미 달고 있다 — 여기서 또 적으면 두 겹이 된다 */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, paddingTop: "var(--sp-3)" }}>
      {children}
    </div>
  );
}

/** 읽어 낸 메타데이터를 **보여 주는 몸통** — 값 표 · 프롬프트 · 네거티브 · 캐릭터.
 *
 *  ★★**보는 자리가 둘이라 여기 하나로 뒀다**: 갤러리의 그림 정보 패널과, 밖에서 떨군 그림의
 *    가져오기 시트(`app/DropImport`). v2 이식 계획이 못 박은 자리다
 *    (`docs/v2-feature-catalog.md`: *"드롭 가져오기 시트도 같은 컴포넌트를 재사용하면 창구가
 *    하나가 된다"*). 두 벌이면 한쪽에만 새 칸이 붙어 같은 그림이 자리마다 달리 보인다.
 *  ★스크롤과 여백은 **부르는 쪽**이 정한다 — 패널과 시트는 담기는 틀이 다르다. */
/** **재현되지 않는 그림임을 알린다** — 공홈과 같은 갈래 (`lib/reproWarn`).
 *
 *  ★★사용자 결정 2026-08-25: *"바이브만 살려 주고 공홈처럼 알림 붙이기."*
 *    되살릴 수 있는 것(바이브 인코딩)은 그대로 넣고, 못 되살리는 것은 **말해 준다.**
 *  ★막지 않는다 — 가져오기는 그대로 된다. 다만 **왜 그림이 달라지는지**를 미리 알린다. */
export function ReproNote({ meta }: { meta: Parameters<typeof reproWarn>[0] }) {
  const t = useI18n((s) => s.t);
  const why = reproWarn(meta);
  if (!why) return null;
  const label = {
    img2img: "drop.reproImg2img",
    inpainting: "drop.reproInpainting",
    vibeNoEncoding: "drop.reproVibeNoEncoding",
    preciseRef: "drop.reproPreciseRef",
  }[why];
  return (
    <div
      data-repro-warn={why}
      style={{
        display: "flex",
        gap: "var(--sp-2)",
        padding: "var(--sp-2) var(--sp-3)",
        borderRadius: "var(--r-2)",
        border: "1px solid color-mix(in srgb, var(--warn) 35%, var(--line))",
        background: "color-mix(in srgb, var(--warn) 10%, transparent)",
        fontSize: "var(--text-2xs)",
        color: "var(--ink-dim)",
        lineHeight: 1.5,
      }}
    >
      {t("drop.reproNo", { why: t(label) })}
    </div>
  );
}

export function MetaBody({ m }: { m: ImageMeta }) {
  const t = useI18n((s) => s.t);
  return (
    <>
      {/* ★값보다 **먼저** — 이 그림이 그대로 안 나온다는 것을 알고 읽어야 한다 */}
      <ReproNote meta={m} />
      <Grid>
        {m.seed !== undefined && <Field k={t("gallery.fieldSeed")} v={String(m.seed)} mono />}
        {m.steps !== undefined && <Field k={t("gallery.fieldSteps")} v={String(m.steps)} mono />}
        {m.cfg !== undefined && <Field k={t("gallery.fieldCfg")} v={String(m.cfg)} mono />}
        {m.width !== undefined && <Field k={t("gallery.fieldSize")} v={`${m.width}×${m.height}`} mono />}
        {m.sampler && <Field k={t("gallery.fieldSampler")} v={m.sampler} />}
        {m.scheduler && <Field k={t("gallery.fieldScheduler")} v={m.scheduler} />}
      </Grid>
      {(m.source || m.nai_model) && <Field k={t("gallery.fieldModel")} v={m.source || m.nai_model!} />}

      <Text label={t("gallery.fieldPrompt")} body={m.prompt} mark="prompt" />
      <Text label={t("gallery.fieldNegative")} body={m.negative} dim mark="negative" />

      {!!m.characters?.length && (
        <>
          <Label>{t("gallery.fieldCharacters")}</Label>
          {m.characters.map((c, i) => (
            <div
              key={i}
              style={{
                marginBottom: "var(--sp-2)",
                padding: "var(--sp-2) var(--sp-3)",
                borderRadius: "var(--r-2)",
                background: "var(--surface2)",
                fontSize: "var(--text-2xs)",
                color: "var(--ink-dim)",
                lineHeight: 1.5,
                wordBreak: "break-word",
              }}
            >
              {c.prompt || "—"}
              {c.negative && <div style={{ marginTop: 2, color: "var(--ink-faint)" }}>− {c.negative}</div>}
            </div>
          ))}
        </>
      )}
    </>
  );
}

const Grid = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-1) var(--sp-3)" }}>
    {children}
  </div>
);

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ padding: "3px 0", minWidth: 0 }}>
      <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{k}</div>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ink-soft)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        data-tip={v}
      >
        {v}
      </div>
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      marginTop: "var(--sp-3)",
      marginBottom: "var(--sp-1)",
      fontSize: "var(--text-2xs)",
      color: "var(--ink-faint)",
    }}
  >
    {children}
  </div>
);

/** 글 한 덩이 — ★**복사 단추가 딸린다** (사용자 지시 2026-08-25: *"갤러리의 메타데이터의
 *  각 프롬프트에 복사 버튼 추가"*). 프롬프트를 다른 데로 옮기려면 지금까지는 끌어 골라야
 *  했는데, 여러 줄이라 자주 어긋났다. */
function Text({ label, body, dim, mark }: { label: string; body?: string; dim?: boolean; mark?: string }) {
  const t = useI18n((s) => s.t);
  if (!body) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(body);
    toast(t("act.copied"));
  };
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          marginTop: "var(--sp-3)",
          marginBottom: "var(--sp-1)",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
          {label}
        </span>
        <button
          data-gallery-copy={mark}
          onClick={copy}
          data-tip={t("act.copy")}
          style={{ display: "grid", color: "var(--ink-faint)", padding: "0 2px" }}
        >
          {Icon.copy}
        </button>
      </div>
      <div
        data-gallery-field={mark}
        style={{
          padding: "var(--sp-2) var(--sp-3)",
          borderRadius: "var(--r-2)",
          background: "var(--surface2)",
          fontSize: "var(--text-2xs)",
          lineHeight: 1.55,
          color: dim ? "var(--ink-faint)" : "var(--ink-dim)",
          wordBreak: "break-word",
        }}
      >
        {body}
      </div>
    </>
  );
}
