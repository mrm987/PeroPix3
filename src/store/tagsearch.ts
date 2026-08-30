import { create } from "zustand";
import { api } from "../lib/backend";
import { t } from "../i18n";
import { appendToLast, hasTag, tallyTags, type IndexEntry, type TagHit } from "../lib/tagSearch";
import { usePrompt } from "./prompt";
import { useBlockLib } from "./blockLib";
import { toast } from "./toast";

/** 태그 검색 서랍의 상태 (사용자 지시 2026-08-31).
 *
 *  ★인덱스는 **열 때마다 증분으로 훑는다** (`rebuild`) — 그 사이 생성된 그림이 들어오게. 바뀐 것이
 *    없으면 stat 만 하므로 금방 끝난다. 첫 훑기만 오래 걸리고, 그동안 진행이 서랍에 보인다.
 *  ★집계(`tallyTags`)는 곁파일을 받은 뒤 **화면이** 한다 — 백엔드는 쪼개지 않는다.
 *  ★블록 저장소 서랍과 **같은 자리**에 열리므로 하나가 열리면 다른 하나는 닫는다. */
export type IndexStatus = { running: boolean; done: number; total: number; error: string; built: number };

type S = {
  open: boolean;
  loaded: boolean;
  busy: boolean;
  status: IndexStatus | null;
  files: Record<string, IndexEntry>;
  tags: Map<string, TagHit>;
  query: string;
  artistOnly: boolean;
  /** 눌러 둔 태그 — 그 태그가 쓰인 그림이 아래 격자에 나온다 */
  pick: string | null;
  /** 크게 보는 그림 (아웃풋 루트 기준 경로) */
  view: string | null;
  setOpen: (v: boolean) => void;
  setQuery: (q: string) => void;
  setArtistOnly: (v: boolean) => void;
  setPick: (tag: string | null) => void;
  setView: (rel: string | null) => void;
  load: () => Promise<void>;
  rebuild: () => Promise<void>;
  /** 베이스 맨 아래에 붙인다 (사용자 결정 2026-08-31). 이미 있으면 안 붙이고 알린다 */
  add: (tag: string) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const useTagSearch = create<S>((set, get) => ({
  open: false,
  loaded: false,
  busy: false,
  status: null,
  files: {},
  tags: new Map(),
  query: "",
  artistOnly: false,
  pick: null,
  view: null,

  setOpen(v) {
    set({ open: v, view: null });
    if (v) {
      useBlockLib.getState().setOpen(false);
      void get().rebuild();
    }
  },
  setQuery: (query) => set({ query }),
  setArtistOnly: (artistOnly) => set({ artistOnly }),
  setPick: (pick) => set({ pick }),
  setView: (view) => set({ view }),

  async load() {
    const d = await api<{ files: Record<string, IndexEntry> }>("/api/tags/data");
    set({ files: d.files, tags: tallyTags(d.files), loaded: true });
  },

  async rebuild() {
    if (get().busy) return;
    set({ busy: true });
    try {
      await api("/api/tags/index", { method: "POST" });
      for (;;) {
        const st = await api<IndexStatus>("/api/tags/status");
        set({ status: st });
        if (!st.running) break;
        await sleep(500);
      }
      await get().load();
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      set({ busy: false });
    }
  },

  add(tag) {
    const p = usePrompt.getState();
    if (hasTag(p.base, tag)) {
      toast(t("tagsearch.dup", { tag }), "warn");
      return;
    }
    p.update("base", (bs) => appendToLast(bs, tag));
    toast(t("tagsearch.added", { tag }));
  },
}));
