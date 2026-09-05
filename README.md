# oldrpg — LLM 텍스트 머드

웹 브라우저에서 돌아가는 멀티플레이어 텍스트 머드. 세계의 묘사·NPC 대사·퀘스트를
LLM이 생성하지만, 게임 규칙과 상태는 전부 결정론적 코드가 소유한다.

설계 원칙과 로드맵은 [CLAUDE.md](./CLAUDE.md) 에 있다. 이 문서는 **지금 무엇이 만들어져
있고, 무엇이 왜 미뤄졌는가** 를 적는다.

---

## 현재: 1단계 완료 (LLM 없음)

로드맵 1단계 — "하드코딩된 방 설명으로 서버 권위 이동, WebSocket 동기화,
두 브라우저에서 서로 보이는 것까지" — 가 끝났다. **LLM 호출은 한 줄도 없다.**

```bash
npm install
npm run dev          # 서버(8787) + 클라이언트(5173) 동시 실행
```

브라우저 탭 두 개를 연다:

- <http://localhost:5173/?as=a>
- <http://localhost:5173/?as=b>

토큰이 `localStorage["mud.token.a"]` / `["mud.token.b"]` 로 갈리므로 **같은 브라우저의
탭 두 개여도 서로 다른 캐릭터**다. 화살표로 이동, Enter로 살펴보기.

확인할 수 있는 것:

- 한쪽이 움직이면 다른 쪽 **미니맵의 점이 따라 움직인다**
- 같은 방에 들어가면 **"○○ 님이 서쪽에서 들어왔다."** 가 뜬다
- 벽에 부딪히면 문장만 뜨고 위치는 그대로다 (서버가 판정한다)
- **새로고침해도 상대 화면은 조용하다** (유예 8초). 좌표·안개도 복원된다

### 검증

```bash
npm run typecheck     # tsc --strict
npm run lint          # 규칙 1을 import 검사로 강제 (아래 참조)
npm test              # 진짜 서버 + WebSocket 2개 + SQLite, 59개 검사
npm run test:browser  # 진짜 크로미움 창 2개. 스크린샷은 test/shots/
```

---

## 구조

```
shared/      두 쪽이 함께 import 하는 계약. 타입과 '런타임 검증기'가 같이 산다
server/
  engine/    맵·이동·플래그. 진실을 계산한다. narration/ db/ net/ 을 import 하지 않는다
  narration/ 모든 한국어 문장. DB 핸들을 잡지 않고 텍스트를 '반환'만 한다
  world/     ★ 2단계 이음매. engine + db + narration 을 조합하는 유일한 곳
  db/        모든 SQL 이 queries.ts 한 파일에 있다 (나중에 Postgres 로 옮기려고)
  net/       세션·유예·presence 팬아웃·핸들러
client/
  net/       소켓 재접속, 재조정(reconcile)
  input/     키보드 / 자유 텍스트 -> Action 어댑터
  ui/        미니맵 · 로그 · 상태 · D패드
```

### 규칙 1은 주석이 아니라 빌드 에러다

CLAUDE.md 110줄("`engine/`이 `narration/`을 import 하는 코드가 생기면 규칙 1이 깨진 것이다")은
`.eslintrc.cjs` 의 `no-restricted-imports` 로 강제된다. 다음은 전부 **린트 에러**다:

| 금지 | 이유 |
|---|---|
| `engine/` → `server/narration/` | 엔진이 진실, LLM은 묘사만 한다 |
| `engine/` → `db/`, `better-sqlite3` | 엔진은 영속화를 모른다. 상태 변경은 반환값(effects)으로 낸다 |
| `engine/` 에서 `Math.random()` | 엔진은 결정론이어야 한다. 난수는 주입받는다 |
| `narration/` → `db/` | **LLM 출력이 상태를 바꾸는 경로가 생긴다** |
| `narration/` → `engine/` | 얼어붙은 `RoomTextRequest` 만 받는다 |
| `client/` → `@anthropic-ai/*` | 클라이언트는 LLM을 호출하지 않는다 (규칙 2) |

