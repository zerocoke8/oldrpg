# oldrpg — LLM 텍스트 머드

웹 브라우저에서 돌아가는 멀티플레이어 텍스트 머드. 세계의 묘사·NPC 대사·퀘스트를
LLM이 생성하지만, 게임 규칙과 상태는 전부 결정론적 코드가 소유한다.

설계 원칙과 로드맵은 [CLAUDE.md](./CLAUDE.md) 에 있다. 이 문서는 **지금 무엇이 만들어져
있고, 무엇이 왜 미뤄졌는가** 를 적는다.

---

## 현재: 3단계 완료 (이벤트 재렌더링)

1단계(서버 권위 이동 + WebSocket 동기화), 2단계(씨앗 → LLM → DB 고정, 좌표 락,
`state_hash` 캐시, 실패 시 폴백), 3단계(플래그, 영향 범위, 백그라운드 워커)가 끝났다.

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY 를 채운다 (없어도 돌아간다)
npm run dev            # 서버(8787) + 클라이언트(5173)
```

**키가 없으면** 서버는 결정론적 폴백 문장만 쓰고 나머지는 똑같이 돈다.
부팅 로그가 어느 쪽인지 알려준다.

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
- 처음 가는 방은 **폴백 문장이 즉시** 뜨고, 잠시 뒤 **그 줄이 조용히 교체**되며
  "새로 생성됨" 뱃지가 켜진다 (규칙 4). 두 번째 방문부터는 처음부터 확정본이다

세계를 바꿔 보려면 (`MUD_DEV=1 npm run dev:server` 로 띄운 뒤 서버 콘솔에):

```
flag guardian_slain true
```

- 영향권에 서 있으면 **"주변의 공기가 달라졌다"**, 밖이면 **"멀리서 무언가 무너지는 소리"**
- **서 있는 화면은 그대로다.** 새 묘사는 다시 들어가거나 살펴볼 때 나온다
- 상태창에 "파수꾼 처치됨" 이 뜬다. 되돌리면 옛 묘사가 그대로 복구된다

### 검증

```bash
npm run typecheck     # tsc --strict
npm run lint          # 규칙 1을 import 검사로 강제 (아래 참조)
npm test              # 1단계: 진짜 서버 + WebSocket 2개 + SQLite (64개 검사)
npm run test:pipeline # 2단계: 가짜 LLM(지연·실패·경합)으로 파이프라인 (56개 검사)
npm run test:events   # 3단계: 플래그 -> 영향 범위 -> 재생성 (44개 검사)
npm run test:browser  # 진짜 크로미움 창 2개. 스크린샷은 test/shots/
npm run test:all      # 셋 다
```

---

## 구조

```
shared/      두 쪽이 함께 import 하는 계약. 타입과 '런타임 검증기'가 같이 산다
server/
  engine/    맵·이동·플래그. 진실을 계산한다. narration/ db/ net/ 을 import 하지 않는다
  narration/ LLM 호출 · 프롬프트(파일) · 큐. DB 핸들을 잡지 않는다
  world/     engine + db + narration + net 을 조합하는 유일한 곳
             roomText.ts(플레이어 경로) / upgrade.ts(승급) / events.ts(세계 변화)
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

### 규칙 4는 프로토콜 속성이다

이동 처리는 두 단계다.

- **Phase A** (`await` 없음): `ack` + `self.patch` + `room.describe` + 모든 presence/room
  이벤트 + 재실자 로스터 줄
- **Phase B** (`await roomText()` 뒤): 서술 `log{narr}` **하나뿐**. 세션별 프로미스 체인.

(a) 이동이 절대 LLM 뒤에 서지 않고 (b) 방 A의 묘사가 이미 방 B에 선 플레이어에게
도착하는 인터리브가 **구조적으로 불가능**하다.
"서술 텍스트는 이동 확정보다 늦게 도착할 수 있다" 가 **클라이언트 계약**이다.

