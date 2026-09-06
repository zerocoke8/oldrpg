/* 적과 스킬의 '선언'. SEEDS 와 같은 방식으로 코드가 소유한다.
 *
 * ★ 적을 위한 표를 만들지 않는다. 세 조각으로 나뉘기 때문이다:
 *     정의(이 파일)     — 코드가 소유. 불변.
 *     사망(world_flags) — 이미 있다. guardian_slain 이 그것이고,
 *                         3단계가 이미 그 플래그에 반응해 방들을 재렌더링한다.
 *     전투 중 HP(메모리) — 살아 있는 전투에만 있는 사실이라 영속화하면
 *                         크래시마다 청소해야 할 거짓 행이 된다
 *                         (접속자 표를 안 만든 것과 같은 논거).
 *
 * 그래서 4a 는 스키마를 한 줄도 바꾸지 않는다. 적을 죽이면 3단계의
 * 이벤트 경로가 그대로 돌아 세계가 바뀐다 — 단계들이 고리로 닫힌다. */

export interface EnemyDef {
  readonly id: string;
  readonly name: string;
  readonly maxHp: number;
  /** 한 대당 피해 범위 [lo, hi]. */
  readonly damage: readonly [number, number];
  /** 스윙 간격(ms). 플레이어보다 느리게 두면 체감이 편해진다. */
  readonly swingMs: number;
  /** 이 적이 죽으면 켜지는 월드 플래그. 3단계의 재렌더링을 촉발한다. */
  readonly slainFlag: string;
}

/** 방 좌표 -> 적. 맵의 'E' 타일과 짝이 맞아야 한다 (부팅 때 검증한다). */
export const ENEMIES: Readonly<Record<string, EnemyDef>> = {
  "3,5": {
    id: "shadow_warden",
    name: "그림자 파수꾼",
    /* 실시간 수치 잡기 (프로토타입의 턴제 30HP 는 여기서 의미가 없다):
         플레이어 DPS ≈ 6 x 1.15(치명타) / 0.5초 = 13.8/초
         -> 200HP 는 혼자 약 15초. 스킬을 두 번 쓸 만큼 길고 지루하지 않을 만큼 짧다.
         적 DPS ≈ 3.5 / 0.9초 = 3.9/초 -> 15초면 56 피해인데 플레이어는 40HP다.
         즉 '치유 없이는 진다'. 그게 실시간에서 스킬을 쓰게 만드는 긴장이다.
       둘이 붙으면 절반으로 줄어든다 — 협력에 값이 붙는다. */
    maxHp: 200,
    damage: [2, 5],
    swingMs: 900, // 플레이어(500ms)보다 느리다
    slainFlag: "guardian_slain",
  },
};

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
export const SKILLS: Readonly<Record<string, SkillDef>> = {
  heavy_strike: {
    id: "heavy_strike",
    name: "강타",
    cooldownMs: 4000,
    kind: "strike",
    power: [14, 22],
  },
  mend: {
    id: "mend",
    name: "응급 치료",
    cooldownMs: 8000,
    kind: "heal",
    power: [12, 18],
  },
  brace: {
    id: "brace",
    name: "방어 태세",
    cooldownMs: 6000,
    kind: "guard",
    power: [50, 50], // 다음 피격 50% 경감
  },
};

export const SKILL_LIST: readonly SkillDef[] = Object.values(SKILLS);

/** 플레이어의 기본 공격. */
export const PLAYER_SWING_MS = 500;
export const PLAYER_DAMAGE: readonly [number, number] = [4, 8];
/** 치명타 — 확률과 배수. 로그에서 눈에 띄는 사건이 있어야 접힌 로그가 살아난다. */
export const CRIT_CHANCE = 0.15;
export const CRIT_MULT = 2;
