-- ===========================================================================
-- v3 — 인벤토리. 순수 가산이다: players 를 한 칼럼도 건드리지 않으므로
-- 기존 캐릭터도, 2·4b 단계에서 생성해 둔 텍스트도 그대로 살아남는다.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- player_items — 소지 '수량' 만 안다. 아이템이 무엇인지는 코드가 소유한다
-- (server/engine/items.ts). rooms/npcs 와 같은 관계다: 정의는 코드, 표는 그림자.
--
-- ★ CLAUDE.md 41줄의 스케치는 `players ... inventory` 였다. 표로 간 이유:
--
--   (1) 수량 갱신이 한 문장으로 원자적이다.
--         INSERT ... ON CONFLICT DO UPDATE SET qty = qty + excluded.qty
--       JSON 블롭이면 전부 읽고-고쳐-쓰기다. 두 명이 같은 적을 동시에 잡거나,
--       한 사람이 두 탭에서 물약을 마시면 그 사이에 낀 갱신이 사라진다.
--       players.seen 이 JSON 인 것은 괜찮다 — 통째로만 읽고 쓰며 경합이 없다.
--
--   (2) "누가 무엇을 몇 개 갖고 있나" 가 SQL 질의가 된다. 나중에 거래·상점·
--       드랍 통계가 붙을 때 블롭이면 전부 애플리케이션 코드로 푼다.
--
--   (3) Postgres 로 옮길 때 그대로 간다.
--
-- ★ qty > 0 이 CHECK 다. '0개를 가진 행' 은 존재하지 않는다 — 다 쓰면 행을
--   지운다. 그래야 "가지고 있는가" 가 행의 존재와 같은 뜻이 되고, 조회하는
--   모든 곳이 0 을 따로 걸러낼 필요가 없다.
--
-- ★ 인덱스를 따로 만들지 않는다. PK (player_id, item_id) 의 앞자리가 곧
--   player_id 이므로 "이 사람의 전부" 질의가 그 인덱스를 그대로 탄다.
-- ---------------------------------------------------------------------------
CREATE TABLE player_items (
  player_id  TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_id    TEXT    NOT NULL,               -- server/engine/items.ts 의 id
  qty        INTEGER NOT NULL CHECK (qty > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, item_id)
) STRICT;
