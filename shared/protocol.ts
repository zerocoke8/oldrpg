/* 클라이언트와 서버가 함께 import 하는 유일한 계약.
 *
 * 이 파일을 읽는 사람이 붙들어야 할 불변식 셋:
 *
 *  (1) 화면에 '문장'을 올리는 메시지는 `log` 하나뿐이다. 다른 모든 이벤트는
 *      구조화 데이터(미니맵 점, 재실자 목록, 좌표)만 싣는다. 클라이언트는
 *      문장을 조립하지 않는다 — 벽 부딪힘도, "○○ 님이 들어왔다"도.
 *      이것이 2단계를 '서버 안에서만 끝나는 교체'로 만든다.
 *
 *      명시적 예외 하나: HUD 크롬(고정 라벨 + 데이터)은 클라이언트가 만든다 —
 *      "HP", "동행 2", "탐색한 방 5", 좌표 표시. 이건 서사가 아니라 계기판이고,
 *      서버가 문자열로 내려보내면 오히려 지역화와 레이아웃이 서버에 묶인다.
 *      경계는 명확하다: '문장' 은 서버가, '라벨' 은 클라이언트가 만든다.
 *      client/ui/Status.tsx 가 이 예외를 쓰는 유일한 파일이다.
 *
 *  (2) `state_hash` 는 와이어에 절대 나타나지 않는다. 어떤 프로즈를 보낼지는
 *      서버가 결정한다. 클라이언트는 캐시 키를 들지 않고, 생성할 상태를
 *      지목할 문법도 갖지 않는다.
 *
 *  (3) 클라이언트는 모르는 필드 · 모르는 `t` · 모르는 enum '값'을 전부 무시하거나
 *      격하 처리한다 (kind→narr, source→fallback, reason→일반 문구, code→internal).
 *      throw 금지, 연결 종료 금지, never 기반 exhaustive switch 금지.
 *      이 한 줄 덕분에 2·3단계의 추가분 대부분이 비파괴적 변경이 된다.
 */

import type { PlayerId, RegionId, RoomId, Dir, Pos } from "./ids";
import type { JsonScalar } from "./json";

/** 메시지 유니온에 '깨는 변경'이 있을 때만 올린다. 새 이벤트 타입 추가는
 *  불변식 (3) 덕분에 버전을 올리지 않는다.
 *  hello/welcome 에서 1회만 교환하고 메시지마다 싣지 않는다 — 연결 중간에
 *  바뀔 수 없는 값을 이동 핫패스에 실을 이유가 없다.
 *  존재 이유는 하나: 클라이언트는 브라우저에 캐시된 정적 번들이라, 배포 후
 *  낡은 탭이 조용히 desync 하는 대신 "새로고침하세요"가 뜨게 하는 것. */
export const PROTOCOL_VERSION = 1;

/** 와이어가 '남'에 대해 아는 전부. hp 도 인벤토리도 없다.
 *  나중에 넓히는 건 가산이지만, 클라이언트가 의존한 뒤 좁히는 건 아니다. */
export interface PlayerBrief {
  id: PlayerId;
  name: string;
}

/** 서술 텍스트의 출처. 프로토타입의 "새로 생성됨" 뱃지가 프로토콜 변경 없이
 *  2단계에 켜지도록 지금부터 와이어에 있다. */
export type TextSource = "fallback" | "llm" | "authored";

/** 서버가 강제하는 값들. 클라이언트에 하드코딩하면 서버가 값을 바꾸는 순간
 *  조용히 어긋난다. welcome 으로 내려보내고 클라이언트는 그대로 쓴다. */
export interface Limits {
  sayMaxLen: number;
  unparsedMaxLen: number;
  nameMaxLen: number;
  actionsPerSec: number;
  resyncPerSec: number;
  framesPerSec: number;
  maxFrameBytes: number;
  pingIntervalMs: number;
  maxPending: number;
}

// ---------------------------------------------------------------------------
// CLIENT -> SERVER
//
// 키보드(client/input/keyboard.ts), 화면 D패드(client/ui/Dpad.tsx), 자유 텍스트
// (client/input/parse.ts)는 세 개의 '어댑터'이고 서버로 가기 전에 아래 Action
// 하나로 수렴한다 (charter 68-80줄). 새 입력 방식은 어댑터만 추가한다.
// 서버는 어느 어댑터에서 왔든 모든 필드를 다시 검증한다.
// ---------------------------------------------------------------------------

