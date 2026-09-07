/* 게임에 등장하는 '모든' 한국어 문장이 사는 곳.
 *
 * 왜 engine/ 이 아니라 여기인가: 클라이언트가 문장을 조립하지 않는다는 것이
 * 프로토콜 불변식 (1)이고, 그러면 문장은 서버 어딘가에 있어야 한다.
 * engine/ 에 두면 문구를 고칠 때마다 '진실을 계산하는 코드'를 건드리게 된다.
 * 2단계에 이 문장들 중 일부가 LLM 출력으로 바뀌어도 engine/ 은 그대로다.
 *
 * ★ 여기 있는 것은 '틀' 이다. 세계가 어떤 곳인지를 말하는 부분(부활 지점의
 *   감촉, "어둠 속에서" 같은 텍스처)은 prompts/voice.ko.md 가 소유한다 —
 *   charter 139줄대로, 코드에 박아 두면 세계를 갈아끼울 때 그 문장만 옛
 *   세계에 남는다. 실제로 그랬다.
 *
 * 이 파일은 상태를 읽지도 쓰지도 않는다. 부팅에 voice 를 한 번 읽어 틀에
 * 끼울 뿐이고, 그 뒤로는 문자열만 만든다. */

import type { Dir } from "../../shared/ids";
import { loadVoice } from "./prompts";

/** 방위의 한국어 이름. Dir 는 shared/ 소유이고 그 '표시'만 여기 있다. */
const DIR_KO: Readonly<Record<Dir, string>> = {
  north: "북쪽",
  south: "남쪽",
  east: "동쪽",
  west: "서쪽",
};

export const dirKo = (d: Dir): string => DIR_KO[d];

/* 부팅에 한 번. 요청마다 디스크를 때리지 않는다 (prompts.ts 와 같은 규칙). */
const voice = loadVoice();
const fill = (tpl: string, vars: Record<string, string>): string => {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  return out;
};

