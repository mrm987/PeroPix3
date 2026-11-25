"""그림 한 장의 **무거운 기록** — 워크스페이스마다 `records.db` 하나 (사용자 결정 2026-09-30).

색인(`records.jsonl`)은 화면이 워크스페이스를 열 때마다 통째로 읽는 가벼운 줄이고, 그림 한 장의
무거운 것(`resolved`·`env`)은 여기 있다. 둘을 잇는 것은 열쇠(`key`)다.

★★왜 JSONL 곁파일(`records-env.jsonl`)을 버렸나 (실측 2026-09-30, 그림 10만 장 · 곁파일 5.4GB):
  · 한 장을 꺼내려면 파일을 끝까지 읽어야 했다 (4.4초). 여기서는 열쇠로 바로 꺼낸다 (0.1ms).
  · 지운 그림의 기록을 뺄 수 없어 파일이 줄지 않았다. 여기서는 줄을 지운다 (`forget`).
  · 같은 베이스 그림을 뽑을 때마다 다시 적었다 (설치본 343MB 중 서로 다른 그림은 98MB).
    여기서는 큰 문자열을 내용 해시로 **한 번만** 둔다 (`blob`).
★연결은 **쓸 때만 열고 바로 닫는다** (`connect`). 열어 두면 윈도우가 워크스페이스 폴더를 못
  옮긴다 (이름 바꾸기·지우기·탭 옮기기).
★그림 폴더에는 아무것도 안 만든다 — 워크스페이스당 파일 하나다 (곁파일 때와 같은 결정).

    rec(key, data)           그 그림의 무거운 것 (JSON). 큰 문자열은 `MARK + 해시` 로 바뀌어 있다
    blob(hash, data, b64)    큰 문자열 하나. base64 면 바이트로 풀어 둔다 (`b64`=1)
    uses(key, hash)          어느 기록이 어느 blob 을 쓰나 — 기록을 지울 때 남은 blob 을 가린다
    unread(line)             옛 곁파일에서 못 읽은 줄 (버리지 않는다)
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

NAME = "records.db"
#: 이보다 긴 문자열은 blob 으로 뺀다. 그림(base64)은 수십 KB 부터이고 프롬프트는 이보다 짧다
BIG = 4096
#: 기록 안에서 blob 을 가리키는 표식. ★NUL 로 시작하므로 사람이 쓴 글과 겹치지 않는다
MARK = "\0blob:"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS rec(key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blob(hash TEXT PRIMARY KEY, data BLOB NOT NULL, b64 INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS uses(key TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(key, hash));
CREATE INDEX IF NOT EXISTS uses_hash ON uses(hash);
CREATE TABLE IF NOT EXISTS unread(line BLOB NOT NULL);
"""

#: ★★기록에 남기지 않는 페이로드 값 — 바이브(`reference_image_multiple`)와 정밀 레퍼런스
#:  (`director_reference_images`)로 보낸 **그림 그 자체**다. 요청을 짤 때만 쓰이고(`nai.build_payload`)
#:  기록에서 다시 읽는 곳이 없다 (`gallery_base` 는 `image`·`mask`, `_sent_from_record` 는 모델·프리셋만 읽는다).
#:  ★남겨 두면 같은 레퍼런스를 쓰는 동안 그림마다 몇 MB 가 쌓인다
#:  (사용자 제보 2026-09-30: records-env.jsonl 2.86GB 중 99% 가 이 값이었고 부팅이 멈췄다).
#:  ★세기·설명 같은 짝 배열은 몇 바이트라 그대로 둔다 (어떤 설정으로 뽑았는지는 남는다).
#:  ★새로 적을 때(`server._generate_one`)와 옛 곁파일을 옮길 때(`Store.migrate_records`)가 함께 쓴다.
UNRECORDED = ("reference_image_multiple", "director_reference_images")


def recorded(payload: dict) -> dict:
    """기록에 남길 페이로드 — `UNRECORDED` 만 뺀 얕은 사본. 보낸 페이로드는 건드리지 않는다."""
    par = payload.get("parameters") if isinstance(payload, dict) else None
    if not isinstance(par, dict) or not any(k in par for k in UNRECORDED):
        return payload
    return {**payload, "parameters": {k: v for k, v in par.items() if k not in UNRECORDED}}