/** 좌표 필드가 하나도 없다는 점이 핵심이다. 클라이언트가 위치를 '주장'할
 *  문법 자체가 없으므로, 위조를 검증으로 막는 게 아니라 표현 불가능하게 만든다.
 *
 *  4단계 동사(attack/use_item/guard/flee)를 미리 선언하지 않는다: 유니온 멤버
 *  추가는 순수 가산이고, 구현 없는 멤버는 not_implemented 분기와 죽은 검증기를
 *  만든다. 옛 서버가 새 클라이언트를 만나면 ack{ok:false,"unknown_action"}으로
 *  거절될 뿐 크래시하지 않는다.
 *
 *  자유 텍스트 불변식: `unparsed` 는 1단계에 고정 문장으로 답한다. 미래에 LLM
 *  의도 추출을 붙이더라도 그 결과는 사람에게 '제안'으로 표시되고 사람이
 *  재제출해야 엔진에 닿는다. 모델이 고른 targetId 가 그대로 엔진에 들어가면
 *  규칙 1이 깨진다 — 검증 여부와 무관하게 그 경로가 존재해선 안 된다. */
export type Action =
  /** 한 칸 이동. 방향만 — 목표 좌표는 서버가 자기가 들고 있는 위치에서 계산한다. */
  | { type: "move"; dir: Dir }
  /** 프로토타입의 '살펴보기'. 현재 방 묘사 재출력. 상태를 바꾸지 않는다. */
  | { type: "look" }
  /** 같은 방에만 전달되는 발화. 1단계엔 UI가 없고 서버에만 구현되어 있으며,
   *  자동 인수 테스트가 '방 단위 팬아웃'을 검증하는 데 쓴다. */
  | { type: "say"; text: string }
  /** 클라이언트 파서가 명령으로 해석하지 못한 문자열. 그래도 보낸다:
   *  "그건 명령이 아니다"를 클라이언트가 판정하기 시작하면 그 판정 문장이
   *  클라이언트에 살게 되고, 불변식 (1)이 깨진다. */
  | { type: "unparsed"; raw: string }
  /** 클라이언트가 desync 를 의심할 때 전체 스냅샷을 다시 요청한다.
   *  Action 인 이유: 서버가 도착 순서대로 처리하므로 스냅샷이 자동으로
   *  '이 seq 까지 반영된 상태'가 되고, ack 가 그 seq 를 확정해 준다. */
  | { type: "resync" }
  /** 이 방의 적과 교전을 시작한다. 한 번 누르면 '계속' 서로 때린다 —
   *  이 액션은 한 번의 타격이 아니라 '자동 공격 켜기' 다. 이미 교전 중이면
   *  아무 일도 없다(멱등). */
  | { type: "attack" }
  /** 스킬을 예약한다. 다음 스윙(최대 0.5초)에 기본 공격을 '대신해' 발동한다.
   *  큐는 하나 — 다시 누르면 덮어쓴다(나중 입력이 이긴다).
   *  쿨다운은 서버가 강제한다. 클라이언트의 쿨다운 표시는 안내일 뿐이다. */
  | { type: "skill"; skillId: string }
  /** 교전을 끊는다. 방을 벗어나도 같은 효과다. */
  | { type: "stop" }
  /** NPC 에게 말을 건다. 인사(greet)를 듣고 열려 있는 주제 목록을 받는다. */
  | { type: "talk"; npcId: string }
  /** 그 주제에 대해 묻는다. 잠긴 주제는 서버가 거절한다 —
   *  클라이언트의 목록은 안내일 뿐 권위가 아니다. */
  | { type: "ask"; npcId: string; topic: string }
  /** 가방의 물건을 쓴다. CLAUDE.md 76줄이 처음부터 적어 두었던 그 모양이다.
   *  ★ 전투 중이면 '다음 스윙에' 발동한다 — 스킬과 완전히 같은 규칙이고,
   *    큐도 같은 한 자리를 쓴다(나중 입력이 이긴다). 전투 밖이면 즉시.
   *  가지고 있는지, 쓸 수 있는 것인지는 서버가 다시 본다 — 클라이언트의
   *  가방 목록은 안내일 뿐 권위가 아니다. */
  | { type: "use_item"; itemId: string }
  /** 길드 접수원에게 승급을 신청한다. 등록(0 -> 1)과 그 뒤의 승급이 같은
   *  동사인 이유: 플레이어가 하는 일이 "다음 등급을 신청한다" 하나이고,
   *  요구 조건이 비어 있느냐 아니냐는 데이터의 차이일 뿐이다.
   *  자격도 소지품도 서버가 다시 본다 — 클라이언트는 신청만 한다. */
  | { type: "promote"; npcId: string }
  /* 임무. 받는 것과 내는 것을 나눈 이유: 하나로 두면 "받자마자 낸다" 를
     서버가 구별할 수 없고, 오조작이 조용히 성공한다. */
  | { type: "accept_mission"; npcId: string; missionId: string }
  | { type: "turn_in"; npcId: string; missionId: string }
  /* 돌려주기. NPC 를 받지 않는다 — 못 끝낼 임무를 들고 게시한 사람에게
     돌아가야 한다면, 그 사람이 사라진 경우 탈출구가 없다. */
  | { type: "abandon_mission"; missionId: string };

