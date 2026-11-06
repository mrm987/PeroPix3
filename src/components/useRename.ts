import { useEffect, useRef, useState } from "react";
import { useWin } from "../lib/floatWin";

/** 이름 고치기 — **앱에 하나뿐인 규칙** (사용자 지시 2026-08-20:
 *  *"편집버튼도 모든 편집버튼이 각각 만들어서 일관성이 보장이 안되잖아.
 *  한번 더 누르면 편집종료하게 해줘. 스타일 이름 수정이랑 똑같게"*).
 *
 *  자리마다 따로 만들었더니 카드 배너만 「다시 누르면 끝」이고, 블록과 씬은 **여는 단추**라
 *  눌러도 아무 일이 없었다. 이제 그 동작이 여기 한 곳에 있다:
 *
 *   - 단추 = **토글**. 고치는 중에 다시 누르면 **저장하고 끝낸다**.
 *   - `Enter` = 저장하고 끝 · `Esc` = 버리고 끝 · 밖을 누르면(blur) 저장하고 끝.
 *   - 이름이 비면 저장하지 않는다 (빈 이름은 이 앱에 없다).
 *
 *  ★★**단추를 누를 때 입력칸이 먼저 흐려지지 않게 막는다**(`btnProps.onMouseDown`).
 *    blur 가 먼저 오면 저장하고 닫힌 **뒤에** 클릭이 다시 열어, 단추가 안 먹는 것처럼 보인다.
 *
 *  @param ctrl 여닫는 상태를 **밖에서** 들고 있을 때 (씬 이름은 `Tab` 으로 옆 씬으로
 *              건너뛰므로 누가 열려 있는지를 줄이 알아야 한다)
 */
export function useRename(
  name: string,
  onRename?: (v: string) => void,
  ctrl?: { editing: boolean; setEditing: (v: boolean) => void },
) {
  const win = useWin();
  const [selfOn, setSelfOn] = useState(false);
  const on = ctrl ? ctrl.editing : selfOn;
  const setOn = ctrl ? ctrl.setEditing : setSelfOn;
  const [draft, setDraft] = useState(name);

  // 열릴 때마다 **지금 이름**으로 초안을 잡는다 (그 사이 이름이 바뀌었을 수 있다)
  useEffect(() => {
    if (on) setDraft(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== name) onRename?.(v);
    live.current.done = true;
    setOn(false);
  };
  const cancel = () => {
    // ★버리고 나가는 길은 **`Esc` 하나**다 (사용자 지시 2026-08-28)
    live.current.done = true;
    setOn(false);
  };
  const toggle = () => (on ? commit() : setOn(true));

  /** ★★**밖을 눌러도, 칸이 사라져도 적은 것은 남는다** (사용자 지시 2026-08-28:
   *  *"텍스트 편집창들 편집하다가 다른 데 눌러서 해제하면 편집 취소가 아니고 그대로
   *  저장되어야 함. Esc 만 취소."*).
   *
   *  `blur` 하나에 기대고 있었는데 그것이 **두 자리에서 안 온다**:
   *   ① 칩·끌기 손잡이처럼 `pointerdown` 의 기본 동작을 막는 표면을 누르면 초점이 안 빠진다.
   *   ② 리액트의 `onBlur` 은 **언마운트에는 오지 않는다** — 줄이 접히거나 화면이 바뀌면
   *      치던 이름이 그대로 사라졌다. 그것이 「취소된 것처럼 보이는」 정체다.
   *  그래서 바깥 누름을 직접 듣고, 사라질 때도 한 번 담는다. */
  const live = useRef({ on, draft, name, onRename, done: false });
  live.current.on = on;
  live.current.draft = draft;
  live.current.name = name;
  live.current.onRename = onRename;
  useEffect(() => {
    if (on) live.current.done = false;
  }, [on]);
  useEffect(
    () => () => {
      const l = live.current;
      if (!l.on || l.done) return;
      const v = l.draft.trim();
      if (v && v !== l.name) l.onRename?.(v);
    },
    [],
  );
  useEffect(() => {
    if (!on) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      // 자기 칸과 연필 단추는 비켜 간다 (단추는 눌러서 끝내는 길이 따로 있다)
      if (t?.closest?.("[data-rename-input]") || t?.closest?.("[data-rename-btn]")) return;
      commit();
    };
    const doc = win.document;
    doc.addEventListener("pointerdown", onDown, true);
    return () => doc.removeEventListener("pointerdown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, draft, win]);

  return {
    editing: on,
    toggle,
    cancel,
    commit,
    /** 이름 칸에 그대로 펴 넣는다 (`style` 은 자리마다 다르므로 여기서 안 준다) */
    inputProps: {
      "data-rename-input": "",
      autoFocus: true,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
      // 카드·줄을 누른 것으로 새지 않게 (누르면 접히거나 골라지는 자리들이다)
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      onBlur: commit,
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") cancel();
      },
    },
    /** 연필 단추에 그대로 펴 넣는다 */
    btnProps: {
      "data-rename-btn": "",
      onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        toggle();
      },
    },
  };
}
