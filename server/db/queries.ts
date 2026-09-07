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

/** player_missions 한 행. done_at 이 null 이면 진행 중이다. */
export interface MissionRow {
  mission_id: string;
  progress: number;
  accepted_at: number;
  done_at: number | null;
}

/** accounts 한 행 (마이그레이션 006). secret 은 PHC 꼴 문자열 하나다. */
export interface AccountRow {
  id: string;
  name_key: string;
  name: string;
  secret: string;
  created_at: number;
  last_login_at: number | null;
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
  /** 길드 등급. 0 은 미등록 (마이그레이션 004). */
  rank: number;
  /** 계정 (마이그레이션 006). null 이면 익명 캐릭터다. */
  account_id: string | null;
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
    // ── 계정 (마이그레이션 006) ──────────────────────────────────────────
    /** 조회는 언제나 정규화된 name_key 로. DDL 의 CHECK 가 그것을 강제한다. */
    accountByNameKey: db.prepare<[string], AccountRow>(
      "SELECT * FROM accounts WHERE name_key = ?",
    ),
    accountById: db.prepare<[string], AccountRow>("SELECT * FROM accounts WHERE id = ?"),
    insertAccount: db.prepare(
      `INSERT INTO accounts (id, name_key, name, secret, created_at)
       VALUES (@id, @name_key, @name, @secret, @now)`,
    ),
    /** 로그인 성공 뒤. 파라미터가 낡았으면 secret 도 함께 다시 쓴다
     *  ('다음 로그인에 재해시' — 그래서 N 을 올리는 것이 마이그레이션이 아니다). */
    touchAccount: db.prepare(
      "UPDATE accounts SET last_login_at = @now, secret = @secret WHERE id = @id",
    ),
    /** 계정의 캐릭터. 오늘은 하나뿐이지만 그건 UI 가 없어서이지 제약이 아니다. */
    playersOfAccount: db.prepare<[string], PlayerRow>(
      "SELECT * FROM players WHERE account_id = ? ORDER BY created_at",
    ),
    bindPlayerToAccount: db.prepare(
      "UPDATE players SET account_id = @account_id WHERE id = @id AND account_id IS NULL",
    ),
    /** ★ 무덤 토큰. 계정에 묶이는 순간 익명 재개 토큰을 아무도 모르는 난수로
     *  덮어써 영구히 죽인다. token_hash 가 NOT NULL UNIQUE 라 비울 수는 없다. */
    buryPlayerToken: db.prepare("UPDATE players SET token_hash = @token_hash WHERE id = @id"),

    // ── 기기 토큰 (마이그레이션 006) ────────────────────────────────────
    /** ★ playerByTokenHash 와 나란히 쓰인다. 둘 다 miss 면 같은 신규 생성
     *  경로로 흘러야 한다 — 아니면 '그 토큰이 있는가' 오라클이 하나 생긴다. */
    playerByDeviceToken: db.prepare<[string], PlayerRow>(
      `SELECT p.* FROM players p
         JOIN player_tokens t ON t.player_id = p.id
        WHERE t.token_hash = ?`,
    ),
    insertDeviceToken: db.prepare(
      `INSERT INTO player_tokens (token_hash, player_id, created_at, last_used_at)
       VALUES (@token_hash, @player_id, @now, @now)`,
    ),
    touchDeviceToken: db.prepare(
      "UPDATE player_tokens SET last_used_at = @now WHERE token_hash = @token_hash",
    ),
    deviceTokensOf: db.prepare<[string], { token_hash: string; last_used_at: number }>(
      "SELECT token_hash, last_used_at FROM player_tokens WHERE player_id = ? ORDER BY last_used_at DESC",
    ),
    /** 기기 상한을 넘으면 가장 오래 안 쓴 것부터 축출한다. */
    dropDeviceToken: db.prepare("DELETE FROM player_tokens WHERE token_hash = ?"),