export interface Hello {
  t: "hello";
  pv: number;
  /** localStorage["mud.token." + slot]. 없으면 신규 캐릭터를 만든다.
   *  '알 수 없는 토큰'도 오류가 아니라 신규 생성으로 흡수한다 — 그러지 않으면
   *  토큰 존재 여부를 묻는 오라클이 된다. */
  token: string | null;
  /** 최초 접속에만 참고. 서버가 정제하고 확정 이름은 welcome 으로 돌려준다.
   *  resume 시에는 무시한다 — 탭을 다시 열었다고 이름이 바뀌지 않는다. */
  name: string | null;
}

export interface ActionMsg {
  t: "action";
  /** '연결' 단위, 1부터 엄격 증가. 재접속하면 1로 리셋된다.
   *  서버의 비교 대상 lastSeq 도 반드시 연결 단위다 — 플레이어 단위로 두면
   *  재접속한 클라이언트가 seq 1을 보내고 전부 거절당해, 미니맵에는 살아 있는데
   *  움직일 수 없는 상태가 된다. */
  seq: number;
  action: Action;
}

export interface ClientPong {
  t: "pong";
  nonce: number;
}

export type ClientMsg = Hello | ActionMsg | ClientPong;

// ---------------------------------------------------------------------------
// SERVER -> CLIENT : 페이로드
// ---------------------------------------------------------------------------

export interface SelfState {
  id: PlayerId;
  name: string;
  pos: Pos;
  hp: number;
  maxHp: number;
  /** 밟아 본 방들. 미니맵 안개. 서버 소유이고 self.patch 로만 갱신된다. */
  seen: RoomId[];
  /** 가방. 0개인 것은 실리지 않는다 (표에 행이 없다는 것과 같은 뜻이다). */
  items: ItemStack[];
  /** 길드 등급. 0 은 미등록. 이름은 서버가 붙인다 — 클라이언트가 숫자로
   *  문구를 조립하지 않는다 (프로토콜 불변식 1과 같은 이유). */
  rank: RankView;
  /** 진행 중인 임무. 재접속해도 일지가 복원돼야 하므로 스냅샷이 싣는다. */
  missions: MissionView[];
}

/** 길드 등급. 숫자와 이름이 함께 온다. */
export interface RankView {
  level: number;
  /** 미등록(0)이면 null. */
  name: string | null;
}

/** 가방의 한 칸. 이름은 서버가 붙인다 — 클라이언트가 id 로 문구를 조립하지
 *  않는다 (프로토콜 불변식 1과 같은 이유). */
export interface ItemStack {
  id: string;
  name: string;
  qty: number;
  /** 쓸 수 있는 것인가. 안내일 뿐이고 판정은 서버가 다시 한다. */
  usable: boolean;
}

/** 미니맵이 그릴 격자. 1단계는 7x7 전체를 그대로 보낸다 — 클라이언트 예측을
 *  '항상 정확'하게 만들고, 새로고침 후에도 안개 칸의 벽/바닥 구분이 복원된다.
 *  규모에서는 seen 집합 + 한 칸 테두리만 남기고 나머지를 '#'로 마스킹해 보낸다.
 *  타입이 그대로이므로 이 결정은 나중에 되돌릴 수 있다. */
export interface RegionView {
  id: RegionId;
  name: string;
  width: number;
  height: number;
  tiles: string[];
}

