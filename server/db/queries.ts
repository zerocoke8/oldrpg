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

export interface NpcLineFullRow extends RoomTextRow {
  npc_id: string;
  topic: string;
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

    // ── npcs / npc_lines ────────────────────────────────────────────────
    upsertNpc: db.prepare(
      `INSERT INTO npcs (id, room_id, name, persona_seed, sensitive_flags,
                         flags_decl_hash, created_at, updated_at)
       VALUES (@id, @room_id, @name, @persona_seed, @sensitive_flags,
               @flags_decl_hash, @now, @now)
       ON CONFLICT (id) DO UPDATE SET
         room_id = excluded.room_id, name = excluded.name,
         persona_seed = excluded.persona_seed,
         sensitive_flags = excluded.sensitive_flags,
         flags_decl_hash = excluded.flags_decl_hash, updated_at = excluded.updated_at
       WHERE npcs.persona_seed <> excluded.persona_seed
          OR npcs.sensitive_flags <> excluded.sensitive_flags
          OR npcs.room_id <> excluded.room_id
          OR npcs.name <> excluded.name`,
    ),
    getNpcLine: db.prepare<[string, string, string], RoomTextRow>(
      "SELECT text, source FROM npc_lines WHERE npc_id = ? AND topic = ? AND state_hash = ?",
    ),
    getNpcLineRow: db.prepare<[string, string, string], NpcLineFullRow>(
      "SELECT * FROM npc_lines WHERE npc_id = ? AND topic = ? AND state_hash = ?",
    ),
    /** room_text 와 글자 그대로 같은 규약: PK 충돌은 "남이 먼저 썼다" 이고
     *  호출자는 무조건 재조회한다. */
    insertNpcLineIfAbsent: db.prepare(
      `INSERT INTO npc_lines (npc_id, topic, state_hash, text, source, flags_json,
                              model, prompt_version, created_at, updated_at)
       VALUES (@npc_id, @topic, @state_hash, @text, @source, @flags_json,
               @model, @prompt_version, @now, @now)
       ON CONFLICT (npc_id, topic, state_hash) DO NOTHING`,
    ),
    upgradeNpcLineFromFallback: db.prepare(
      `UPDATE npc_lines SET text = @text, source = 'llm', model = @model,
                            prompt_version = @prompt_version, updated_at = @now
       WHERE npc_id = @npc_id AND topic = @topic AND state_hash = @state_hash
         AND source = 'fallback'`,
    ),

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

    // ── player_items ────────────────────────────────────────────────────
    /** 그 사람의 전부. PK 의 앞자리가 player_id 라 이 질의가 PK 인덱스를 탄다.
     *  item_id 로 정렬해 목록의 순서가 요청마다 흔들리지 않게 한다 —
     *  커맨드 창의 커서가 같은 자리에 머물러야 한다. */
    itemsOf: db.prepare<[string], { item_id: string; qty: number }>(
      "SELECT item_id, qty FROM player_items WHERE player_id = ? ORDER BY item_id",
    ),
    /** 한 문장으로 원자적이다 — JSON 블롭 대신 표를 쓴 첫 번째 이유가 이것이다. */
    addItem: db.prepare(
      `INSERT INTO player_items (player_id, item_id, qty, updated_at)
       VALUES (@player_id, @item_id, @qty, @now)
       ON CONFLICT (player_id, item_id) DO UPDATE
         SET qty = qty + excluded.qty, updated_at = excluded.updated_at`,
    ),
    /** 하나 쓴다. 없거나 0이면 0행 — 호출자가 그걸로 "가지고 있지 않다" 를 안다.
     *  CHECK (qty > 0) 이 있으므로 마지막 하나는 UPDATE 가 아니라 DELETE 다. */
    consumeItem: db.prepare(
      `UPDATE player_items SET qty = qty - 1, updated_at = @now
       WHERE player_id = @player_id AND item_id = @item_id AND qty > 1`,
    ),
    dropLastItem: db.prepare(
      "DELETE FROM player_items WHERE player_id = @player_id AND item_id = @item_id AND qty = 1",
    ),
  };
  return q;
}

export type Queries = ReturnType<typeof makeQueries>;
