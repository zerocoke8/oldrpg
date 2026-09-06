-- ===========================================================================
-- v5 — 임무. 순수 가산이다: players 도 player_items 도 건드리지 않는다.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- player_missions — 누가 무엇을 받았고 얼마나 했나. 임무가 '무엇인가' 는
-- content/world/missions.json 이 소유한다. rooms/npcs/player_items 와 같은
-- 관계다: 정의는 데이터, 표는 그림자.
--
-- ★ 등급(004)은 칼럼이었는데 이건 왜 표인가. 등급은 한 사람에게 하나뿐이고
--   단조 증가라 '두 갱신이 서로를 덮는' 모양이 없었다. 임무는 반대로
--   player_items 쪽이다:
--
--   (1) 일대다다. 한 사람이 여러 임무를 동시에 진행한다.
--
--   (2) 진행도 갱신이 한 문장으로 원자적이어야 한다.
--         UPDATE ... SET progress = MIN(progress + ?, ?) WHERE ... AND done_at IS NULL
--       블롭이면 전부 읽고-고쳐-쓰기다. 두 명이 같은 적을 동시에 잡거나 한
--       사람이 두 탭에서 진행하면 그 사이에 낀 갱신이 사라진다.
--
--   (3) "이 임무를 몇 명이 끝냈나" 가 SQL 질의가 된다.
--
-- ★ done_at 이 별도 표가 아니라 열인 이유: 완료도 임무의 '상태' 다. 그리고
--   PK (player_id, mission_id) 하나가 "이미 받았는가/이미 끝냈는가" 를 함께
--   답한다. 표를 나누면 그 둘이 어긋날 수 있는 자리가 생긴다.
--
-- ★ progress >= 0 만 CHECK 한다. 상한(goal.count)은 데이터에 있고, 데이터가
--   바뀌면 이미 쌓인 행이 CHECK 를 위반해 부팅이 죽는다. 상한은 판정하는
--   곳(engine/missions.ts)이 본다.
--
-- ★ 인덱스를 따로 만들지 않는다. PK 앞자리가 player_id 라 "이 사람의 전부"
--   질의가 그 인덱스를 그대로 탄다 (player_items 와 같다).
-- ---------------------------------------------------------------------------
CREATE TABLE player_missions (
  player_id   TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mission_id  TEXT    NOT NULL,               -- content/world/missions.json 의 키
  progress    INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0),
  accepted_at INTEGER NOT NULL,
  done_at     INTEGER,                        -- 제출한 시각. NULL 이면 진행 중
  PRIMARY KEY (player_id, mission_id)
) STRICT;