/** 방의 구조화 상태. 프로즈는 한 글자도 없다. */
export interface RoomView {
  roomId: RoomId;
  pos: Pos;
  /** 자기 자신을 제외한 이 방의 다른 플레이어들.
   *  유예(linger) 중인 세션도 포함한다 — snapshot.presence 와 반드시 일치해야
   *  하고, 둘이 어긋나면 '점 없는 유령'이 생긴다. */
  occupants: PlayerBrief[];
  /** 이 방의 NPC 들. 이름만 실린다 — 대사는 말을 걸어야 나온다. */
  npcs: NpcBrief[];
  /** 살아 있는 적이 있는가. 이름이 아니라 불리언인 이유: 적의 이름과 상태는
   *  교전을 시작해야(combat.start) 알 수 있고, 그 전에 필요한 것은
   *  '공격 버튼을 보여줄까' 하나뿐이다. 문장은 log 가 나른다. */
  hasEnemy: boolean;
}

export interface PresenceEntry {
  player: PlayerBrief;
  pos: Pos;
}

/** 방에 있는 NPC. 이름만 — 대사는 말을 걸어야 나온다.
 *  방 묘사에 NPC 대사가 묻히지 않게, 그리고 지나가기만 하는 방에서 생성이
 *  돌지 않게 (비용) 하는 결정이다. */
export interface NpcBrief {
  id: string;
  name: string;
  /** 길드 업무(등급 접수)를 보는가. 커맨드 창이 '승급 신청' 을 이 사람에게만
   *  보여 준다. 안내일 뿐이고 자격 판정은 서버가 다시 한다. */
  guild?: boolean;
}

/** 일지에 실리는 임무 하나. 진행 중인 것만 실린다 — 끝낸 것까지 쌓이면
 *  목록이 영원히 자라고, 일지는 '할 일' 이지 이력이 아니다. */
export interface MissionView {
  id: string;
  name: string;
  brief: string;
  progress: number;
  /** 목표 수. progress/goal 을 클라이언트가 그대로 그린다 (문구 조립이 아니라
   *  숫자 두 개다 — 프로토콜 불변식 1을 어기지 않는다). */
  goal: number;
  /** 목표를 채웠는가. 제출하러 가야 한다는 뜻이다. */
  done: boolean;
}

/** 게시된 임무 하나. NPC 에게 말을 걸었을 때 실린다.
 *  아직 게시되지 않은(플래그가 안 켜진) 임무는 아예 오지 않는다 — 잠긴 대화
 *  주제와 같은 이유로 스포일러이기 때문이다. */
export interface MissionOffer {
  id: string;
  name: string;
  brief: string;
  /** 보수를 사람이 읽는 문장으로. 서버가 만든다 — 클라이언트가 아이템 이름과
   *  수량을 조립하지 않는다. */
  reward: string;
  /** 받는 데 필요한 등급. 0 이면 아무나. */
  minRank: number;
  /** open 받을 수 있다 · locked 등급이 모자란다 · taken 진행 중 · complete 제출만 남았다.
   *  ★ 등급이 모자라도 목록에는 나온다 (문의 minRank 와 같은 판단이다 —
   *    무엇을 하면 되는지는 감출 이유가 없다). */
  state: "open" | "locked" | "taken" | "complete";
  progress: number;
  goal: number;
}

/** 지금 열려 있는 대화 주제 하나. 잠긴 주제는 아예 오지 않는다 —
 *  "무엇을 물을 수 있는지" 자체가 세계의 상태이고, 스포일러가 될 수 있다. */
export interface TopicView {
  id: string;
  label: string;
}

/** 말을 건 결과. 구조화 데이터만 — 대사 문장은 뒤따르는 log 가 싣는다. */
export interface DialogueView {
  npc: NpcBrief;
  topics: TopicView[];
  /** 이 사람이 게시하는 임무. 게시 안 된 것과 이미 낸 것은 오지 않는다. */
  missions: MissionOffer[];
}

/** 전투 중인 적. 구조화 데이터만 — 문장은 log 가 싣는다. */
export interface EnemyView {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
}

/** 스킬 하나의 현재 상태. 쿨다운은 서버가 강제하고, 이건 표시용이다. */
export interface SkillView {
  id: string;
  name: string;
  /** 쿨다운이 끝나기까지 남은 밀리초. 0 이면 지금 쓸 수 있다.
   *  절대 시각이 아니라 '남은 시간' 인 이유: 클라이언트 시계를 믿지 않는다. */
  readyInMs: number;
}

