/* 게임에 등장하는 '모든' 한국어 문장이 사는 곳.
 *
 * 왜 engine/ 이 아니라 여기인가: 클라이언트가 문장을 조립하지 않는다는 것이
 * 프로토콜 불변식 (1)이고, 그러면 문장은 서버 어딘가에 있어야 한다.
 * engine/ 에 두면 문구를 고칠 때마다 '진실을 계산하는 코드'를 건드리게 된다.
 * 2단계에 이 문장들 중 일부가 LLM 출력으로 바뀌어도 engine/ 은 그대로다.
 *
 * 이 파일은 순수하다 — 상태를 읽지도 쓰지도 않고 문자열만 만든다. */

import type { Dir } from "../../shared/ids";

/** 방위의 한국어 이름. Dir 는 shared/ 소유이고 그 '표시'만 여기 있다. */
const DIR_KO: Readonly<Record<Dir, string>> = {
  north: "북쪽",
  south: "남쪽",
  east: "동쪽",
  west: "서쪽",
};

export const dirKo = (d: Dir): string => DIR_KO[d];

export const lines = {
  welcome: "화살표로 이동, Enter로 살펴보기. 다른 탭을 열면 두 번째 모험가가 된다.",

  // ── 이동 ──────────────────────────────────────────────────────────────
  blocked: "단단한 벽이 앞을 막는다.",

  // ── presence: 방 단위 서사 피드 ──────────────────────────────────────
  /** 상대가 '내 방으로' 들어왔다. fromDir 이 null 이면 접속으로 나타난 것이다. */
  entered: (name: string, fromDir: Dir | null): string =>
    fromDir
      ? `${name} 님이 ${dirKo(fromDir)}에서 들어왔다.`
      : `${name} 님이 어둠 속에서 나타났다.`,
  /** 상대가 '내 방에서' 나갔다. toDir 이 null 이면 접속이 끊긴 것이다. */
  left: (name: string, toDir: Dir | null): string =>
    toDir ? `${name} 님이 ${dirKo(toDir)}으로 사라졌다.` : `${name} 님이 어둠 속으로 사라졌다.`,
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

  // ── 전투 ──────────────────────────────────────────────────────────────
  /* ★ 전부 결정론적이다. 0.5초 스윙에 모델을 기다릴 수 없다 (규칙 4).
     LLM 이 전투에 들어올 자리는 나중에 둘 — 전투 종료 후 요약, 또는
     (무기 x 적 x 결과) 키로 미리 생성해 둔 문장 풀(room_text 와 같은 패턴).
     그때도 여기 있는 문장이 폴백으로 남는다. */
  /** 방에 들어섰을 때. 아직 교전은 아니다 — 실시간이라 '먼저 치는' 선택이 있다. */
  enemyHere: (enemy: string): string => `${enemy}이(가) 어둠 속에서 이쪽을 향해 서 있다.`,
  /** 반복되는 적이 돌아왔다. 지금 그 방에 '서 있는' 사람에게 가는 문장이라
   *  반드시 결정론이어야 한다 — charter 63줄대로 방 묘사는 다시 그리지 않고,
   *  이 한 줄과 구조화 상태(hasEnemy)만 나간다. */
  enemyReturns: (enemy: string): string => `${enemy}이(가) 어둠 속에서 다시 모습을 갖춘다.`,
  engage: (enemy: string): string => `${enemy}이(가) 이쪽을 노려본다. 교전이 시작됐다.`,
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
  skillStrike: (skill: string, enemy: string, dmg: number): string =>
    `${skill}! ${enemy}에게 ${dmg}의 피해.`,
  skillHeal: (skill: string, amount: number): string =>
    amount > 0 ? `${skill}. 체력이 ${amount} 회복되었다.` : `${skill}. 상처가 이미 아물어 있다.`,
  skillGuard: (skill: string, percent: number): string =>
    `${skill}. 다음 일격을 ${percent}% 흘려낼 수 있다.`,
  skillQueued: (skill: string): string => `${skill} 준비 — 다음 호흡에 나간다.`,
  skillCooling: (skill: string, secs: number): string => `${skill}은(는) 아직 ${secs}초 남았다.`,
  /** 어그로가 옮겨간 순간. 실시간에서 이게 안 보이면 왜 맞는지 알 수 없다. */
  threatShift: (enemy: string, who: string): string => `${enemy}의 시선이 ${who}에게 옮겨간다.`,
  threatShiftSelf: (enemy: string): string => `${enemy}이(가) 이제 당신을 노린다.`,
  slain: (enemy: string): string => `${enemy}이(가) 연기처럼 흩어진다.`,
  slainByOther: (who: string, enemy: string): string => `${who}이(가) ${enemy}을(를) 쓰러뜨렸다.`,
  defeated: "시야가 어두워진다... 당신은 쓰러졌다.",
  defeatedOther: (who: string): string => `${who}이(가) 쓰러졌다.`,
  respawn: "차가운 돌바닥의 감촉에 정신이 든다. 입구로 끌려와 있었다.",
  disengage: (enemy: string): string => `${enemy}에게서 물러났다.`,
  fled: (enemy: string): string => `${enemy}을(를) 뒤로하고 어둠 속으로 빠져나왔다.`,
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

  // ── NPC 대화 (4b) ─────────────────────────────────────────────────────
  /* ★ 여기 있는 것은 전부 '틀' 이다. 대사 본문은 여기 없다 —
     씨앗에서 렌더링되어 npc_lines 에 고정된 문장이 text 로 들어온다.
     그래서 이 파일은 4b 이후로도 여전히 순수하고, 문구를 고쳐도 캐시가
     날아가지 않는다 (state_hash 의 preimage 에 들어가지 않으므로). */
  /** 대사 한 줄. 화자를 문장 안에 넣는 이유: log{kind:"npc"} 는 speaker 를
   *  나르지 않는다 (그건 say 의 구조화 필드다). 방에 NPC 가 둘 이상이 되면
   *  이름이 없는 대사는 누가 말했는지 알 수 없다. */
  npcSays: (name: string, text: string): string => `${name}: "${text}"`,
  /** 방에 들어섰을 때. '있다' 고만 알린다 — 말을 걸어야 대사가 나온다.
   *  지나가기만 하는 방에서 생성이 돌지 않고, 방 묘사가 대사에 묻히지도 않는다. */
  npcHere: (name: string): string => `${name}이(가) 이곳에 있다.`,
  /** 없는 npcId. 벽 부딪힘과 같은 부류다 — 거절 이유가 아니라 문장이다. */
  noSuchNpc: "그런 이는 여기에 없다.",
  npcNotHere: "그 사람은 이제 이곳에 없다.",
  /** 아직 열리지 않은 주제. 왜 잠겼는지는 말하지 않는다 —
   *  "파수꾼을 쓰러뜨리면 열린다" 는 것 자체가 스포일러다. */
  topicClosed: "그 이야기에는 아무 말도 하지 않는다.",

  // ── 복구 ──────────────────────────────────────────────────────────────
  /** resume 시 저장된 좌표가 벽 안이면(맵이 바뀌었으면) 스폰으로 이송한다. */
  displaced: "길이 무너져 있었다. 정신을 차려 보니 입구다.",
} as const;

/** 기본 이름. id 파생이라 실질 충돌이 없다 — players.name 에 UNIQUE 를 걸지
 *  않은 이유이기도 하다(계정이 없는데 이름 유일성을 약속하면 거짓말이다). */
export const defaultName = (playerId: string): string =>
  `모험가-${playerId.replace(/-/g, "").slice(0, 4)}`;