`shared/narration.ts` 의 **계약 타입**은 예외적으로 허용된다 — 구현이 아니라 서명이다.

---

## 프로토콜 (17종)

`shared/protocol.ts` 하나가 계약 전부다. 세 가지 불변식 위에 서 있다:

1. **화면에 문장을 올리는 메시지는 `log` 하나뿐이다.** `ack`·`presence.*`·`room.*` 는
   구조화 데이터만 싣는다. 클라이언트는 문장을 조립하지 않는다 — 벽 부딪힘도,
   "○○ 님이 들어왔다"도. 그래서 2·3단계가 **클라이언트 배포 없이** 서버 안에서 끝난다.
2. **`state_hash` 는 와이어에 절대 나타나지 않는다.** 클라이언트는 캐시 키를 들지 않는다.
3. **클라이언트는 모르는 것을 무시하거나 격하한다** — 모르는 필드, 모르는 `t`,
   모르는 enum *값*(`kind`→`narr`, `source`→`fallback`). `never` 기반 exhaustive switch를
   쓰지 않는다. 그래서 2·3단계의 추가분 대부분이 비파괴적 변경이 된다.

| 클라 → 서버 (3) | 서버 → 클라 (14) |
|---|---|
| `hello` `action` `pong` | `welcome` `snapshot` `ack` `room.describe` `self.patch` |
| 액션 5종: `move` `look` `say` `unparsed` `resync` | `presence.join/move/leave` `room.enter/leave` |
| | `log` `log.replace` `ping` `error` |

### 두 계열을 나눈 이유

- **`presence.*` = 미니맵 피드.** 나를 볼 수 있는 모두에게. 손실 허용 — 규모에서
  throttle·coarsen·withhold 된다.
- **`room.*` = 서사 피드.** 그 방의 재실자에게만. 무손실, 절대 coarsen 안 함.

하나로 합쳐 뒀다면, 팬아웃이 아파져서 presence를 5Hz로 throttle 하는 날
`"○○이 들어왔다"` 가 **조용히 삼켜진다**.

방출 순서 규칙: `presence.*` 를 `room.*` 보다 먼저 보낸다 — 로그에 "사라졌다"가 찍히는
순간 미니맵의 점은 이미 옮겨져 있어야 한다.

### 재조정에 롤백 분기가 없다

`ack` 는 성공이든 거절이든 **항상** 권위 `pos` 를 싣는다. 그래서 화면 위치는 언제나
순수 함수 `replay(confirmed, pending)` 이고, `client/net/reconcile.ts` 에 `if (ok)` 분기가
존재하지 않는다.

이게 성립하려면 **액션에 귀속 가능한 모든 실패가 `ack` 로 와야** 한다
(`rate_limited` `internal` `bad_args` 포함). `error` 로 답하면 그 액션의 `pending` 엔트리가
영원히 남아 예측 위치가 한 칸 어긋난 채 복구되지 않는다. 그래서 **`error` 는 항상 연결을
끊는다** — pending 이 연결과 함께 사라지게.

---

## 데이터 모델

표 다섯 개: `meta` `rooms` `world_flags` `room_text` `players`.
비어 있는 자리표시자 표는 만들지 않는다.

### `state_hash` = `` `${seed_id}.${flags_decl_hash}.${valueDigest}` ``

`rooms.sensitive_flags` 에 **선언된 플래그만** 해시한다 (CLAUDE.md 44-48줄).
세 조각이 각각 하는 일:

| 바뀐 것 | 결과 |
|---|---|
| 플래그 값 (`false`→`true`) | 캐시 미스. 옛 행 생존 → **되돌리면 옛 텍스트 복구** |
| 씨앗 문자열 편집 | 캐시 미스. **씨앗을 되돌려도 옛 행 복구** (`seed_id` 가 내용 파생이라서) |
| 플래그 **선언** 추가·삭제·재정렬 | 깨끗한 미스. 옛 행이 '다른 상태'로 **오독되지 않음** |

