/* 모든 SQL 이 사는 곳. charter 91줄("나중에 Postgres 로 옮길 수 있게 쿼리를
   한 곳에 모을 것")이 요구하는 단일 지점이다. 서버의 나머지는 SQL 문자열을
   한 글자도 보지 않는다. */

import type { Db } from "./open";

export interface RoomRow {
  id: string;
  region: string;
  x: number;
  y: number;
  tile: string;
  seed: string;
  seed_id: string;
  sensitive_flags: string;
  flags_decl_hash: string;
}

export interface RoomTextRow {
  text: string;
  source: string;
}

/** 진단용 전체 행. flags_json 이 state_hash 의 preimage 라
 *  "이 방이 왜 저 문장을 말하나" 가 SELECT 하나로 끝난다. */
export interface RoomTextFullRow extends RoomTextRow {
  room_id: string;
  state_hash: string;
  flags_json: string;
  model: string | null;
  prompt_version: string | null;
  created_at: number;
  updated_at: number;
}

export interface PlayerRow {
  id: string;
  name: string;
  token_hash: string;
  region: string;
  x: number;
  y: number;
  hp: number;
  max_hp: number;
  seen: string;
  created_at: number;
  last_seen_at: number;
}

export function makeQueries(db: Db) {
  const q = {
    // ── meta ────────────────────────────────────────────────────────────
    getMeta: db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ),

    // ── rooms ───────────────────────────────────────────────────────────
    upsertRoom: db.prepare(
      `INSERT INTO rooms (id, region, x, y, tile, seed, seed_id, sensitive_flags,
                          flags_decl_hash, created_at, updated_at)
       VALUES (@id, @region, @x, @y, @tile, @seed, @seed_id, @sensitive_flags,
               @flags_decl_hash, @now, @now)
       ON CONFLICT (id) DO UPDATE SET
         tile = excluded.tile, seed = excluded.seed, seed_id = excluded.seed_id,
         sensitive_flags = excluded.sensitive_flags,
         flags_decl_hash = excluded.flags_decl_hash, updated_at = excluded.updated_at
       WHERE rooms.seed <> excluded.seed
          OR rooms.sensitive_flags <> excluded.sensitive_flags
          OR rooms.tile <> excluded.tile`,
    ),
    allRooms: db.prepare<[], RoomRow>("SELECT * FROM rooms"),

    // ── world_flags ─────────────────────────────────────────────────────
    /** 값 정규화(JSON.stringify)는 setFlag 한 곳에서만 일어난다.
     *  그래서 'true' 와 '1' 이 서로 다른 상태라는 것이 관례가 아니라 보장이다. */
    allFlags: db.prepare<[], { key: string; value: string }>("SELECT key, value FROM world_flags"),
    insertFlagIfAbsent: db.prepare(
      "INSERT OR IGNORE INTO world_flags (key, value, updated_at) VALUES (?, ?, ?)",
    ),
    setFlag: db.prepare(
      `INSERT INTO world_flags (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ),

    // ── room_text ───────────────────────────────────────────────────────
    getRoomText: db.prepare<[string, string], RoomTextRow>(
      "SELECT text, source FROM room_text WHERE room_id = ? AND state_hash = ?",
    ),
    /** 규칙 2("생성은 딱 한 번")의 정확성 부분. PK 충돌은 오류가 아니라
     *  "남이 먼저 썼다" 이고, 호출자는 무조건 재조회한다.
     *  이 보증은 프로세스를 넘어서도 성립한다 — 뮤텍스가 못 하는 일이다. */
    insertRoomTextIfAbsent: db.prepare(
      `INSERT INTO room_text (room_id, state_hash, text, source, flags_json,
                              model, prompt_version, created_at, updated_at)
       VALUES (@room_id, @state_hash, @text, @source, @flags_json,
               @model, @prompt_version, @now, @now)
       ON CONFLICT (room_id, state_hash) DO NOTHING`,
    ),
    getRoomTextRow: db.prepare<[string, string], RoomTextFullRow>(
      "SELECT * FROM room_text WHERE room_id = ? AND state_hash = ?",
    ),
    /** 2단계에서 폴백을 LLM 확정본으로 승급시킨다. WHERE source='fallback' 이
     *  "딱 한 번" 을 표현하는 절이다 — 0행 매치는 오류가 아니다. */
    upgradeRoomTextFromFallback: db.prepare(
      `UPDATE room_text SET text = @text, source = 'llm', model = @model,
                            prompt_version = @prompt_version, updated_at = @now
       WHERE room_id = @room_id AND state_hash = @state_hash AND source = 'fallback'`,
    ),

    // ── players ─────────────────────────────────────────────────────────
    playerByTokenHash: db.prepare<[string], PlayerRow>(
      "SELECT * FROM players WHERE token_hash = ?",
    ),
    insertPlayer: db.prepare(
      `INSERT INTO players (id, name, token_hash, region, x, y, hp, max_hp, seen,
                            created_at, last_seen_at)
       VALUES (@id, @name, @token_hash, @region, @x, @y, @hp, @max_hp, @seen, @now, @now)`,
    ),
    /** 위치·안개·최종접속을 한 트랜잭션으로. 이동 핫패스의 유일한 쓰기다.
     *  WAL + synchronous=NORMAL 에서 준비된 문 하나는 수십 마이크로초다. */
    commitMove: db.prepare(
      `UPDATE players SET region = @region, x = @x, y = @y, seen = @seen, last_seen_at = @now
       WHERE id = @id`,
    ),
    /** 전투의 핫패스. 이동의 commitMove 와 같은 규칙으로 쓴다:
     *  DB 커밋이 먼저, 메모리 갱신이 나중. */
    setPlayerHp: db.prepare(
      "UPDATE players SET hp = ?, last_seen_at = ? WHERE id = ?",
    ),
    touchPlayer: db.prepare("UPDATE players SET last_seen_at = ? WHERE id = ?"),
    renamePlayer: db.prepare("UPDATE players SET name = ? WHERE id = ?"),
    /** 인증이 없는 표의 유일한 방어책. 부팅 때 한 번 돈다. */
    reapStalePlayers: db.prepare("DELETE FROM players WHERE last_seen_at < ?"),
    countPlayersCreatedSince: db.prepare<[number], { n: number }>(
      "SELECT count(*) AS n FROM players WHERE created_at >= ?",
    ),
  };
  return q;
}

export type Queries = ReturnType<typeof makeQueries>;
