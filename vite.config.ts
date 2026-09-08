import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** 글꼴의 **안 읽히는 형식을 버린다** (사용자 지시 2026-08-27: *"안 쓰면 다 빼"*).
 *
 *  ★★`@fontsource`·Spoqa 의 CSS 는 한 얼굴을 **woff2 · woff · ttf** 세 벌로 적어 둔다.
 *    옛 브라우저를 위한 배려인데, 우리 웹뷰는 **언제나 맨 앞의 woff2 를 가져간다** —
 *    나머지 두 벌은 실행 파일 안에 실려만 있고 **한 번도 안 읽힌다** (실측 13.7MB).
 *  ★★**woff2 가 같은 줄에 있을 때만** 버린다. 어떤 얼굴이 ttf 로만 있다면 그건 남긴다 —
 *    안 그러면 그 글꼴이 통째로 안 뜬다.
 *  ★`enforce: "pre"` — 뷔트가 `url()` 을 자산으로 바꾸기 **전에** 지워야 파일이 안 생긴다.
 */
function woff2Only(): Plugin {
  /** 한 `src:` 줄에서 woff2 만 남긴다 (woff2 가 그 줄에 있을 때만). */
  const trim = (css: string) =>
    css.replace(/src\s*:\s*([^;}]+)/g, (whole, list: string) => {
      const parts = list.split(",").map((s) => s.trim()).filter(Boolean);
      const isW2 = (p: string) => /\.woff2([?#'")]|$)/.test(p);
      if (!parts.some(isW2)) return whole;               // woff2 가 없는 얼굴은 손대지 않는다
      const kept = parts.filter((p) => isW2(p) || !/url\(/.test(p));
      return kept.length === parts.length ? whole : `src: ${kept.join(", ")}`;
    });

  return {
    name: "woff2-only",
    /** ★★**산출물 단계에서 한다.** 글꼴 CSS 는 `@import` 로 node_modules 에서 딸려 오는데,
     *  그 합치기는 뷔트의 CSS 처리 **안에서** 일어나 `transform` 으로는 손이 안 닿는다
     *  (실측 2026-08-27: `pre` 훅으로 해 봤더니 676개가 그대로 나왔다). 다 만들어진 뒤에
     *  줄을 고치고, **아무도 안 가리키게 된 파일을 뺀다.** */
    generateBundle(_opts, bundle) {
      for (const f of Object.values(bundle)) {
        if (f.type === "asset" && f.fileName.endsWith(".css") && typeof f.source === "string")
          f.source = trim(f.source);
      }
      // 어느 글꼴 파일이 아직 이름으로 불리나 — CSS·JS 를 통틀어 훑는다
      const named = new Set<string>();
      for (const f of Object.values(bundle)) {
        const text = f.type === "asset" ? (typeof f.source === "string" ? f.source : "") : f.code;
        for (const m of text.matchAll(/[A-Za-z0-9_.-]+\.(?:woff2|woff|ttf|otf)/g)) named.add(m[0]);
      }
      let dropped = 0;
      for (const name of Object.keys(bundle)) {
        const base = name.split("/").pop()!;
        if (/\.(woff|ttf|otf)$/.test(base) && !named.has(base)) {
          delete bundle[name];
          dropped++;
        }
      }
      if (dropped) this.info(`글꼴 중복본 ${dropped}개 뺌 (웹뷰가 안 읽는 형식)`);
    },
  };
}

// Tauri 가 기대하는 고정 포트. 실패 시 조용히 다른 포트로 옮겨가면
// 창이 빈 화면으로 뜨므로 strictPort 로 못 박는다.
export default defineConfig({
  plugins: [react(), woff2Only()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    /* ★★**큰 폴더는 감시에서 뺀다** (2026-09-05 실측: 앱이 무한 로딩·빈 화면). 뷔트는 기본으로
       `node_modules`·`.git` 만 빼고 프로젝트 전체를 감시하는데, 웹뷰 캐시(`webview`, 18,000개 파일이
       앱이 켜진 동안 계속 바뀐다)·Rust 산출물(`src-tauri/target`, 16,000개)·작업 폴더·임시 폴더까지
       46,000여 개를 감시하다 이벤트 루프가 막혀 `main.tsx` 한 장에 16초, 그 다음 모듈은 응답이 없었다.
       같은 요청이 이 목록을 넣으면 0.2~1초다. 코드(`src`)·`public`·`index.html` 은 그대로 감시한다. */
    watch: {
      ignored: [
        "**/webview/**", "**/src-tauri/**", "**/workspaces/**", "**/models/**", "**/gallery/**",
        "**/_tmp/**", "**/_archive/**", "**/_dist/**", "**/dist/**", "**/logs/**", "**/backend/**",
        // ★플러그인 폴더 — 감시하면 chokidar 가 폴더마다 핸들을 쥐어 **삭제·이름 바꾸기가 거부된다**
        //   (실측 2026-09-08: 관리 탭의 삭제가 휴지통 코드 120(DE_ACCESSDENIEDSRC)·rename 액세스 거부. Vite 를
        //   내리면 바로 풀렸다). 백엔드가 서빙하는 자리라 Vite 가 볼 일도 없다.
        "**/plugins/**", "**/plugins-official/**",
      ],
    },
  },
  build: {
    target: "chrome110",
    // ★배포판에는 개발자 도구가 없어 **소스맵을 아무도 안 읽는다** (실측 3.3MB).
    //   디버깅이 필요하면 그때 켜서 한 번 빌드하면 된다 (사용자 지시 2026-08-27:
    //   *"안 쓰면 다 빼. 나중에 쓸 일 생기면 추가하면 됨"*).
    sourcemap: false,
  },
});
