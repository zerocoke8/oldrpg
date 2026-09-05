-- ===========================================================================
-- server/db/schema.sql — 1단계 스키마 전체. 순수 DDL 만 있다.
-- migrate.ts 가 meta.schema_version 이 없을 때 단 한 번 통째로 실행한다.
--
-- 여기 없는 것: PRAGMA. foreign_keys / synchronous / busy_timeout / journal_mode 는
-- SQLite 에서 '연결 단위'다. 버전 가드가 걸린 이 파일에 두면 첫 부팅 이후로는
-- 영원히 안 걸리고, FK 가 꺼진 채 돌고 synchronous 는 FULL 로 돌아가
-- "이동마다 write-through 는 공짜다" 라는 논거가 무너진다.
-- -> server/db/open.ts 가 '모든' 연결에서 건다.
--
-- 표 다섯 개가 전부다. 비어 있는 자리표시자 표는 만들지 않는다 — 쓰는 코드가
-- 없는 표는 시스템이 하는 일에 대한 거짓말이고, 진짜 모양을 알게 되는 순간
-- 어차피 고쳐야 한다. 무엇을 왜 미뤘는지는 README.md 에 적혀 있다.
-- ===========================================================================

-- meta — 부팅 불변식 두 가지.
--   schema_version : 마이그레이션 가드
--   content_hash   : engine/map.ts 와 DB rooms 가 같은 세대인지 한 번에 판정
-- PRAGMA user_version 대신 표를 쓰는 이유: 기록할 값이 둘 이상이다.
CREATE TABLE meta (
  key        TEXT    NOT NULL PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- rooms — charter 의 "절대 변경 안 됨" 표.
-- 저작 주체는 코드(server/engine/map.ts)이고 이 표는 그 투영이다.
-- 이동 판정은 절대 여기서 읽지 않는다 — 핫패스는 메모리다.
-- 이 표가 존재하는 이유는 정확히 셋:
--   (1) room_text 가 붙을 안정적 PK
--   (2) 씨앗에 신원(seed_id)을 부여해 씨앗 편집이 캐시를 조용히 오염시키지 못하게
--   (3) 3단계의 "이 플래그에 반응하는 방" 질의
-- 벽 타일('#')은 행이 없다. 7x7 에서 실제 행은 19개.
CREATE TABLE rooms (
  id              TEXT    NOT NULL PRIMARY KEY,
  region          TEXT    NOT NULL,
  x               INTEGER NOT NULL,
  y               INTEGER NOT NULL,
  tile            TEXT    NOT NULL CHECK (tile IN ('.','S','T','E')),
  seed            TEXT    NOT NULL,
  seed_id         TEXT    NOT NULL,
  sensitive_flags TEXT    NOT NULL CHECK (json_valid(sensitive_flags)),
  flags_decl_hash TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (region, x, y)
) STRICT;

-- world_flags — 엔진 소유의 세계 진실. 1단계에 guardian_slain=false 1행만 시드한다.
-- 1단계에는 이 값을 켜는 코드 경로가 없다(전투는 4단계). 그래도 지금 만드는 이유:
-- state_hash 경로가 LLM 없이 '진짜 데이터'로 돌아야, 2단계의 캐시 키와 3단계의
-- 재렌더링 트리거가 '새 코드'가 아니라 '이미 도는 코드'가 되기 때문이다.
CREATE TABLE world_flags (
  key        TEXT    NOT NULL PRIMARY KEY,
  value      TEXT    NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- room_text — 생성 캐시. 1단계에는 하드코딩 문장이 들어가지만,
-- LLM 출력이 나중에 차지할 '바로 그 행'을 '진짜 state_hash' 로 점유한다.
-- 부팅 프리시드를 하지 않고 첫 입장 때 lazy 기록한다 — 그래야 charter 50줄의
-- "캐시 조회 -> 없으면 생성 -> DB 기록" 세 단계가 두 브라우저로 걸어 다니는 것만으로
-- 매 첫 방문마다 진짜로 실행된다. (프리시드하면 (1)만 돌고 (2)(3)이 죽은 코드가 된다.)
--
-- 규칙 2("생성은 딱 한 번")를 뮤텍스가 아니라 '제약'으로 표현한다:
--   최초 기록 : INSERT ... ON CONFLICT (room_id, state_hash) DO NOTHING; 그리고 무조건 재조회
--   2단계 확정: UPDATE ... SET source='llm' WHERE room_id=? AND state_hash=? AND source='fallback'
--               -- 0행 매치 = 남이 먼저 생성했다 = 오류가 아니다. 재조회해서 그 텍스트를 쓴다.
-- 이 두 줄이 '좌표 단위 생성 락'의 정확성 부분이고, 프로세스를 넘어서도 성립한다.
CREATE TABLE room_text (
  room_id        TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  state_hash     TEXT    NOT NULL,
  text           TEXT    NOT NULL,
  source         TEXT    NOT NULL CHECK (source IN ('fallback','llm','authored')),
  flags_json     TEXT    NOT NULL CHECK (json_valid(flags_json)),
  model          TEXT,
  prompt_version TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (room_id, state_hash)
) STRICT;

CREATE INDEX idx_room_text_source ON room_text(source);

-- players — 영속 '익명 캐릭터'. 계정이 아니고(비밀번호/이메일 없음),
-- 세션도 아니다. online 칼럼이 없는 이유: 접속 여부는 살아 있는 소켓만이 아는
-- 사실이라, 영속화하면 프로세스가 죽는 순간 전원이 접속 중이라고 거짓말한다.
-- 행의 존재 이유: 새로고침 / 회선 끊김 / 서버 재시작 후 서 있던 칸으로 돌려놓는 것.
CREATE TABLE players (
  id           TEXT    NOT NULL PRIMARY KEY,
  name         TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 16),
  token_hash   TEXT    NOT NULL UNIQUE,
  region       TEXT    NOT NULL,
  x            INTEGER NOT NULL,
  y            INTEGER NOT NULL,
  hp           INTEGER NOT NULL DEFAULT 40 CHECK (hp >= 0),
  max_hp       INTEGER NOT NULL DEFAULT 40 CHECK (max_hp > 0),
  seen         TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(seen)),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  CHECK (hp <= max_hp)
) STRICT;

CREATE INDEX idx_players_last_seen ON players(last_seen_at);