export const lines = {
  welcome: "화살표로 이동, Enter로 살펴보기. 다른 탭을 열면 두 번째 모험가가 된다.",

  // ── 이동 ──────────────────────────────────────────────────────────────
  blocked: "단단한 벽이 앞을 막는다.",
  /** 문은 있는데 아직 열리지 않았다. '벽' 과 다른 문장을 주는 것이 지역
   *  다중화의 유일한 UI 다 — 미니맵에는 문이 그려지지 않으므로(벽 자리에 있다)
   *  플레이어가 문의 존재를 아는 경로는 이 한 줄뿐이다. */
  sealed: "봉인된 문이다. 아직 열리지 않는다.",
  /** 등급이 모자라 못 지나간다. 벽·봉인과 달리 '무엇이 필요한지' 를 말해 준다 —
   *  자격 문제는 감출 이유가 없고, 감추면 플레이어가 할 일을 알 수 없다. */
  rankUp: (name: string) => `길드 등급이 ${name}(으)로 올랐다.`,
  rankMax: "더 오를 등급이 없다.",
  rankShort: (name: string, need: string) => `${name} 승급에는 ${need}가 더 필요하다.`,
  rankFailed: "승급 처리 중 무언가 잘못됐다.",
  notGuild: (name: string) => `${name}은(는) 길드 업무를 보지 않는다.`,
  needRank: (name: string) => `길드 등급이 모자란다. ${name} 이상이어야 지나갈 수 있다.`,

  // ── presence: 방 단위 서사 피드 ──────────────────────────────────────
  /** 상대가 '내 방으로' 들어왔다. fromDir 이 null 이면 접속으로 나타난 것이다. */
  entered: (name: string, fromDir: Dir | null): string =>
    fromDir
      ? `${name} 님이 ${dirKo(fromDir)}에서 들어왔다.`
      : fill(voice.appear, { name }),
  /** 상대가 '내 방에서' 나갔다. toDir 이 null 이면 접속이 끊긴 것이다. */
  left: (name: string, toDir: Dir | null): string =>
    toDir ? `${name} 님이 ${dirKo(toDir)}으로 사라졌다.` : fill(voice.vanish, { name }),
  /** 내가 들어간 방에 이미 서 있던 사람들. Phase A 에서 나간다 —
   *  room.occupants 에서 순수 파생되므로 await 가 필요 없다. */
  roster: (names: readonly string[]): string =>
    `이곳에 ${names.join(", ")} 님이 서 있다.`,

  // ── 자유 텍스트 ───────────────────────────────────────────────────────
  /** charter 의 자유 텍스트 불변식: 1단계는 고정 문장으로 답한다.
   *  미래에 LLM 의도 추출을 붙이더라도 그 결과는 '제안'으로 표시되고
   *  사람이 재제출해야 엔진에 닿는다. */
  unparsed: (raw: string): string => `"${raw}" — 무엇을 하려는지 알 수 없다.`,
  sayEmpty: "할 말이 없다.",
  sayTooLong: "그렇게 긴 말은 숨이 차서 못 한다.",
  /* 계정. 문장이 코드에 인라인되지 않도록 여기 둔다 — 화면에 뜨는 것은
     error{message} 이고, 그건 이미 명문화된 예외 채널이다.
     ★ 로그인 거절이 한 문장인 것이 요점이다. '그런 이름이 없다' 와 '비밀번호가
       틀렸다' 를 갈라 말하면 그 자체가 이름 열거 오라클이 된다. */
  authRefused: "이름이나 비밀번호가 맞지 않습니다.",
  authTaken: "그 이름은 이미 쓰이고 있습니다.",
  authBadName: "계정 이름이 비었거나 너무 깁니다.",
  authBadPassword: "비밀번호가 너무 짧거나 깁니다.",
  yellTooLong: "그렇게 길게는 외칠 수 없다.",
  yellCooling: "목이 아직 트이지 않았다.",

  // ── 전투 ──────────────────────────────────────────────────────────────
  /* ★ 전부 결정론적이다. 0.5초 스윙에 모델을 기다릴 수 없다 (규칙 4).
     LLM 이 전투에 들어올 자리는 나중에 둘 — 전투 종료 후 요약, 또는
     (무기 x 적 x 결과) 키로 미리 생성해 둔 문장 풀(room_text 와 같은 패턴).
     그때도 여기 있는 문장이 폴백으로 남는다. */
  /** 방에 들어섰을 때. 아직 교전은 아니다 — 실시간이라 '먼저 치는' 선택이 있다. */
  enemyHere: (enemy: string): string => fill(voice.enemyHere, { enemy }),
  /** 반복되는 적이 돌아왔다. 지금 그 방에 '서 있는' 사람에게 가는 문장이라
   *  반드시 결정론이어야 한다 — charter 63줄대로 방 묘사는 다시 그리지 않고,
   *  이 한 줄과 구조화 상태(hasEnemy)만 나간다. */
  enemyReturns: (enemy: string): string => fill(voice.enemyReturns, { enemy }),
  engage: (enemy: string): string => `${enemy}이(가) 이쪽을 노려본다. 교전이 시작됐다.`,
  /** 같은 방에 서 있는데 싸우지는 않는 사람에게. 합류할 계기는 이 한 줄뿐이다. */
  engagedBy: (who: string, enemy: string): string => `${who}이(가) ${enemy}에게 달려든다.`,
  /** 평범한 타격. kind:"combat" 으로 나가고 클라이언트가 연속된 것을 접는다. */
  hit: (enemy: string, dmg: number): string => `${enemy}에게 ${dmg}의 피해를 주었다.`,
  crit: (enemy: string, dmg: number): string =>
    `급소를 파고들었다! ${enemy}에게 ${dmg}의 피해.`,
  /** 남이 때리는 것은 짧게 — 방에 여럿이면 로그가 두 배가 된다. */
  allyHit: (who: string, enemy: string, dmg: number): string =>
    `${who}의 공격, ${enemy}에게 ${dmg}.`,
  enemyHit: (enemy: string, dmg: number, guarded: boolean): string =>
    guarded
      ? `${enemy}의 일격을 받아넘겼다. ${dmg}의 피해.`
      : `${enemy}의 일격. ${dmg}의 피해를 입었다.`,
  enemyHitOther: (enemy: string, who: string, dmg: number): string =>
    `${enemy}이(가) ${who}을(를) 후려친다. ${dmg}.`,
  /* 예고와 그 뒤의 일격. 예고 줄이 없으면 큰 피해가 이유 없이 들어온 것이 되고,
     막았다는 줄이 없으면 방어 태세를 쓴 값이 화면에 남지 않는다. */
  enemyWindup: (enemy: string): string => `${enemy}이(가) 크게 몸을 젖힌다.`,
  enemyHeavy: (enemy: string, dmg: number, guarded: boolean): string =>
    guarded
      ? `내리꽂히는 것을 비껴냈다. ${dmg}의 피해.`
      : `${enemy}의 일격이 내리꽂힌다. ${dmg}의 피해를 입었다.`,
  enemyHeavyOther: (enemy: string, who: string, dmg: number): string =>
    `${enemy}의 일격이 ${who}에게 내리꽂힌다. ${dmg}.`,
  skillStrike: (skill: string, enemy: string, dmg: number): string =>
    `${skill}! ${enemy}에게 ${dmg}의 피해.`,
  skillHeal: (skill: string, amount: number): string =>
    amount > 0 ? `${skill}. 체력이 ${amount} 회복되었다.` : `${skill}. 상처가 이미 아물어 있다.`,
  skillGuard: (skill: string, percent: number): string =>
    `${skill}. 다음 일격을 ${percent}% 흘려낼 수 있다.`,
  skillQueued: (skill: string): string => `${skill} 준비 — 다음 호흡에 나간다.`,
  skillQueuedAt: (skill: string, who: string): string =>
    `${who}에게 ${skill} 준비 — 다음 호흡에 나간다.`,
  skillSelfOnly: (skill: string): string => `${skill}은(는) 자기에게만 쓸 수 있다.`,
  skillNoAlly: "그 사람은 이 싸움에 없다.",
  /* 남에게 건 치유·방어. 거는 쪽과 받는 쪽이 다른 문장을 듣는다 — 받는 쪽은
     자기 체력이 왜 올랐는지 알아야 하고, 거는 쪽은 그게 닿았는지 알아야 한다. */
  skillHealOther: (skill: string, who: string, amount: number): string =>
    amount > 0 ? `${who}에게 ${skill}. ${amount} 회복시켰다.` : `${who}의 상처가 이미 아물어 있다.`,
  skillHealedBy: (skill: string, who: string, amount: number): string =>
    `${who}의 ${skill}. 체력이 ${amount} 회복되었다.`,
  skillGuardOther: (skill: string, who: string, percent: number): string =>
    `${who}에게 ${skill}. 다음 일격을 ${percent}% 흘려낸다.`,
  skillGuardedBy: (skill: string, who: string, percent: number): string =>
    `${who}가 앞을 막아선다. 다음 일격을 ${percent}% 흘려낼 수 있다.`,
  skillCooling: (skill: string, secs: number): string => `${skill}은(는) 아직 ${secs}초 남았다.`,
  /** 어그로가 옮겨간 순간. 실시간에서 이게 안 보이면 왜 맞는지 알 수 없다. */
  threatShift: (enemy: string, who: string): string => `${enemy}의 시선이 ${who}에게 옮겨간다.`,
  threatShiftSelf: (enemy: string): string => `${enemy}이(가) 이제 당신을 노린다.`,
  slain: (enemy: string): string => `${enemy}이(가) 연기처럼 흩어진다.`,
  slainByOther: (who: string, enemy: string): string => `${who}이(가) ${enemy}을(를) 쓰러뜨렸다.`,
  defeated: "시야가 어두워진다... 당신은 쓰러졌다.",
  defeatedOther: (who: string): string => `${who}이(가) 쓰러졌다.`,
  respawn: voice.respawn,
  disengage: (enemy: string): string => `${enemy}에게서 물러났다.`,
  fled: (enemy: string): string => fill(voice.fled, { enemy }),
  noEnemy: "여기에는 맞설 것이 없다.",
  alreadyEngaged: "이미 교전 중이다.",
  notInCombat: "지금은 싸우고 있지 않다.",
  unknownSkill: "그런 기술은 익히지 않았다.",

  // ── 아이템 ────────────────────────────────────────────────────────────
  /* 아이템 '이름' 은 engine/items.ts 가 소유한다 (세계의 사실이다).
     여기 있는 것은 그 이름을 넣는 틀뿐이다. */
  /** 전리품. 피해를 준 사람 각자가 자기 것만 듣는다. */
  looted: (item: string, qty: number): string =>
    qty > 1 ? `${item} ${qty}개를 챙겼다.` : `${item}을(를) 챙겼다.`,
  /** 남이 무엇을 주웠는지는 알리지 않는다 — 각자 따로 판정하므로 비교가
   *  생기고, 실시간 전투 로그는 이미 빽빽하다. */
  drankPotion: (item: string, amount: number): string =>
    amount > 0 ? `${item}을(를) 비웠다. 체력이 ${amount} 회복되었다.` : `${item}을(를) 비웠다.`,
  itemQueued: (item: string): string => `${item} — 다음 호흡에 쓴다.`,
  noSuchItem: "가지고 있지 않다.",
  itemNotUsable: (item: string): string => `${item}은(는) 쓸 수 있는 것이 아니다.`,
  itemAtFullHp: (item: string): string => `상처가 이미 아물어 있다. ${item}을(를) 아껴 둔다.`,
  /* 건네기. 주는 쪽과 받는 쪽이 다른 문장을 듣는다 — skillHealOther /
     skillHealedBy 의 선례 그대로다. */
  gave: (item: string, who: string): string => `${who}에게 ${item}을(를) 건넸다.`,
  received: (item: string, who: string): string => `${who}에게서 ${item}을(를) 받았다.`,
  giveSelf: "자기 자신에게 건넬 것은 없다.",
  /** ★ 없는 id · 다른 방 · 다른 지역이 전부 이 한 문장이다. 갈라지면 건네기가
   *  전 세계 위치 탐침이 된다 — 아무 id 나 넣어 보는 것만으로 그 사람이
   *  접속했는지, 어느 방에 있는지를 알아낼 수 있다 (noSuchMission 과 같은 판단). */
  giveNoOne: "그런 이는 여기에 없다.",
  notGivable: (item: string): string => `${item}은(는) 남에게 넘길 수 있는 것이 아니다.`,

  // ── NPC 대화 (4b) ─────────────────────────────────────────────────────
  /* ★ 여기 있는 것은 전부 '틀' 이다. 대사 본문은 여기 없다 —
     씨앗에서 렌더링되어 npc_lines 에 고정된 문장이 text 로 들어온다.
     그래서 이 파일은 4b 이후로도 여전히 순수하고, 문구를 고쳐도 캐시가
     날아가지 않는다 (state_hash 의 preimage 에 들어가지 않으므로). */
  /** 대사 한 줄. 화자를 문장 안에 넣는 이유: log{kind:"npc"} 는 speaker 를
   *  나르지 않는다 (그건 say 의 구조화 필드다). 방에 NPC 가 둘 이상이 되면
   *  이름이 없는 대사는 누가 말했는지 알 수 없다. */
  npcSays: (name: string, text: string): string => `${name}: "${text}"`,
  /** 폴백일 때. 씨앗은 설계상 3인칭 지문이다("이름을 묻지 않고 등급부터
   *  확인한다") — 그걸 따옴표에 넣으면 인물이 자기를 3인칭으로 서술하는
   *  문장이 된다. LLM 경로는 그 씨앗을 실제 발화로 옮기므로 맞고, 폴백만
   *  틀렸다. 그런데 규칙 4 때문에 플레이어가 **먼저 보는 것은 늘 폴백**이고,
   *  키가 없으면 그게 영구적이다. 그래서 폴백은 지문으로 세운다. */
  npcAside: (name: string, text: string): string => `${name} — ${text}`,
  /** 방에 들어섰을 때. '있다' 고만 알린다 — 말을 걸어야 대사가 나온다.
   *  지나가기만 하는 방에서 생성이 돌지 않고, 방 묘사가 대사에 묻히지도 않는다. */
  npcHere: (name: string): string => `${name}이(가) 이곳에 있다.`,
  /** 없는 npcId. 벽 부딪힘과 같은 부류다 — 거절 이유가 아니라 문장이다. */
  noSuchNpc: "그런 이는 여기에 없다.",
  npcNotHere: "그 사람은 이제 이곳에 없다.",
  /** 아직 열리지 않은 주제. 왜 잠겼는지는 말하지 않는다 —
   *  "파수꾼을 쓰러뜨리면 열린다" 는 것 자체가 스포일러다. */
  topicClosed: "그 이야기에는 아무 말도 하지 않는다.",

  // ── 임무 (마이그레이션 005) ──────────────────────────────────────────
  /* ★ 전부 결정론이다. 임무는 전투 중에도 진행이 오르므로(적이 쓰러진 그
     순간) 모델을 기다릴 수 없다 — 전투 문장과 같은 이유다 (규칙 4). */
  noMissions: (name: string) => `${name}은(는) 임무를 게시하지 않는다.`,
  /** 없는 임무, 그리고 '아직 게시되지 않은' 임무. 둘을 같은 문장으로 답한다 —
   *  구별할 수 있으면 id 를 찔러 보는 것만으로 앞으로 나올 임무를 전부 알아낼
   *  수 있다 (벽과 봉인된 문이 같은 ack 인 것과 같은 판단이다). */
  noSuchMission: "그런 임무는 게시돼 있지 않다.",
  /** 자격이 모자란다. 문의 등급과 같이, 무엇이 필요한지는 말해 준다. */
  missionRank: (name: string, rank: string) => `${name}은(는) ${rank} 이상에게만 맡긴다.`,
  missionTaken: (name: string) => `${name}은(는) 이미 맡고 있다.`,
  missionNotTaken: (name: string) => `${name}을(를) 맡은 적이 없다.`,
  missionDone: (name: string) => `${name}은(는) 이미 끝낸 일이다.`,
  missionAccepted: (name: string, goal: number) => `${name}을(를) 맡았다. (0/${goal})`,
  missionProgress: (name: string, now: number, goal: number) => `${name} (${now}/${goal})`,
  missionGoalMet: (name: string) => `${name} — 할 일은 끝났다. 돌아가 보고할 것.`,
  missionShort: (name: string, have: number, need: number) =>
    `${name}은(는) 아직 끝나지 않았다. (${have}/${need})`,
  missionCleared: (name: string, reward: string) => `${name} 완료. ${reward}를 받았다.`,
  missionFailed: "임무 처리 중 무언가 잘못됐다.",
  /** 목표가 세계에서 영영 사라졌다. 게시에서도 빠지지만, 이미 맡은 사람은
   *  돌려주기 전까지 일지에 남아 있으므로 문장이 필요하다. */
  missionGone: (name: string) => `${name}은(는) 이미 누군가 끝낸 일이다. 더 맡길 것이 없다.`,
  missionAbandoned: (name: string) => `${name}을(를) 돌려주었다.`,

  // ── 복구 ──────────────────────────────────────────────────────────────
  /** resume 시 저장된 좌표가 벽 안이면(맵이 바뀌었으면) 스폰으로 이송한다. */
  displaced: voice.displaced,
} as const;

/** 기본 이름. id 파생이라 실질 충돌이 없다 — players.name 에 UNIQUE 를 걸지
 *  않은 이유이기도 하다(계정이 없는데 이름 유일성을 약속하면 거짓말이다). */
export const defaultName = (playerId: string): string =>
  `모험가-${playerId.replace(/-/g, "").slice(0, 4)}`;