/** 내가 지금 하고 있는 전투. 없으면 null. */
export interface CombatView {
  enemy: EnemyView;
  /** 자동 공격이 켜져 있는가. stop 하면 false 가 되지만 적은 계속 때린다. */
  engaged: boolean;
  /** 예약된 스킬 (다음 스윙에 발동). */
  queuedSkill: string | null;
  /** 예약된 아이템. queuedSkill 과 '한 자리를 나눠 쓴다' — 둘 다 채워지는
   *  일은 없다. 나중 입력이 앞의 것을 덮어쓴다. */
  queuedItem: string | null;
  skills: SkillView[];
  /** 지금 적이 노리고 있는 사람. 누적 데미지가 가장 높은 사람이다. */
  targetId: PlayerId | null;
}

/** 클라이언트에 공개되는 월드 플래그 하나.
 *
 *  '모든' 플래그가 여기 오지는 않는다 — engine/map.ts 의 WORLD_FLAGS 에서
 *  broadcast: true 로 선언한 것만이다. 플래그는 쉽게 스포일러가 된다
 *  (secret_door_found 같은 것), 그래서 공개는 옵트인이다.
 *
 *  label 은 '서버' 가 만든다. 클라이언트가 key 로 문구를 조립하기 시작하면
 *  불변식 (1)의 예외가 하나 더 생기고, 3·4단계가 클라이언트 배포를 요구하게 된다. */
export interface WorldFlagView {
  key: string;
  value: JsonScalar;
  /** 표시용 문구. 꺼진 상태처럼 표시할 것이 없으면 null. */
  label: string | null;
}

/** 액션이 적용되지 않은 이유. 기계 판독용이고 프로즈를 싣지 않는다
 *  (프로즈는 log 로 온다).
 *
 *  ★ '액션에 귀속 가능한' 모든 실패가 여기 있다. 이것이 계약이다:
 *  seq 를 뽑아낼 수 있는 모든 실패는 반드시 ack 로 답한다. error 로 답하면
 *  그 액션의 pending 엔트리가 클라이언트 큐에 영원히 남아, 예측 위치가
 *  서버와 한 칸 어긋난 채 연결이 끝날 때까지 복구되지 않는다. */
export type RejectReason =
  | "blocked" // 벽 또는 격자 밖. 정상적인 엔진 판정이다.
  | "rate_limited" // Limits.actionsPerSec 초과. 액션만 버리고 연결은 유지.
  | "too_long" // say/unparsed 길이 초과. 자르지 않고 거절한다.
  | "empty" // 정제 후 남은 것이 없다.
  | "bad_args" // 아는 type 인데 페이로드가 스키마에 안 맞는다.
  | "unknown_action" // 이 서버가 구현하지 않은 variant
  | "not_ready" // hello 완료 전, 또는 종료 처리 중
  | "internal"; // 엔진/DB 실패. 그래도 ack 다 — pending 을 비워야 하니까.

/** 액션에 '귀속 불가능한' 계약 위반. 플레이어가 한 일이 아니라 클라이언트가
 *  한 일이다. 개발자 콘솔이나 배너로 가고 서사 로그에는 절대 찍히지 않는다.
 *
 *  ★ error 는 '항상' 연결을 끊는다. 그래서 pending 큐가 살아남을 수 없고,
 *  ErrorEvent 에 seq 필드가 없어도 재조정이 완전하다. */
export type ErrorCode =
  | "protocol_version" // 클라이언트 번들이 낡았다
  | "bad_message" // seq 를 뽑을 수조차 없는 프레임
  | "bad_seq" // seq 역행 또는 중복
  | "replaced" // 같은 토큰의 새 소켓이 이 캐릭터를 가져갔다
  | "flooding" // 프레임 폭주 (액션 레이트리밋과 별개, 소켓 계층)
  | "shutdown"
  | "internal";

export type LogKind =
  | "narr" // 방 묘사와 세계의 산문
  | "sys" // 엔진 피드백: 벽 부딪힘, 안내 배너
  | "presence" // "○○ 님이 들어왔다"
  | "say" // 플레이어 발화 (speaker 필드가 반드시 있다)
  | "npc" // NPC 의 대사
  | "world" // 세계가 바뀌었다 — "멀리서 무언가 무너지는 소리가 들린다"
  | "combat" // 평범한 타격 한 번. 연속된 combat 줄은 클라이언트가 접는다.
  //          스킬·치명타·사망은 good/bad 로 보내서 접히지 않고 드러나게 한다.
  | "good" // 4단계 결과용. 프로토타입 색상표와 1:1로 맞춰 두어
  | "bad"; // 나중에 클라이언트 색상 테이블을 고칠 일이 없게 한다.

// ---------------------------------------------------------------------------
// SERVER -> CLIENT : 메시지 (14종)
// ---------------------------------------------------------------------------