2단계에서는 한 겹 더 있다: Phase B 가 기다리는 것도 LLM 이 아니라 폴백 렌더러다.
모델은 백그라운드 큐에만 있다 (아래 2단계 절).

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

## 아직 뺀 것 (전부 순수 가산 경로)

| 미룬 것 | 언제 | 왜 지금이 아닌가 |
|---|---|---|
| `room_gen_lock` 표 | 워커를 별도 프로세스로 뗄 때 | **단일 프로세스로 가기로 했다.** 정확성은 PK + `ON CONFLICT DO NOTHING` + `UPDATE ... WHERE source='fallback'` 가 쥐고 있고(프로세스를 넘어서도 성립), 비용 중복은 `narration/queue.ts` 의 키 중복 제거가 막는다 |
| `npcs` / `npc_lines` | 4단계 | PK가 아직 추측이다. **SQLite는 PK를 ALTER 하지 못한다** — 지금 만들면 틀린 규약이 굳는다. `source`/`flags_json`/`prompt_version` 칼럼 규약과 `state_hash` 공식은 이미 고정됐으므로 그때 복사하면 된다 |
| `player_items` | 4단계 | 옳은 모양은 `players` 의 JSON 블롭이 아니라 `player_items(player_id, item_id, qty)` 다. 형태는 지금 정했고 표만 안 만들었다. `hp`/`max_hp` 는 반대로 지금 만들었다 — UI가 이미 표시하므로 |
| `player_seen_rooms` | 안개가 수천 칸이 될 때 | 지금은 `players.seen` JSON 배열. 통째로만 읽고 쓰며 조인이 없다. 와이어 타입은 그대로다 |
| 서사 로그 영속화 | 필요해지면 | 로그는 휘발성이다. 재접속하면 스냅샷이 `world` 로 세계의 '상태' 는 복원해 주므로, 놓친 '문장' 이 아쉬워질 때가 만들 신호다 |
| `narration_queue` **표** | 워커가 프로세스를 넘을 때 | 큐 자체는 `narration/queue.ts` 에 있다(메모리). 영속화가 필요해지는 것은 워커가 별도 프로세스가 될 때뿐이고, 그 전까지는 `WHERE source='fallback'`(인덱스 있음)로 언제든 재구성된다 |
| delta-since-seq 재개 | 3단계 | 재접속이 최초 접속과 **글자 그대로 같은 코드 경로**다. 7x7 스냅샷은 수백 바이트인 반면 재개는 링버퍼·보존 정책·오버런 폴백을 요구한다 |
| 4단계 액션 동사 | 4단계 | 유니온 멤버 추가는 순수 가산이고, 구현 없는 멤버는 `not_implemented` 분기와 죽은 검증기를 만든다. 옛 서버는 `ack{unknown_action}` 으로 거절할 뿐 크래시하지 않는다 |
| `narration/prompts/` | 2단계 | LLM이 없어 프롬프트가 없다. 디렉터리 위치와 파일 규약(`room.v1.ko.md`)은 `room_text.prompt_version` 칼럼으로 이미 고정됐다 |
| 접속자 표 | **영원히** | 접속은 살아 있는 소켓으로 정의되므로 프로세스보다 오래 살 수 없다. 영속화하면 크래시마다 청소해야 할 거짓 행만 생긴다 |
| 관심영역(interest management) | 규모 | `canSee(viewer, subject)` 가 유일한 관문이고 가시성 diff를 **대칭**으로 돌린다. 반경 조건이 붙어도 프로토콜은 한 글자도 안 바뀐다 |
| 진짜 인증 | 언젠가 | `players.account_id` + `accounts` 가 붙고 `token_hash` 가 그리 옮겨간다. `hello{token}` 핸드셰이크 모양은 그대로다 |

---

## 2단계 — 생성 파이프라인

### 규칙 4가 '구조' 다: 플레이어 경로에는 모델 호출이 없다

플레이어의 요청 경로(`world/roomText.ts`)에는 **결정론적 폴백 렌더러만** 있다.
LLM 은 백그라운드 큐(`world/upgrade.ts`)에만 존재한다. 그래서 실수로
기다리게 만들 방법이 없다 — 코드에 그 경로가 없다.