    insertPlayer: db.prepare(
      `INSERT INTO players (id, name, token_hash, region, x, y, hp, max_hp, seen,
                            created_at, last_seen_at)
       VALUES (@id, @name, @token_hash, @region, @x, @y, @hp, @max_hp, @seen, @now, @now)`,
    ),
    /** 위치·안개·최종접속을 한 트랜잭션으로. 이동 핫패스의 유일한 쓰기다.
     *  WAL + synchronous=NORMAL 에서 준비된 문 하나는 수십 마이크로초다. */
    /** 이동의 핫패스. seen 을 쓰지 않는다 — 대부분의 걸음은 이미 밟아 본 칸으로
     *  가고, 거기서 seen 배열 전체를 직렬화하는 것은 방 수에 비례하는 낭비다
     *  (지역 하나가 50방이고 지역이 스무 개면 걸음마다 1000개짜리 JSON 이다). */
    commitMove: db.prepare(
      `UPDATE players SET region = @region, x = @x, y = @y, last_seen_at = @now
       WHERE id = @id`,
    ),
    /** 처음 밟는 칸일 때만. 안개가 넓어지는 순간에만 seen 이 실린다. */
    commitMoveSeen: db.prepare(
      `UPDATE players SET region = @region, x = @x, y = @y, seen = @seen, last_seen_at = @now
       WHERE id = @id`,
    ),
    /** 전투의 핫패스. 이동의 commitMove 와 같은 규칙으로 쓴다:
     *  DB 커밋이 먼저, 메모리 갱신이 나중. */
    setPlayerHp: db.prepare(
      "UPDATE players SET hp = ?, last_seen_at = ? WHERE id = ?",
    ),
    touchPlayer: db.prepare("UPDATE players SET last_seen_at = ? WHERE id = ?"),
    /** 승급. 되돌아가지 않는다 — MAX 로 올리기만 하므로, 늦게 도착한 요청이
     *  이미 올라간 등급을 내리는 일이 없다 (이동의 seen 과 같은 성질). */
    promotePlayer: db.prepare(
      "UPDATE players SET rank = MAX(rank, ?), last_seen_at = ? WHERE id = ?",
    ),
    /** 그 사람이 그 아이템을 몇 개 가졌나. 없으면 행이 없다 (0개는 행이 없다). */
    qtyOf: db.prepare<[string, string], { qty: number }>(
      "SELECT qty FROM player_items WHERE player_id = ? AND item_id = ?",
    ),
    /** 승급에 내는 만큼 뺀다. 남으면 줄이고, 정확히 다 쓰면 지운다.
     *  ★ 지우기가 먼저다 — inventory.ts 의 소비와 같은 이유이자 같은 함정이다. */
    spendItemAll: db.prepare(
      "DELETE FROM player_items WHERE player_id = @player_id AND item_id = @item_id AND qty <= @qty",
    ),
    spendItemSome: db.prepare(
      `UPDATE player_items SET qty = qty - @qty, updated_at = @now
       WHERE player_id = @player_id AND item_id = @item_id AND qty > @qty`,
    ),
    renamePlayer: db.prepare("UPDATE players SET name = ? WHERE id = ?"),
    /** 인증이 없는 표의 유일한 방어책. 부팅 때 한 번 돈다. */
    reapStalePlayers: db.prepare("DELETE FROM players WHERE last_seen_at < ?"),
    countPlayersCreatedSince: db.prepare<[number], { n: number }>(
      "SELECT count(*) AS n FROM players WHERE created_at >= ?",
    ),

    /** 선생성 도구의 보고용. 폴백이 남아 있으면 그만큼 생성에 실패한 것이다. */
    countRoomTextBySource: db.prepare<[], { source: string; n: number }>(
      "SELECT source, count(*) AS n FROM room_text GROUP BY source ORDER BY source",
    ),
    countNpcLines: db.prepare<[], { n: number }>("SELECT count(*) AS n FROM npc_lines"),