export interface Welcome {
  t: "welcome";
  pv: number;
  self: PlayerBrief;
  /** 원문 무기명 토큰. 접속마다 같은 값이 돌아온다. localStorage 에 그대로 저장한다.
   *  DB 에는 sha256 만 있다. 이게 1단계 신원 이야기의 전부다. */
  token: string;
  serverTime: number;
  limits: Limits;
}

/** 전체 상태. 최초 접속·재접속·resync 모두 '같은 코드 경로'다.
 *  7x7에 몇 명이면 수백 바이트라, delta-since-seq 재생을 위해 연결마다
 *  링버퍼와 보존 정책과 오버런 폴백을 만드는 것은 손해다. */
export interface Snapshot {
  t: "snapshot";
  reason: "connect" | "resync";
  /** 이 스냅샷에 반영된 마지막 액션 seq. 최초 접속은 0, resync 는 그 resync
   *  액션 자신의 seq. 클라이언트는 이 값으로 pending 큐를 정리하되,
   *  자기 발신 카운터를 되감지는 않는다 (Math.max 로만 전진). */
  ackSeq: number;
  self: SelfState;
  region: RegionView;
  room: RoomView;
  /** 지금 나에게 보이는 다른 플레이어 전원(자기 제외).
   *  1단계에서 '보인다' = '세션이 살아 있고(유예 포함) 같은 region 에 있다'. */
  presence: PresenceEntry[];
  /** 공개된 월드 플래그의 현재 값. 재접속한 클라이언트가 세계의 상태를
   *  복원할 수 있어야 하므로 스냅샷이 실어야 한다 — world.flag 델타만
   *  있으면 접속 전에 일어난 일을 영영 모른다. */
  world: WorldFlagView[];
  /** 진행 중인 전투. 새로고침해도 전투가 이어지므로 스냅샷이 실어야 한다.
   *  (세션이 유예로 살아남기 때문에 전투도 살아남는다.) */
  combat: CombatView | null;
}

/** 액션 하나당 정확히 하나. 확인이자 거절이자 재조정 반송자다 —
 *  메시지 하나가 세 가지 일을 하므로 셋이 서로 어긋날 수가 없다. */
export interface Ack {
  t: "ack";
  seq: number;
  ok: boolean;
  reason: RejectReason | null;
  /** 이 seq 를 처리한 뒤의 서버 권위 위치. 성공이든 거절이든 '항상' 싣는다.
   *  그 대칭성이 클라이언트 보정 경로에서 if(ok) 분기를 삭제하고,
   *  그래서 롤백 코드가 존재하지 않는다. */
  pos: Pos;
}

/** 구조화된 방 상태. 이동 수락 시·look 시·snapshot 안에서 온다. 프로즈 없음. */
export interface RoomDescribe {
  t: "room.describe";
  room: RoomView;
}

/** 자기 자신에 대한 부분 갱신. x/y 는 여기 '절대' 없다 —
 *  자기 위치의 출처는 ack 와 snapshot 둘뿐이고, 두 번째 출처를 만들면
 *  늦게 도착한 패치가 이미 정산된 위치를 되감는다. */
export interface SelfPatch {
  t: "self.patch";
  hp?: number;
  maxHp?: number;
  seen?: RoomId[];
  /** 등급이 올랐다. */
  rank?: RankView;
  /** 일지가 바뀌었다 (수락·진행·제출). 델타가 아니라 전부 — 가방과 같다. */
  missions?: MissionView[];
  /** 지역이 바뀌었다. 새 지역의 격자 전체가 실린다.
   *
   *  ★ 여기 있는 것은 '지도' 이지 '위치' 가 아니다 — 위쪽 주석의 금지는
   *    x/y 에 대한 것이고, 그 이유(늦게 온 패치가 정산된 위치를 되감는다)는
   *    격자에 해당하지 않는다. 격자는 pos.region 의 함수라 순서가 뒤집혀도
   *    같은 값으로 수렴한다.
   *
   *  ★ 스냅샷을 다시 보내지 않는 이유: 스냅샷은 pending 큐를 정리하는
   *    부수효과가 있어서, 문을 지나는 순간 아직 응답 안 온 액션들이 사라진다.
   *    지역 이동은 그냥 이동이므로 그런 일이 있어서는 안 된다.
   *
   *  다른 지역의 지도는 영영 가지 않는다 — 이것이 서버측 안개다. */
  region?: RegionView;
  /** 가방이 바뀌었다. 델타가 아니라 '전부' 다 — 칸이 열 개를 넘을 일이
   *  없으므로 델타 프로토콜을 만들 이유가 없고, 통째로 보내면 어긋날 수 없다. */
  items?: ItemStack[];
}

