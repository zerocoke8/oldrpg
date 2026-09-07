-- ===========================================================================
-- v6 — 진짜 계정. 순수 가산이다: 기존 표의 칼럼을 하나도 '바꾸지' 않는다.
--
-- ★ 왜 players.token_hash 를 accounts 로 '옮기지' 않는가:
--   그 칼럼은 NOT NULL UNIQUE 다. SQLite 는 ALTER 로 그 둘을 풀 수 없으므로
--   옮기려면 players 표 재생성이고, 그러면 player_items(003)·player_missions(005)
--   의 FK 와 값이 나간 room_text 가 걸린 채로 표를 다시 짓게 된다. 002~005 중
--   표를 재생성한 마이그레이션은 하나도 없다 (migrate.ts: "전부 가산이어야 한다").
--   대신 그 칼럼의 '뜻' 을 좁힌다 — 익명 캐릭터의 재개 토큰. 계정에 묶이는
--   순간 아무도 모르는 난수의 해시로 덮어써서 영구히 죽인다(무덤 토큰).
--
-- ★ 왜 player_tokens 가 표인가: 한 사람에게 여럿이고(기기마다 하나),
--   개별 폐기가 DELETE 한 문장이어야 한다. rank 가 칼럼이어야 했던 이유
--   (하나뿐 · 단조 증가)가 여기에는 하나도 없다 — player_items 쪽이다.
--
-- ★ 왜 secret 이 한 칼럼인가: PHC 꼴 문자열 하나가 알고리즘·비용·salt 를 함께
--   나른다. 그래서 N 을 올리는 일이 마이그레이션이 아니라 '다음 로그인에 재해시'
--   가 된다. 칼럼을 넷으로 나누면 파라미터를 바꿀 때마다 v7 이 필요하다.
--   004-rank.sql 이 CHECK 에 등급 상한을 안 박은 것과 같은 이유다.
--
-- ★ 이름 열거는 완화만 되고 없어지지 않는다. 가입은 "그 이름은 이미 있다" 를
--   말해 줘야 하기 때문이다. 로그인은 반대로 아무것도 흘리지 않는다 —
--   모르는 이름과 틀린 비밀번호가 같은 한 문장이고 같은 시간이 든다.
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id            TEXT    NOT NULL PRIMARY KEY,
  -- 조회 키. NFKC 정규화 + 소문자. UNIQUE 가 '여기' 걸린다.
  name_key      TEXT    NOT NULL UNIQUE,
  -- 사람이 입력한 원형. 화면에 되돌려 줄 때만 쓴다.
  name          TEXT    NOT NULL,
  -- "scrypt$N=32768,r=8,p=1$<salt b64url>$<dk b64url>"
  secret        TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  CHECK (length(name_key) > 0),
  -- 정규화 불변식을 DDL 이 든다. 코드가 소문자화를 빼먹으면 INSERT 가 죽는다.
  CHECK (name_key = lower(name_key))
) STRICT;

-- 익명 = NULL. ★ ON DELETE SET NULL — 계정을 지우는 것이 캐릭터를 지우는 것이
-- 되어서는 안 된다. CASCADE 면 player_items·player_missions 까지 함께 간다.
-- (ADD COLUMN 에 REFERENCES 를 붙일 수 있는 것은 기본값이 NULL 일 때뿐이다.)
ALTER TABLE players ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX idx_players_account ON players(account_id);

CREATE TABLE player_tokens (
  token_hash   TEXT    NOT NULL PRIMARY KEY,
  player_id    TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  -- sha256 hex 여야 한다. 평문이 실수로 들어오면 여기서 죽는다.
  CHECK (length(token_hash) = 64)
) STRICT;
-- (player_id, last_used_at): 기기 상한을 넘을 때의 축출 대상 고르기와
-- '이 계정 전부 로그아웃' 이 이 인덱스를 탄다.
CREATE INDEX idx_player_tokens_player ON player_tokens(player_id, last_used_at);
