/** NAI 실패를 사람이 읽을 문구로 바꾼다. 생성(큐)과 업스케일이 같이 쓴다.
 *
 *  ★백엔드는 NAI 가 준 응답 본문을 그대로 실어 보낸다 (`nai.py` 의 `NAI API {상태}: {본문}`).
 *    NAI 앞단의 Cloudflare 가 막거나 게이트웨이가 죽으면 본문이 HTML 페이지라서, 그대로 띄우면
 *    사용자에게 코드가 보인다 (제보 2026-11-07).
 *  ★바꾸는 것은 화면 문구뿐이다. 원문은 백엔드 로그(`[queue] 생성 실패`)에 그대로 남는다.
 *  ★`t` 를 인자로 받는 이유: 이 파일을 node 로 바로 돌려 판정하기 위해서다 (`naiError.test.ts`).
 */
const NAI_FAIL = /\b([45]\d{2}):\s*([\s\S]*)$/;
const HTML_BODY = /^<(?:!doctype|html)\b/i;

/** NAI 의 JSON 오류(`{"statusCode":400,"message":"…"}`)에서 메시지만 꺼낸다 */
function jsonMessage(body: string): string | null {
  try {
    const d = JSON.parse(body) as { message?: unknown };
    return typeof d.message === "string" ? d.message : null;
  } catch {
    return null;
  }
}

/** @param other 뜻을 아는 실패가 아닐 때 정돈한 글을 어떻게 보일지 (생성은 「생성 실패:」를 붙인다) */
export function naiErrorText(
  raw: string,
  t: (key: string) => string,
  other: (msg: string) => string = (m) => m,
): string {
  const hit = NAI_FAIL.exec(raw);
  // ★상태를 읽었으면 상태만 본다. 본문의 숫자(그림 크기 등)를 상태로 오해하면 엉뚱한 안내가 나간다
  const status = hit ? hit[1] : raw;
  if (/\b402\b/.test(status)) return t("queue.err402");
  if (/\b401\b/.test(status)) return t("queue.err401");
  if (/\b429\b/.test(status)) return t("queue.err429");
  if (!hit) return other(raw);

  const code = Number(hit[1]);
  const body = hit[2].trim();
  if (HTML_BODY.test(body)) {
    // ★NAI 자신의 오류는 JSON 이다 (실측: 401 `{"statusCode":401,"message":"Unauthorized"}`). HTML 이면 앞단이 답한 것이다
    if (code === 403) return t("queue.errBlocked");
    if (code >= 500) return t("queue.errServer");
    const title = /<title[^>]*>([^<]*)/i.exec(body)?.[1].trim();
    return other(`NAI ${code}${title ? `: ${title}` : ""}`);
  }
  return other(`NAI ${code}: ${jsonMessage(body) ?? body}`);
}