`seed_id` 가 증가 카운터가 아니라 `sha256(seed)[0:8]` 인 것이 요점이다 — 되돌림 동작이
플래그와 씨앗에서 **일치**하고, 엔진이 DB 없이 `state_hash` 를 계산할 수 있다.

### 1단계의 하드코딩 문장은 2단계 LLM 출력이 차지할 '바로 그 행' 에 산다

`room_text` 에 `source ∈ ('fallback','llm','authored')` 한 칼럼이 있고, 1단계는 전부
`'fallback'` 이다. 2단계 전환일에 기존 행은 **전부 유효한 캐시 히트**이므로
마이그레이션도, 콜드스타트 정지도 없다. 규칙 2의 "딱 한 번"은 주석이 아니라 WHERE 절이다:

```sql
-- 최초 기록 (그리고 무조건 재조회)
INSERT INTO room_text (...) VALUES (...) ON CONFLICT (room_id, state_hash) DO NOTHING;
-- 2단계 승급 — 0행 매치 = 남이 먼저 생성했다 = 오류가 아니다
UPDATE room_text SET text=?, source='llm', ... WHERE room_id=? AND state_hash=? AND source='fallback';
```

이 보증은 **프로세스를 넘어서도** 성립한다. 뮤텍스가 못 하는 일이다.

1단계는 부팅 프리시드를 **하지 않고** 첫 입장 때 lazy 기록한다 — 프리시드하면
"조회 → 없으면 생성 → 기록" 중 조회만 실행되고 나머지가 죽은 코드가 된다.

### 규칙 4는 1단계 프로토콜 속성이다

이동 처리는 두 단계다.

- **Phase A** (`await` 없음): `ack` + `self.patch` + `room.describe` + 모든 presence/room
  이벤트 + 재실자 로스터 줄
- **Phase B** (`await roomText()` 뒤): 서술 `log{narr}` **하나뿐**. 세션별 프로미스 체인.

2단계에 LLM이 들어와도 (a) 이동이 절대 LLM 뒤에 서지 않고 (b) 방 A의 묘사가 이미 방 B에
선 플레이어에게 도착하는 인터리브가 **구조적으로 불가능**하다.
"서술 텍스트는 이동 확정보다 늦게 도착할 수 있다" 가 **1단계 클라이언트 계약**이다.

---

## 신원과 유예

계정도 비밀번호도 없다. 서버가 32바이트 무기명 토큰을 발급하고 `sha256` 만 저장한다.
클라이언트는 `localStorage["mud.token." + (?as ?? "a")]` 에 넣는다.

**유예(linger)는 프로토콜에 보이지 않는다.** 유예 중인 플레이어는 모든 관찰자와 모든
스냅샷에게 그냥 "가만히 서 있는 플레이어"다.

- 소켓 종료 시 **아무것도 방출하지 않는다**. `byRoom`·`sessions` 에 그대로 남는다
- `room.describe.occupants` 와 `snapshot.presence` 에 **둘 다** 포함한다 — 하나만 포함하면
  둘이 어긋나 '점 없는 유령'이 생긴다
- 유예 안에 돌아오면 타이머만 취소하고 **역시 아무것도 방출하지 않는다**
- 유예(8초)가 만료돼야 비로소 `presence.leave` + `room.leave` + `log` 가 나간다

성립 조건: `presence.join`/`room.enter` 는 `player.id` 기준 **멱등 upsert**,
모르는 id 에 대한 `leave` 는 **no-op**.

### `connId` 에폭 가드

`close` 핸들러와 모든 Phase B 연속은 `connId` 를 확인한다.
**이 한 줄이 없으면 새로고침이 옛 소켓의 늦은 `close` 를 통해 '새' 세션을 지워
상대 미니맵에서 영구히 사라진다.** 두 브라우저 테스트에서 가장 먼저 만나는 버그다.

---

## 1단계에서 뺀 것 (전부 순수 가산 경로)

