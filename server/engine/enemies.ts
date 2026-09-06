/* 적과 스킬의 '타입'. 값은 여기 없다 — content/balance/*.json 이 소유하고
 * server/content/balance.ts 가 읽어서 주입한다.
 *
 * ★ 왜 값이 빠졌나: 밸런스 수치는 바꿔도 공짜다 (되돌릴 수 있고 LLM 재생성을
 *   부르지 않는다). 배포를 거치게 하면 사람은 튜닝을 안 하게 된다.
 *   씨앗·맵 구조·sensitive_flags 는 반대라서 여전히 코드에 있다.
 *
 * ★ 왜 engine/ 이 파일을 직접 읽지 않나: engine/ 은 결정론이어야 하고 I/O 를
 *   모른다 (.eslintrc.cjs 가 db/·narration/ 과 함께 fs 도 막는다).
 *   시드 PRNG·시계·렌더러와 똑같이 '주입' 받는다.
 *
 * ★ 적의 정의와 배치는 다른 것이다. 여기 있는 것은 '무엇인가' 이고,
 *   '어느 방에 있는가' 는 맵 구조라서 engine/map.ts 의 ENEMY_AT 이 소유한다.
 *   같은 적을 여러 방에 둘 수 있다. */

import type { ItemDef } from "./items";
export type { ItemDef };

export interface EnemyDef {
  readonly id: string;
  readonly name: string;
  readonly maxHp: number;
  /** 한 대당 피해 범위 [lo, hi]. */
  readonly damage: readonly [number, number];
  /** 스윙 간격(ms). 플레이어보다 느리게 두면 체감이 편해진다. */
  readonly swingMs: number;
  /** 이 적이 죽으면 켜지는 월드 플래그. 3단계의 재렌더링을 촉발한다.
   *  null 이면 세계를 바꾸지 않는 평범한 적이다. */
  readonly slainFlag: string | null;
  /** 쓰러진 뒤 이만큼 지나면 돌아온다. null 이면 영영 돌아오지 않는다.
   *
   *  ★ slainFlag 와 배타적이지 않다. 그 둘은 다른 축이다:
   *      slainFlag  — 세계가 영구히 바뀌었다 (한 방향. 되돌아가지 않는다)
   *      respawnMs  — 그 적이 지금 있는가 (왕복한다)
   *    묶어 두면 보스가 서버 수명 동안 한 번뿐이라, 첫 사람이 잡고 나면
   *    나머지 전원에게 그 적도 그 임무도 없는 게임이 된다.
   *    푸는 대신 남는 조건은 문장 쪽이다 — moods/<플래그>.md 는 '지금 없다'
   *    가 아니라 '그런 일이 있었다' 를 써야 한다 (적이 돌아온 뒤에도 참인
   *    문장). 기계가 볼 수 없어서 briefs/README.md 의 저작 규칙에 있다. */
  readonly respawnMs: number | null;
  /** 큰 일격을 예고하는 동작. null 이면 이 적은 예고 없이 계속 때린다.
   *
   *  ★ 왜 필요한가: 예고가 없으면 '언제' 라는 축이 없다. 적의 피해가 매 스윙
   *    고르게 들어오면 플레이어가 결정할 것은 "지금 체력이 낮은가" 하나뿐이고,
   *    그건 불린 하나짜리 전략이다. 방어 태세는 평균 한 대의 절반(≈2)만
   *    막아 주므로 6초 쿨다운을 쓸 값이 없었다 — 시뮬레이터가 승률 기여
   *    1%p 로 재 주었다.
   *    예고는 그 축을 만든다: 지금 막을 것인가, 한 대 더 때릴 것인가. */
  readonly windup: WindupDef | null;
  /** 쓰러뜨리면 나오는 것. 판정은 전투의 시드 PRNG 로 — 규칙 1 그대로,
   *  무엇이 나올지는 결정론이고 LLM 은 관여하지 않는다. */
  readonly drops: readonly DropDef[];
}

export interface WindupDef {
  /** 평범한 스윙 몇 번마다 한 번 몸을 젖히는가. */
  readonly everyNth: number;
  /** 예고 뒤의 일격에 곱하는 배수. */
  readonly mult: number;
}

export interface DropDef {
  readonly itemId: string; // engine/items.ts 의 id (부팅 때 검증한다)
  readonly qty: number;
  /** 0~1. 1 이면 반드시 나온다. */
  readonly chance: number;
}

/** 방 좌표 -> 적. 맵의 'E' 타일과 짝이 맞아야 한다 (부팅 때 검증한다 —
 *  db/seed.ts 의 assertEnemies). */
