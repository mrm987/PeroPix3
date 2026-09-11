/** 플러그인 페이지가 쓸 글꼴을 `plug-app/fonts/` 로 추려 넣고 `plug-app/fonts.css` 를 만든다.
 *
 *  ★★왜 복사가 필요한가 — 플러그인 화면은 **다른 오리진의 문서**라(백엔드가 서빙한다) 앱이 대신 그려 줄 수 없고,
 *    앱의 글꼴은 Tauri 가 프런트 번들과 함께 **exe 안에 묻는다**(`frontendDist: "../dist"`). 디스크에 파일로 없으니
 *    백엔드가 꺼내 줄 수도 없다. 그래서 플러그인 오리진(`/plug/_app/`)에도 같은 파일을 둔다.
 *  ★앱이 쓰는 굵기(400·500·700)와 한국어·라틴 묶음만 가져온다 — `@fontsource` 의 번호 subset 을 전부 담으면
 *    파일이 666개·11MB 다. 묶음 파일은 유니코드 범위가 없어 **한국어 것을 먼저** 적고 라틴을 뒤에 적는다
 *    (글자가 없으면 다음 면으로 넘어간다).
 *  ★Pretendard 는 가변 폰트 한 벌이 45~920 을 다 덮는다 — 앱이 쓰는 370·560 이 그대로 나온다.
 *
 *  쓰는 법: node scripts/sync-plug-fonts.mjs   (패키지를 올린 뒤 한 번)
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NM = path.join(REPO, "node_modules");
const OUT = path.join(REPO, "plug-app", "fonts");
const WEIGHTS = [400, 500, 700];

/** 한 벌 = { family, faces: [{ file, weight }] }. 순서가 곧 CSS 순서다 (한국어 먼저). */
const SETS = [
  {
    family: "Pretendard Variable",
    faces: [{ src: "pretendard/dist/web/variable/woff2/PretendardVariable.woff2", weight: "45 920", variations: true }],
  },
  {
    family: "Spoqa Han Sans Neo",
    faces: [
      { src: "spoqa-han-sans/Subset/SpoqaHanSansNeo/SpoqaHanSansNeo-Regular.woff2", weight: 400 },
      { src: "spoqa-han-sans/Subset/SpoqaHanSansNeo/SpoqaHanSansNeo-Medium.woff2", weight: 500 },
      { src: "spoqa-han-sans/Subset/SpoqaHanSansNeo/SpoqaHanSansNeo-Bold.woff2", weight: 700 },
    ],
  },
  {
    family: "Gothic A1",
    faces: WEIGHTS.flatMap((w) => ["korean", "latin"].map((sub) => ({
      src: `@fontsource/gothic-a1/files/gothic-a1-${sub}-${w}-normal.woff2`, weight: w,
    }))),
  },
  {
    family: "Noto Sans KR",
    faces: WEIGHTS.flatMap((w) => ["korean", "latin"].map((sub) => ({
      src: `@fontsource/noto-sans-kr/files/noto-sans-kr-${sub}-${w}-normal.woff2`, weight: w,
    }))),
  },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const css = [
  "/* 플러그인 페이지용 글꼴 — `scripts/sync-plug-fonts.mjs` 가 만든다. 손으로 고치지 말 것.",
  " * 앱이 번들한 것과 **같은 파일**이고, 앱 설정에서 고른 글꼴을 `peropix.js` 가 `--font-sans` 에 꽂는다.",
  " * 라이선스: Pretendard·Spoqa Han Sans·Gothic A1·Noto Sans KR 전부 SIL OFL 1.1 (`src/styles/fonts.css` 의 주 참조). */",
  "",
];
let files = 0, bytes = 0;
for (const set of SETS) {
  for (const f of set.faces) {
    const from = path.join(NM, f.src);
    if (!existsSync(from)) throw new Error(`글꼴 파일이 없습니다 (npm i 를 먼저): ${f.src}`);
    const name = path.basename(from);
    copyFileSync(from, path.join(OUT, name));
    files += 1;
    bytes += statSync(from).size;
    css.push("@font-face {");
    css.push(`  font-family: "${set.family}";`);
    css.push("  font-style: normal;");
    css.push(`  font-weight: ${f.weight};`);
    css.push("  font-display: swap;");
    css.push(`  src: url("./fonts/${name}") format("${f.variations ? "woff2-variations" : "woff2"}");`);
    css.push("}");
  }
}
writeFileSync(path.join(REPO, "plug-app", "fonts.css"), css.join("\n") + "\n", "utf8");
console.log(`plug-app/fonts: 파일 ${files}개 · ${(bytes / 1e6).toFixed(2)}MB`);
console.log("plug-app/fonts.css 를 새로 썼습니다:", readdirSync(OUT).length, "개 파일 참조");