| 미룬 것 | 언제 | 왜 지금이 아닌가 |
|---|---|---|
| `room_gen_lock` 표 | 필요해지면 | **단일 프로세스로 가기로 했다.** 정확성은 PK + `ON CONFLICT DO NOTHING` + 재조회가 이미 쥐고 있고, 비용 중복은 `world/roomText.ts` 의 인플라이트 맵이 막는다. 워커를 별도 프로세스로 뗄 때만 표가 필요해진다 |
| `npcs` / `npc_lines` | 4단계 | PK가 아직 추측이다. **SQLite는 PK를 ALTER 하지 못한다** — 지금 만들면 틀린 규약이 굳는다. `source`/`flags_json`/`prompt_version` 칼럼 규약과 `state_hash` 공식은 이미 고정됐으므로 그때 복사하면 된다 |
| `player_items` | 4단계 | 옳은 모양은 `players` 의 JSON 블롭이 아니라 `player_items(player_id, item_id, qty)` 다. 형태는 지금 정했고 표만 안 만들었다. `hp`/`max_hp` 는 반대로 지금 만들었다 — UI가 이미 표시하므로 |
| `player_seen_rooms` | 안개가 수천 칸이 될 때 | 지금은 `players.seen` JSON 배열. 통째로만 읽고 쓰며 조인이 없다. 와이어 타입은 그대로다 |
| 서사 로그 영속화 | 3단계 | 1단계 로그는 휘발성이다. 세계가 플레이어 부재중에 변하기 시작할 때 값이 생긴다 |
| `narration_queue` | 3단계 | 리스·재시도 칼럼이 추측이고, `WHERE source='fallback'` 로 언제든 재구성 가능하다 |
| delta-since-seq 재개 | 3단계 | 재접속이 최초 접속과 **글자 그대로 같은 코드 경로**다. 7x7 스냅샷은 수백 바이트인 반면 재개는 링버퍼·보존 정책·오버런 폴백을 요구한다 |
| 4단계 액션 동사 | 4단계 | 유니온 멤버 추가는 순수 가산이고, 구현 없는 멤버는 `not_implemented` 분기와 죽은 검증기를 만든다. 옛 서버는 `ack{unknown_action}` 으로 거절할 뿐 크래시하지 않는다 |
| `narration/prompts/` | 2단계 | LLM이 없어 프롬프트가 없다. 디렉터리 위치와 파일 규약(`room.v1.ko.md`)은 `room_text.prompt_version` 칼럼으로 이미 고정됐다 |
| 접속자 표 | **영원히** | 접속은 살아 있는 소켓으로 정의되므로 프로세스보다 오래 살 수 없다. 영속화하면 크래시마다 청소해야 할 거짓 행만 생긴다 |
| 관심영역(interest management) | 규모 | `canSee(viewer, subject)` 가 유일한 관문이고 가시성 diff를 **대칭**으로 돌린다. 반경 조건이 붙어도 프로토콜은 한 글자도 안 바뀐다 |
| 진짜 인증 | 언젠가 | `players.account_id` + `accounts` 가 붙고 `token_hash` 가 그리 옮겨간다. `hello{token}` 핸드셰이크 모양은 그대로다 |

---

## 다음 (2단계)

바꿔야 하는 것은 **한 줄**이다:

```ts
// server/index.ts
const roomText = makeRoomTextService(world, q, staticRenderer, clock);
//                                          ^^^^^^^^^^^^^^ 여기만 llmRenderer 로
```

`RoomTextRenderer` 서명(`shared/narration.ts`)은 이미 최종형이고, `staticRenderer` 는
지워지는 게 아니라 **API 실패 시의 폴백으로 그대로 남는다**. 스키마 변경도, `ALTER TABLE` 도 없다.

같이 붙는 것: 캐시 히트가 `source='fallback'` 이면 그 텍스트를 provisional 로 즉시 서빙하고
동시에 생성을 등록한다. 확정되면 `(roomId, stateHash)` 를 보고 있던 **모든 세션**에
`log.replace` 를 보낸다 — 그러지 않으면 같은 방의 두 명이 영구히 다른 텍스트를 보게 되어
CLAUDE.md 20줄이 깨진다. 클라이언트는 이미 `log.replace` 를 처리하고 로그를
`log.id` 로 키잉하고 있다.