```
방 입장
 └─ 조회 ─┬─ hit(llm/authored) ──────────→ log{narr, source:'llm'}      끝
          └─ miss 또는 hit(fallback)
               ├─ 폴백 문장을 '즉시'      → log{narr, source:'fallback'} ← 플레이어는 여기서 끝
               └─ 승급 큐에 등록
                    └─ (백그라운드) LLM → UPDATE ... WHERE source='fallback'
                         └─ 재조회 → log.replace{id, text, source:'llm'} → 그 줄만 교체
```

`log.replace` 는 그 줄을 받은 **모든** 세션에 간다. 생성을 촉발한 한 명에게만
보내면 같은 방의 두 사람이 영구히 다른 문장을 보게 되고, 그건 CLAUDE.md 20줄
("그 시점부터 모든 플레이어에게 동일하다") 위반이다. 그리고 교체 문장은 우리가
방금 만든 것이 아니라 **재조회한 DB 값**이다 — 남이 먼저 확정했으면 그쪽이 진실이다.

### 좌표 락

두 겹이다.

| 층 | 무엇을 막나 |
|---|---|
| `narration/queue.ts` 의 `(roomId, stateHash)` 중복 제거 | 같은 방에 동시 진입한 두 명이 API 를 **두 번 호출**하는 것 (비용) |
| `PRIMARY KEY` + `ON CONFLICT DO NOTHING` + `UPDATE ... WHERE source='fallback'` | 두 개의 텍스트가 **기록**되는 것 (정확성). 프로세스를 넘어서도 성립한다 |

단일 프로세스로 가기로 했으므로 `room_gen_lock` 표는 여전히 없다.

### 실패

- LLM 오류·거절(`stop_reason:"refusal"`)·`max_tokens` 로 잘림·빈 응답 →
  **폴백 문장이 그대로 남는다.** 반쯤 만들어진 문장을 DB 에 영구 고정하지 않는다.
- 큐가 쿨다운(기본 60초)을 걸고, 3회 실패하면 그 (방, 상태)는 포기한다.
  계속 실패하는 방이 큐를 점유하지 않는다.
- 승급이 안 된 행은 언제든 `SELECT ... WHERE source='fallback'` 로 다시 찾을 수 있다
  (인덱스 있음). 그래서 재시도 큐를 영속화할 필요가 없다.

### 프롬프트는 파일이다

```
server/narration/prompts/
  room.v1.ko.md              # '# system' / '# user' 두 절. {{seed}} {{mood}} 치환
  moods/guardian_slain.md    # '# prompt'(LLM 지시) / '# fallback'(결정론 문장)
```

**파일명이 곧 `prompt_version`** 이고 `room_text.prompt_version` 에 기록된다.
문구를 바꿀 때는 같은 파일을 고치지 말고 `room.v2.ko.md` 를 새로 만들 것 —
같은 파일을 고치면 옛 텍스트가 어느 프롬프트로 만들어졌는지 잃는다.

### 모델

기본값 `claude-opus-5`. `.env` 의 `MUD_MODEL` 로 바꿀 수 있다.
`effort: "low"` 로 부른다 — 방 묘사는 2~3문장짜리 창작이라 깊은 추론이 필요 없고,
사고를 아예 끄는 것보다 이쪽이 안전하다. 19개 방이면 전체 생성 비용은 1센트 미만이다.

---

## 3단계 — 이벤트 재렌더링

CLAUDE.md 의 다섯 단계를 그 순서 그대로 구현했다 (`world/events.ts`).

```
events.setFlag("guardian_slain", true)
 ├─ 1. DB 커밋 -> 메모리 갱신        (이동 경로와 같은 순서)
 ├─ 2. 미리 써둔 문장을 '즉시'       near = 영향권에 서 있는 사람
 │                                   far  = 그 밖의 사람  (파일에서 읽는다)
 │     + world.flag (구조화 상태만)
 ├─ 3. 그 플래그를 '선언한' 방만 큐에  19개 중 7개
 ├─ 4. 워커가 하나씩 재생성 -> DB     (2단계의 큐를 그대로 쓴다)
 └─ 5. 새 텍스트는 '다음 입장부터'    ← 여기서 하는 일이 '없는' 것이 이행이다
```