@contextmanager
def connect(d: Path):
    """그 워크스페이스의 기록 DB. 없으면 만든다. ★나올 때 **닫는다** (머리 주석).
    ★예외가 나면 이번에 쓴 것을 되돌린다 — 반쯤 쓴 기록이 남지 않는다."""
    con = sqlite3.connect(d / NAME, timeout=30)
    try:
        # ★표가 없을 때만 만든다 — 있는 것을 다시 선언하는 것만으로 파일에 쓰기가 일어났다 (읽기마다 쓰게 된다)
        if con.execute("SELECT count(*) FROM sqlite_master").fetchone()[0] == 0:
            # ★빈 파일일 때만 먹는다 — 지운 기록의 자리를 파일 크기에서 돌려줄 수 있게 (`forget`)
            con.execute("PRAGMA auto_vacuum=INCREMENTAL")
            con.executescript(_SCHEMA)
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def _keep(con: sqlite3.Connection, s: str, used: set[str]) -> str:
    """큰 문자열을 blob 으로 둔다 (이미 있으면 그대로). 해시를 돌려준다."""
    h = hashlib.sha1(s.encode("utf-8")).hexdigest()
    used.add(h)
    if con.execute("SELECT 1 FROM blob WHERE hash=?", (h,)).fetchone() is None:
        data, b64 = s.encode("utf-8"), 0
        # ★base64 는 바이트로 풀어 1/4 을 줄인다. 되감았을 때 **글자 그대로** 돌아오는 것만 푼다
        #   (`data:` 머리·줄바꿈이 섞인 것은 글자로 둔다)
        try:
            raw = base64.b64decode(s, validate=True)
            if base64.b64encode(raw).decode("ascii") == s:
                data, b64 = raw, 1
        except (binascii.Error, ValueError):
            pass
        con.execute("INSERT INTO blob VALUES(?,?,?)", (h, data, b64))
    return h


def _pack(con: sqlite3.Connection, obj, used: set[str]):
    if isinstance(obj, str):
        return MARK + _keep(con, obj, used) if len(obj) >= BIG else obj
    if isinstance(obj, dict):
        return {k: _pack(con, v, used) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_pack(con, v, used) for v in obj]
    return obj


def _unpack(con: sqlite3.Connection, obj, cache: dict[str, str]):
    if isinstance(obj, str):
        if not obj.startswith(MARK):
            return obj
        h = obj[len(MARK):]
        if h not in cache:
            row = con.execute("SELECT data, b64 FROM blob WHERE hash=?", (h,)).fetchone()
            if row is None:
                cache[h] = ""
            else:
                cache[h] = base64.b64encode(row[0]).decode("ascii") if row[1] else bytes(row[0]).decode("utf-8")
        return cache[h]
    if isinstance(obj, dict):
        return {k: _unpack(con, v, cache) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_unpack(con, v, cache) for v in obj]
    return obj


def _gc(con: sqlite3.Connection, hashes) -> None:
    """아무 기록도 안 쓰는 blob 을 뺀다."""
    for h in hashes:
        if con.execute("SELECT 1 FROM uses WHERE hash=? LIMIT 1", (h,)).fetchone() is None:
            con.execute("DELETE FROM blob WHERE hash=?", (h,))


def put(con: sqlite3.Connection, key: str, heavy: dict) -> None:
    """그 열쇠의 기록을 적는다 (있으면 바꾼다)."""
    old = [h for (h,) in con.execute("SELECT hash FROM uses WHERE key=?", (key,))]
    used: set[str] = set()
    data = json.dumps(_pack(con, heavy, used), ensure_ascii=False)
    con.execute("INSERT OR REPLACE INTO rec VALUES(?,?)", (key, data))
    con.execute("DELETE FROM uses WHERE key=?", (key,))
    con.executemany("INSERT INTO uses VALUES(?,?)", [(key, h) for h in used])
    _gc(con, set(old) - used)


def has(con: sqlite3.Connection, key: str) -> bool:
    return con.execute("SELECT 1 FROM rec WHERE key=?", (key,)).fetchone() is not None