    // ── 백업·복원 (server/tools/backup.ts · restore.ts) ──────────────────
    /** 백업본에서 전부 읽는다. 정렬은 검사가 행 단위 동일성을 주장할 수 있게. */
    allRoomText: db.prepare<[], RoomTextFullRow>(
      "SELECT * FROM room_text ORDER BY room_id, state_hash",
    ),
    allNpcLines: db.prepare<[], NpcLineFullRow>(
      "SELECT * FROM npc_lines ORDER BY npc_id, topic, state_hash",
    ),
    /** 고아 선별용. room_text.room_id 는 rooms 로 FK 라 없는 방에 넣으면
     *  FOREIGN KEY constraint failed 로 트랜잭션이 통째로 죽는다. */
    allNpcIds: db.prepare<[], { id: string }>("SELECT id FROM npcs"),
    /* ★ insertRoomTextIfAbsent / insertNpcLineIfAbsent 와 ON CONFLICT 절이
       글자 그대로 같아야 한다 — 한쪽만 고치면 조용히 어긋난다. 다른 점은
       하나뿐이다: 두 타임스탬프를 @now 로 박지 않고 인자로 받는다. 그대로
       @now 를 쓰면 복원본이 '언제 이 문장에 돈을 썼는가' 를 잃는다. */
    restoreRoomText: db.prepare(
      `INSERT INTO room_text (room_id, state_hash, text, source, flags_json,
                              model, prompt_version, created_at, updated_at)
       VALUES (@room_id, @state_hash, @text, @source, @flags_json,
               @model, @prompt_version, @created_at, @updated_at)
       ON CONFLICT (room_id, state_hash) DO NOTHING`,
    ),
    restoreNpcLine: db.prepare(
      `INSERT INTO npc_lines (npc_id, topic, state_hash, text, source, flags_json,
                              model, prompt_version, created_at, updated_at)
       VALUES (@npc_id, @topic, @state_hash, @text, @source, @flags_json,
               @model, @prompt_version, @created_at, @updated_at)
       ON CONFLICT (npc_id, topic, state_hash) DO NOTHING`,
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

    // ── player_missions ─────────────────────────────────────────────────
    /** 그 사람의 전부 (끝낸 것 포함). PK 앞자리가 player_id 라 PK 인덱스를 탄다.
     *  mission_id 로 정렬해 목록의 순서가 요청마다 흔들리지 않게 한다 —
     *  커맨드 창의 커서가 같은 자리에 머물러야 한다 (itemsOf 와 같은 이유). */
    missionsOf: db.prepare<[string], MissionRow>(
      `SELECT mission_id, progress, accepted_at, done_at FROM player_missions
       WHERE player_id = ? ORDER BY mission_id`,
    ),
    missionOf: db.prepare<[string, string], MissionRow>(
      `SELECT mission_id, progress, accepted_at, done_at FROM player_missions
       WHERE player_id = ? AND mission_id = ?`,
    ),
    /** 수락. ★ DO NOTHING 이라 이미 받았거나 이미 끝낸 임무를 다시 받아도
     *  진행도가 0 으로 돌아가지 않는다. 0행이면 호출자가 '이미 받았다' 를 안다 —
     *  먼저 SELECT 로 보고 INSERT 하면 그 사이에 낀 요청이 진행도를 지운다. */
    acceptMission: db.prepare(
      `INSERT INTO player_missions (player_id, mission_id, progress, accepted_at)
       VALUES (@player_id, @mission_id, 0, @now)
       ON CONFLICT (player_id, mission_id) DO NOTHING`,
    ),
    /** 진행. 한 문장으로 원자적이다 — 표를 쓴 두 번째 이유가 이것이다.
     *  ★ MIN 으로 상한을 물린다. 목표가 1인데 둘을 잡으면 2가 되고, 그러면
     *    "3/1 마리" 가 화면에 뜬다. 상한 자체는 데이터라 인자로 들어온다.
     *  ★ done_at IS NULL 조건이 재제출을 막는다 — 끝낸 임무는 안 오른다. */
    advanceMission: db.prepare(
      `UPDATE player_missions SET progress = MIN(progress + @by, @cap)
       WHERE player_id = @player_id AND mission_id = @mission_id AND done_at IS NULL`,
    ),
    /** 돌려준다. done_at IS NULL 이라 이미 낸 것은 지워지지 않는다 —
     *  냈다는 사실은 세계의 기록이고 되돌릴 것이 아니다. 지워지면 보수를
     *  받고도 다시 맡아 또 받을 수 있다. */
    dropMission: db.prepare(
      "DELETE FROM player_missions WHERE player_id = ? AND mission_id = ? AND done_at IS NULL",
    ),
    /** 제출. ★ done_at IS NULL 이 조건이라 두 번 제출하면 두 번째는 0행이다.
     *  보수 지급이 이 0행 검사 뒤에 오므로, 두 탭에서 동시에 눌러도 보수는
     *  한 번만 나간다 (같은 트랜잭션 안이다). */
    completeMission: db.prepare(
      `UPDATE player_missions SET done_at = @now
       WHERE player_id = @player_id AND mission_id = @mission_id AND done_at IS NULL`,
    ),
  };
  return q;
}

export type Queries = ReturnType<typeof makeQueries>;
