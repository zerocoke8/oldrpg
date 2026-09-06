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
   *  ★ 이 둘은 배타적이다 — 플래그를 켜는 적은 돌아오지 않는다 (부팅 때 검증).
   *    세계가 바뀐 사건은 되돌릴 수 없기 때문이다: 파수꾼이 되살아나는데
   *    guardian_slain 이 켜진 채로 남으면, 그 플래그를 선언한 일곱 방의 묘사가
   *    "파수꾼이 사라진 뒤" 인 채 파수꾼과 마주 보게 된다. 플래그를 되돌리면
   *    이번엔 지금 그 방에 서 있는 사람들의 세계가 소리 없이 뒤집힌다.
   *    그래서 '세계를 바꾸는 적' 과 '반복되는 적' 은 다른 종류로 나눈다. */
  readonly respawnMs: number | null;
  /** 쓰러뜨리면 나오는 것. 판정은 전투의 시드 PRNG 로 — 규칙 1 그대로,
   *  무엇이 나올지는 결정론이고 LLM 은 관여하지 않는다. */
  readonly drops: readonly DropDef[];
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