export interface SkillDef {
  readonly id: string;
  readonly name: string;
  readonly cooldownMs: number;
  /** 'strike' = 피해, 'heal' = 회복, 'guard' = 다음 피격 경감. */
  readonly kind: "strike" | "heal" | "guard";
  /** 효과량 범위 [lo, hi]. guard 는 경감 퍼센트(정수). */
  readonly power: readonly [number, number];
  /** 누구에게 걸 수 있는가. 'self' 면 자기 자신뿐이다.
   *
   *  ★ 왜 필요한가: engine/combat.ts 의 pickTarget 주석은 "치유·방어가 의미를
   *    갖는 것도 이 모델 덕분이다 — 여럿이 붙으면 누가 맞을지가 플레이의
   *    결과가 된다" 고 적어 두었는데, 스킬 셋이 전부 자기 대상이라 남을
   *    살리거나 대신 맞아 줄 수단이 없었다. 어그로가 '가장 많이 때린 사람'
   *    이면 둘이 붙었을 때 유일한 결과는 잘 때리는 쪽이 혼자 다 맞는 것이다.
   *    약한 쪽은 도울 수 없고 강한 쪽은 도움받을 수 없으므로, 서로에게
   *    '옆에 서 있는 추가 DPS' 이상이 못 됐다. */
  readonly target: "self" | "ally";
}

/** 1단계 스킬 셋. 셋이면 실시간의 리듬이 충분히 드러난다:
 *  때릴 것 하나, 살릴 것 하나, 버틸 것 하나. */
/** 플레이어의 기본치. content/balance/player.json 이 소유한다. */
export interface PlayerBalance {
  readonly maxHp: number;
  readonly swingMs: number;
  readonly damage: readonly [number, number];
  /** 0~1. 기본 공격에만 붙는다 — 스킬은 이미 큰 숫자라 겹치면 스파이크가 과하다. */
  readonly critChance: number;
  readonly critMult: number;
  /** 쓰러진 뒤 일어나기까지(ms). */
  readonly respawnMs: number;
  /** 전리품·임무 공로를 받으려면 적 최대 체력의 몇 할을 깎아야 하는가 (0~1).
   *
   *  ★ 왜 필요한가: 문턱이 없으면 피해 1을 넣은 사람과 229를 넣은 사람의
   *    기대 전리품이 같다. 등급 사다리 전체가 어둠 결정 수량이므로,
   *    "강한 사람 옆에서 한 대 치기" 가 사다리를 도는 최적 전략이 된다.
   *
   *  ★ 왜 '막타 금지' 를 그대로 두는가: 함께 잡으면 손해가 아니라는 원칙은
   *    옳다. 고치는 것은 '기여가 없는데 받는' 쪽뿐이다. 0.1 이면 229체력
   *    보스에 23피해 — 기본 공격 네 번, 2초다. 함께 싸운 사람은 다 넘는다. */
  readonly minLootShare: number;
}

/** 코드가 아니라 데이터가 소유하는 것 전부. engine/ 함수들이 이걸 주입받는다.
 *
 *  ★ 적은 id 로 키잉된다 (좌표가 아니라). 배치는 맵의 일이다. */
/** 길드 등급 하나. 사다리는 1부터 이어진 정수이고 0 은 미등록이다.
 *
 *  ★ 왜 요구 조건이 '아이템' 인가: 길드는 "임무에 맞는 보수를 지급" 하고
 *    등급을 관리한다. 지금 이 세계에서 임무의 결과로 손에 남는 것은
 *    괴담에서 나온 물건이므로, 그것을 내는 것이 곧 실적 증명이다.
 *    나중에 임무 시스템이 생기면 요구 조건이 늘어날 뿐 사다리는 그대로다. */
export interface RankDef {
  /** 사다리에서의 자리. 1 이상. */
  readonly level: number;
  readonly name: string;
  /** 승급에 내야 하는 것. 빈 배열이면 신청만으로 오른다 (등록). */
  readonly requires: readonly { readonly itemId: string; readonly qty: number }[];
}

export interface Balance {
  readonly enemies: Readonly<Record<string, EnemyDef>>;
  readonly skills: Readonly<Record<string, SkillDef>>;
  /** 커맨드 창이 보여줄 순서. skills 의 값들을 선언 순서대로 편 것. */
  readonly skillList: readonly SkillDef[];
  readonly items: Readonly<Record<string, ItemDef>>;
  readonly player: PlayerBalance;
  /** 길드 등급 사다리. level 오름차순. */
  readonly ranks: readonly RankDef[];
}
