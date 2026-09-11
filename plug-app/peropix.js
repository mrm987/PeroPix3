/* PeroPix 플러그인 창구 — 한 줄 넣으면 앱에 말을 걸 수 있다.
 *
 *     <script src="/plug/_app/peropix.js"></script>
 *
 *     await peropix.action("add_style_card", { ... });   // 앱 액션 (조수가 쓰는 것과 같은 목록)
 *     const st = await peropix.state();                  // 지금 화면 주소 (워크스페이스·탭·씬…)
 *     const sc = await peropix.scene();                   // 지금 씬의 살아 있는 블록 { base, chars }
 *     peropix.toast("넣었습니다");                        // 앱 알림
 *     const c = await peropix.theme("--accent");          // 앱 토큰 값 (이름 없이 부르면 "dark" | "light")
 *     peropix.onTheme((name) => …);                      // 테마가 바뀔 때
 *     const lang = await peropix.locale();                // 지금 앱 언어 ("ko" | "en" | "ja")
 *     peropix.onLocale((lang) => …);                     // 앱 언어가 바뀔 때 — 자기 문구를 다시 그린다
 *     await peropix.openCanvas();                        // 이 플러그인을 캔버스에 꺼내 맨 앞으로
 *     const me = await peropix.plugin();                 // 내 매니페스트
 *
 * ★이 배관(postMessage·id 짝맞추기·시간 제한)을 플러그인마다 복사하던 것을 앱이 대신 준다 (사용자 지시 2026-09-10: 개발을 간단하게).
 * ★앱 밖(그냥 브라우저)에서 열면 부를 앱이 없다 — `peropix.inApp` 이 false 이고, 호출은 `{ ok: false }` 로 조용히 돌아온다.
 *   그래야 제작자가 크롬에서 페이지를 만들다가 앱 호출에서 멈추지 않는다.
 */
(function () {
  "use strict";
  var seq = 0;
  var pending = new Map();
  var themeHandlers = [];
  var localeHandlers = [];
  var inApp = window.parent !== window;

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.type !== "peropix") return;
    if (d.event === "theme") {
      themeHandlers.forEach(function (fn) {
        try { fn(d.theme); } catch (err) { console.error("[peropix] onTheme", err); }
      });
      return;
    }
    if (d.event === "locale") {                                   // 앱 설정에서 언어를 바꿨다
      document.documentElement.lang = d.locale;
      localeHandlers.forEach(function (fn) {
        try { fn(d.locale); } catch (err) { console.error("[peropix] onLocale", err); }
      });
      return;
    }
    if (d.event === "font") { applyFont(d.font); return; }        // 앱 설정에서 글꼴을 바꿨다
    if (d.event === "scale") { applyScale(d.scale); return; }     // 앱 설정에서 글자 크기를 바꿨다
    var slot = pending.get(d.id);
    if (slot) {
      pending.delete(d.id);
      slot(d);
    }
  });

  /** 앱에 한 마디 보내고 답을 기다린다 → `{ ok, result?, error? }` */
  function call(msg) {
    if (!inApp) return Promise.resolve({ ok: false, error: "앱 밖에서 열렸습니다" });
    return new Promise(function (resolve) {
      var id = ++seq;
      pending.set(id, resolve);
      parent.postMessage(Object.assign({ type: "peropix", id: id }, msg), "*");
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ ok: false, error: "앱이 답하지 않습니다" });
        }
      }, 20000);
    });
  }

  /** 답에서 알맹이만 꺼낸다 — 실패는 예외로 올린다 (`await` 한 자리에서 try/catch 하면 된다) */
  function unwrap(p) {
    return p.then(function (r) {
      if (r && r.ok) return r.result;
      throw new Error((r && r.error) || "실패");
    });
  }

  window.peropix = {
    /** 앱 안에서 열렸나 — false 면 앱 호출이 전부 실패로 돌아온다 */
    inApp: inApp,
    /** 낮은 층 창구 — 위의 것으로 안 되는 것을 직접 부를 때 */
    call: call,
    action: function (name, args) { return unwrap(call({ call: "action", name: name, args: args || {} })); },
    state: function () { return unwrap(call({ call: "state" })); },
    /** 지금 씬의 **살아 있는** 블록 — `{ base, chars }` (블록마다 id). 저장을 기다리지 않는다 */
    scene: function () { return unwrap(call({ call: "scene" })); },
    plugin: function () { return unwrap(call({ call: "plugin" })); },
    openCanvas: function (id) { return call({ call: "openCanvas", name: id }); },
    toast: function (text) { return call({ call: "toast", text: String(text) }); },
    /** 앱 토큰 값 (`"--accent"`). 이름 없이 부르면 지금 테마 이름 */
    theme: function (name) { return unwrap(call({ call: "theme", name: name || "" })); },
    /** 앱 번역 (`t("plugins.install")`) */
    t: function (key, args) { return unwrap(call({ call: "t", key: key, args: args })); },
    /** 지금 앱 언어 — `"ko"` | `"en"` | `"ja"`. 앱 밖에서는 브라우저 언어로 떨어진다 */
    locale: function () {
      return call({ call: "locale" }).then(function (r) {
        return (r && r.ok && r.result) || (navigator.language || "en").slice(0, 2);
      });
    },
    /** 테마가 바뀔 때 부른다 → 끊는 함수 */
    onTheme: function (fn) {
      themeHandlers.push(fn);
      return function () { themeHandlers = themeHandlers.filter(function (x) { return x !== fn; }); };
    },
    /** 앱 언어가 바뀔 때 부른다 → 끊는 함수. 받은 자리에서 자기 문구를 다시 그리면 된다 */
    onLocale: function (fn) {
      localeHandlers.push(fn);
      return function () { localeHandlers = localeHandlers.filter(function (x) { return x !== fn; }); };
    },
  };

  // ── 글꼴을 앱과 같게 (사용자 지시 2026-09-11) ──────────────────────────────
  // ★플러그인 화면은 다른 오리진의 문서라 앱이 대신 그려 줄 수 없다. 대신 **앱이 번들한 것과 같은 글꼴 파일**이
  //   플러그인 오리진에도 있고(`base.css` 가 `fonts.css` 를 싣는다), 앱 **설정에서 고른 것**을 여기서 꽂는다.
  //   앱에서 글꼴을 바꾸면 `font` 알림이 와서 따라온다. 앱 밖(그냥 브라우저)에서는 base.css 의 기본값 그대로다.
  function applyFont(stack) {
    if (!stack || typeof stack !== "string") return;
    document.documentElement.style.setProperty("--font-sans", stack);
  }
  /** 글자 크기 — 앱 설정의 `--text-scale` 을 그대로 쓴다 (base.css 의 `--text-*` 가 여기에 곱해진다) */
  function applyScale(v) {
    var n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return;
    document.documentElement.style.setProperty("--text-scale", String(n));
  }
  if (inApp) {
    call({ call: "theme", name: "--font-sans" }).then(function (r) {
      if (r && r.ok) applyFont(r.result);
    });
    call({ call: "theme", name: "--text-scale" }).then(function (r) {
      if (r && r.ok) applyScale(r.result);
    });
  }
})();