def keep_unread(con: sqlite3.Connection, line: bytes) -> None:
    """못 읽은 줄을 **그대로** 남긴다. 같은 줄은 한 번만 (옮기기를 다시 돌려도 안 불어난다)."""
    if con.execute("SELECT 1 FROM unread WHERE line=?", (line,)).fetchone() is None:
        con.execute("INSERT INTO unread VALUES(?)", (line,))


def get(d: Path, key: str) -> dict:
    """그 열쇠의 기록. 없으면 빈 것. ★DB 가 없으면 만들지 않는다 (읽기만 하는 자리다)."""
    if not (d / NAME).is_file():
        return {}
    with connect(d) as con:
        row = con.execute("SELECT data FROM rec WHERE key=?", (key,)).fetchone()
        if row is None:
            return {}
        got = _unpack(con, json.loads(row[0]), {})
    return got if isinstance(got, dict) else {}


def keys(d: Path) -> set[str]:
    """적혀 있는 열쇠 전부 (옮긴 뒤 대조할 때 쓴다)."""
    if not (d / NAME).is_file():
        return set()
    with connect(d) as con:
        return {k for (k,) in con.execute("SELECT key FROM rec")}


def copy(src: Path, dst: Path, want: list[str]) -> int:
    """그 열쇠들의 기록을 다른 워크스페이스에 **베낀다** (탭 옮기기). 주는 쪽은 그대로 둔다 —
    빼는 것은 부르는 쪽이 색인을 옮긴 **뒤에** 한다 (`forget`). 베낀 수를 돌려준다.
    ★★**풀지 않고 DB 끼리 베낀다** (`ATTACH`). 풀어서 다시 적으면 옮기는 기록 전부가 메모리에 오른다
      (실측 2026-09-30: 76MB 기록에 최대 199MB · 6초 — 10만 장이면 몇 GB 다)."""
    if not want or not (src / NAME).is_file():
        return 0
    with connect(dst) as t:
        t.execute("ATTACH DATABASE ? AS s", (str(src / NAME),))
        t.execute("CREATE TEMP TABLE want(key TEXT PRIMARY KEY)")
        t.executemany("INSERT OR IGNORE INTO temp.want VALUES(?)", [(k,) for k in want])
        # ★받는 쪽에 같은 열쇠가 이미 있으면 바꾼다 (`put` 과 같다) — 그 기록만 쓰던 blob 은 뒤에서 뺀다
        old = [h for (h,) in t.execute("SELECT hash FROM main.uses WHERE key IN (SELECT key FROM temp.want)")]
        t.execute("DELETE FROM main.uses WHERE key IN (SELECT key FROM temp.want)")
        n = t.execute("INSERT OR REPLACE INTO main.rec SELECT key, data FROM s.rec"
                      " WHERE key IN (SELECT key FROM temp.want)").rowcount
        t.execute("INSERT OR IGNORE INTO main.uses SELECT key, hash FROM s.uses"
                  " WHERE key IN (SELECT key FROM temp.want)")
        t.execute("INSERT OR IGNORE INTO main.blob SELECT hash, data, b64 FROM s.blob WHERE hash IN"
                  " (SELECT hash FROM s.uses WHERE key IN (SELECT key FROM temp.want))")
        _gc(t, old)
        t.commit()
        t.execute("DETACH DATABASE s")   # ★트랜잭션 밖에서만 된다 — 그래서 먼저 적는다
    return max(n, 0)


def forget(d: Path, gone: set[str] | list[str]) -> int:
    """그 열쇠들의 기록을 뺀다 (휴지통에서 비워진 그림 · 다른 워크스페이스로 옮겨 간 그림).
    ★빈 자리는 파일 크기에서 돌려준다 (`auto_vacuum=INCREMENTAL`). 뺀 수를 돌려준다."""
    if not gone or not (d / NAME).is_file():
        return 0
    n = 0
    with connect(d) as con:
        hashes: set[str] = set()
        for k in gone:
            hashes.update(h for (h,) in con.execute("SELECT hash FROM uses WHERE key=?", (k,)))
            n += con.execute("DELETE FROM rec WHERE key=?", (k,)).rowcount
            con.execute("DELETE FROM uses WHERE key=?", (k,))
        _gc(con, hashes)
        con.commit()
        con.execute("PRAGMA incremental_vacuum").fetchall()
    return n