// --- presence 계열: 미니맵 피드. 수신자 = 나를 볼 수 있는 모두. ---
// join/leave 는 '접속/종료'가 아니라 '내 시야에 들어옴/벗어남'이다.
// reason 필드가 없어서 "반경 밖으로 걸어나감"과 "탭을 닫음"이 와이어에서
// 구별 불가능하다 — 거리 탐침으로 남의 위치를 알아낼 수 없다.
// 이 계열은 설계상 손실 허용이다: 규모에서 throttle·coarsen·withhold 된다.
//
// join 은 player.id 기준 '멱등 upsert', leave 는 모르는 id 에 대해 'no-op' 이다.
// 이 두 성질이 유예(linger)와 소켓 교체를 조용하게 만든다.

export interface PresenceJoin {
  t: "presence.join";
  player: PlayerBrief;
  pos: Pos;
}
/** from 필드가 없다: 클라이언트가 이미 이전 위치를 들고 있고, 최초 목격은
 *  join 이 덮는다. 전 세계 배열이 아니라 한 명의 {playerId,pos}를 싣는 것이
 *  규모에서 '집계로 내용만 교체'를 가능하게 한다(메시지 타입 교체가 아니라). */
export interface PresenceMove {
  t: "presence.move";
  playerId: PlayerId;
  pos: Pos;
}
export interface PresenceLeave {
  t: "presence.leave";
  playerId: PlayerId;
}

// --- room 계열: 서사 피드. 수신자 = 그 방의 재실자. ---
// presence 계열과 구조적으로 분리한 이유: 팬아웃이 아파지면 제일 먼저 하는 일이
// presence 를 5Hz로 throttle 하고 중간 위치를 버리는 것인데, 하나로 합쳐 뒀다면
// 그 throttle 이 "○○이 들어왔다"를 조용히 삼킨다.
// 이 계열은 절대 버려지지도 coarsen 되지도 않는다.

/** playerId 가 아니라 PlayerBrief 전체를 싣는다: 규모에서 presence 피드는
 *  거칠어지거나 보류될 수 있지만 이 계열은 언제나 정확해야 하므로,
 *  수신자가 presence 맵에 그 사람이 없어도 이름을 알 수 있어야 한다. */
export interface RoomEnter {
  t: "room.enter";
  player: PlayerBrief;
  fromDir: Dir | null;
}
export interface RoomLeave {
  t: "room.leave";
  playerId: PlayerId;
  toDir: Dir | null;
}

/** 화면에 문장을 올리는 '유일한' 메시지.
 *  1단계에는 server/narration/ 이 만든 결정론 텍스트가, 2단계에는 같은 필드에
 *  LLM 출력이 실린다. 클라이언트 렌더러는 한 줄도 바뀌지 않는다. */
export interface LogEvent {
  t: "log";
  /** 이 줄의 주소. '수신자별'로 스코프된 불투명 문자열이며 순서 정보를 담지
   *  않는다(전역 단조 카운터면 남의 활동량이 샌다).
   *  클라이언트는 로그 리스트를 배열 인덱스가 아니라 이 id 로 키잉해야 한다 —
   *  그것이 이 필드의 진짜 목적이다. 규칙 4의 "완료되면 조용히 교체한다"에
   *  와이어 표현을 주고, 나중에 붙이려면 자료구조를 통째로 갈아야 한다. */
  id: string;
  kind: LogKind;
  text: string;
  /** kind==="say" 일 때만. 플레이어 문자열이 서사 문장에 합성되지 않고
   *  구조화 필드로 분리되므로, say 로 presence 줄을 위조할 수 없다. */
  speaker?: PlayerBrief;
  roomId?: RoomId;
  source?: TextSource;
}

/** 이미 보낸 로그 줄의 텍스트만 조용히 교체한다(스크롤도 하이라이트도 안 건드림).
 *  1단계 서버는 이 메시지를 '절대' 보내지 않는다. 그래도 1단계 클라이언트가
 *  처리한다(약 10줄). 2단계에 캐시 미스가 나면 폴백 문장을 provisional 로 먼저
 *  보내고, 생성이 끝나면 이걸로 갈아끼운다 — 플레이어를 LLM 앞에 세우지 않는다.
 *
 *  3단계 재렌더링에는 쓰지 않는다. charter 63줄이 "지금 그 방에 서 있는
 *  플레이어의 화면을 갈아치우지 않는다"이고, 새 텍스트는 다음 입장부터
 *  평범한 room.describe + log 로 적용된다. 이 이벤트는 provisional→확정 전용이다. */