### 5번이 이 단계에서 가장 중요하다

CLAUDE.md 63줄: "지금 그 방에 서 있는 플레이어의 화면을 갈아치우지 않는다."

**3단계는 `log.replace` 를 절대 보내지 않는다.** `log.replace` 는 2단계의
provisional → 확정 전용이다. 플래그가 바뀌어도 서 있는 사람은 이벤트 문장
한 줄만 받고, 새 묘사는 **다시 들어가거나 직접 살펴볼 때** 나타난다.
(`look` 은 '요청' 이므로 새 텍스트를 준다 — 갈아치우지 말라는 것은
*요청하지 않은* 교체를 말한다.)

사전 생성 덕분에 그 '다음 입장' 은 폴백을 거치지 않고 **처음부터 확정본**이다.

### 승급이 진행 중인 방에서 플래그가 바뀌면

가장 미묘한 인터리브다. 그 줄은 **들어갔을 때의 상태** 묘사이므로 그 상태의
확정본으로 교체되어야 한다. 그래서 승급 워커는 플래그를 '지금의 월드' 가 아니라
**그 행의 `flags_json`(= `state_hash` 의 preimage)** 에서 읽는다.

현재 월드에서 읽으면 두 가지가 한꺼번에 깨진다 — 서 있는 사람의 줄이 새 상태
문장으로 갈아치워지고(63줄 위반), 더 조용하게는 옛 `state_hash` 로 키잉된 행에
새 플래그로 만든 텍스트가 들어가 **캐시가 오염된다** (되돌리면 엉뚱한 문장이
복구된다). 둘 다 회귀 테스트가 있다.

### 플래그 공개는 옵트인

`engine/map.ts` 의 `WORLD_FLAGS` 에서 `broadcast: true` 로 선언한 것만 와이어에
나간다. 플래그는 쉽게 스포일러가 된다(`secret_door_found` 같은 것).
표시 문구(`label`)도 **서버가** 만든다 — 클라이언트가 key 로 문장을 조립하기
시작하면 불변식 (1)의 예외가 하나 더 생긴다.

### 무엇이 플래그를 켜는가

지금은 개발용 stdin 뿐이다 (`MUD_DEV=1`, 서버 콘솔에 `flag <key> <json>`).
프로토콜 표면이 0 이라 액션 유니온에 디버그 동사가 들어가지 않았다.
**4단계 전투가 부를 진입점이 `events.setFlag()` 이고, 그 시그니처는 이미 최종형이다.**

---

## 다음 (4단계 — NPC와 전투)

배선은 대부분 이미 있다.

- **전투가 세계를 바꾸는 입구**: `events.setFlag(key, value)`. 시그니처가 이미 최종형이다.
- **엔진의 규약**: 순수 함수가 `{effects: [...]}` 를 반환하고, 영속화는 호출자가 한다.
  `engine/move.ts` 주석에 `resolveAttack` 의 모양까지 적혀 있다.
- **액션 동사**(`attack`/`guard`/`use_item`/`flee`): 유니온 멤버 추가는 순수 가산이고,
  옛 서버는 `ack{unknown_action}` 으로 거절할 뿐 크래시하지 않는다.
- **NPC 대사**: `room_text` 와 같은 (씨앗 + 플래그) 패턴. `source`/`flags_json`/
  `prompt_version` 칼럼 규약과 `state_hash` 공식은 이미 고정됐으므로 복사하면 된다.
  **PK 는 그때 결정한다** — SQLite 는 PK 를 ALTER 하지 못하므로 지금 추측하면
  틀린 규약이 굳는다.
- **`player_items`**: 모양은 이미 정했다 (`player_items(player_id, item_id, qty)`).
