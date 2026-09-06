-- ===========================================================================
-- v2 — NPC 와 대사. 순수 가산이다: 기존 표를 한 줄도 건드리지 않으므로
-- 2단계에서 생성해 둔 room_text(값이 나간 산출물)가 그대로 살아남는다.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- npcs — rooms 와 같은 방식이다. 저작 주체는 코드(server/engine/npcs.ts)이고
-- 이 표는 그 투영이다. 표가 존재하는 이유도 rooms 와 같다:
--   (1) npc_lines 가 붙을 안정적 PK
--   (2) 씨앗에 신원(seed_id)을 부여해 페르소나/씨앗 편집이 캐시를 조용히
--       오염시키지 못하게
--   (3) 3단계의 "이 플래그에 반응하는 NPC" 질의 (charter 59줄: "방·NPC")
-- ---------------------------------------------------------------------------
CREATE TABLE npcs (
  id              TEXT    NOT NULL PRIMARY KEY,  -- 'altar_keeper'. 전역 유일.
                                                 -- ':' 를 쓰지 않는다 — 승급 큐의
                                                 -- 키에서 구분자로 쓰기 때문이다.
  room_id         TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  persona_seed    TEXT    NOT NULL,              -- NPC 전체의 목소리. 불변.
  sensitive_flags TEXT    NOT NULL CHECK (json_valid(sensitive_flags)),
  flags_decl_hash TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_npcs_room ON npcs(room_id);

-- ---------------------------------------------------------------------------
-- npc_lines — room_text 의 규약을 그대로 복사한다. 다른 것은 PK 하나뿐이다.
--
-- ★ PK 에 topic 이 들어간다: (npc_id, topic, state_hash)
--   NPC 는 주제별로 다른 말을 한다 — 인사, "파수꾼에 대해", "봉인된 문에 대해".
--   방은 상태마다 묘사가 하나지만 NPC 는 그렇지 않다.
--
--   topic 없이 (npc_id, state_hash) 로도 '사실상' 충돌하지 않는다.
--   주제마다 씨앗이 다르고 seed_id 가 state_hash 안에 있기 때문이다.
--   그래도 topic 을 명시한 이유:
--     - 그 성질이 '씨앗이 서로 다르다' 는 우연에 기대고 있다
--     - "이 NPC 의 대사 전부" 를 조회했을 때 어느 것이 무슨 주제인지 알 수 없다
--     - SQLite 는 PK 를 ALTER 하지 못한다. 나중에 필요해지면 표 재생성이다.
--   지금 비용은 TEXT 칼럼 하나다.
--
-- state_hash 공식과 source/flags_json/model/prompt_version 규약은 room_text 와
-- 글자 그대로 같다. 2단계의 승급 경로(provisional -> log.replace)를 그대로 탄다.
-- ---------------------------------------------------------------------------
CREATE TABLE npc_lines (
  npc_id         TEXT    NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
  topic          TEXT    NOT NULL,               -- 'greet' 또는 선언된 주제 id
  state_hash     TEXT    NOT NULL,
  text           TEXT    NOT NULL,
  source         TEXT    NOT NULL CHECK (source IN ('fallback','llm','authored')),
  flags_json     TEXT    NOT NULL CHECK (json_valid(flags_json)),
  model          TEXT,
  prompt_version TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (npc_id, topic, state_hash)
) STRICT;

CREATE INDEX idx_npc_lines_source ON npc_lines(source);