export interface LogReplace {
  t: "log.replace";
  id: string;
  text: string;
  source: TextSource;
}

/* ── 전투 ──────────────────────────────────────────────────────────────
   실시간이다. attack 한 번이 '자동 공격 켜기' 이고, 그 뒤로는 서버가 밀어준다.
   0.5초 간격이라 모델을 기다릴 수 없으므로 전투 문장은 전부 결정론적이다
   (규칙 4). LLM 은 나중에 '전투 요약' 이나 미리 생성해 둔 문장 풀로 들어온다.

   HP 는 combat.update 가 나르고, 문장은 log 가 나른다 — 언제나처럼 분리되어
   있다. 그래서 매 스윙마다 두 종류가 함께 간다. */

export interface CombatStart {
  t: "combat.start";
  combat: CombatView;
}

/** 매 스윙의 구조화 결과. 문장은 뒤따르는 log 가 싣는다. */
export interface CombatUpdate {
  t: "combat.update";
  enemyHp: number;
  /** 적이 지금 노리는 사람 (누적 데미지 최대). 바뀌었을 때만 실린다. */
  targetId?: PlayerId | null;
  /** 예약된 스킬이 소모됐거나 새로 예약됐을 때. */
  queuedSkill?: string | null;
  queuedItem?: string | null;
  /** 쿨다운이 바뀐 스킬들. */
  skills?: SkillView[];
  engaged?: boolean;
}

export interface CombatEnd {
  t: "combat.end";
  reason: "victory" | "defeat" | "left" | "disengaged" | "gone";
}

/** 세계가 바뀌었다. 구조화 데이터만 — 문장은 뒤따르는 log{kind:"world"} 가 싣는다.
 *
 *  ★ 이 이벤트는 '방 묘사를 갈아치우라' 는 뜻이 아니다. charter 63줄:
 *    "지금 그 방에 서 있는 플레이어의 화면을 갈아치우지 않는다."
 *    새 텍스트는 '다음 입장부터' 적용된다 (또는 플레이어가 직접 살펴볼 때).
 *    그래서 3단계는 log.replace 를 절대 쓰지 않는다 —
 *    log.replace 는 provisional -> 확정 전용이다. */
export interface WorldFlagEvent {
  t: "world.flag";
  flag: WorldFlagView;
}

/** 말을 걸었다 / 주제 목록이 바뀌었다. 대사 문장은 log{kind:"npc"} 가 나른다.
 *
 *  ★ 3단계와 같은 규칙이 여기에도 있다: 세계가 바뀌어서 대사가 재생성돼도
 *    화면에 이미 찍힌 대사를 갈아치우지 않는다. 다음에 물었을 때 새 대사가
 *    나온다. log.replace 는 2단계의 provisional -> 확정 전용이다. */
export interface NpcDialogue {
  t: "npc.dialogue";
  dialogue: DialogueView;
}

export interface ServerPing {
  t: "ping";
  nonce: number;
}

/** 계약 위반. 서사 로그에 절대 찍히지 않는다. 항상 연결이 종료된다. */
export interface ErrorEvent {
  t: "error";
  code: ErrorCode;
  message: string;
  /** 클라이언트 재접속 루프가 switch 없이 읽는 값.
   *  protocol_version → false (새로고침 안내),
   *  replaced         → false (안 그러면 같은 탭 두 개가 무한 강퇴 핑퐁을 한다),
   *  그 외            → true (백오프 재접속). */
  reconnect: boolean;
}

export type ServerMsg =
  | Welcome
  | Snapshot
  | Ack
  | RoomDescribe
  | SelfPatch
  | PresenceJoin
  | PresenceMove
  | PresenceLeave
  | RoomEnter
  | RoomLeave
  | LogEvent
  | LogReplace
  | CombatStart
  | CombatUpdate
  | CombatEnd
  | NpcDialogue
  | WorldFlagEvent
  | ServerPing
  | ErrorEvent;
// 서버->클라이언트 19종, 클라이언트->서버 3종(액션 variant 11종). 이게 전부다.
//
// world.flag 를 추가하면서 PROTOCOL_VERSION 을 올리지 않았다: 불변식 (3)에
// 따라 옛 클라이언트는 모르는 t 를 무시하고 계속 돈다. 깨는 변경이 아니다.
