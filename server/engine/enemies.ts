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
}

/** 방 좌표 -> 적. 맵의 'E' 타일과 짝이 맞아야 한다 (부팅 때 검증한다 —
 *  db/seed.ts 의 assertEnemies). */
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
    respawnMs: null, // 보스는 돌아오지 않는다
  },

  /* 반복되는 적 둘. 파수꾼 하나뿐이면 '한 번 죽이면 끝' 인 세계라,
     늦게 접속한 사람은 전투를 영영 보지 못했다 — guardian_slain 이 DB 영속이다.
     동쪽 날개(4,1 / 5,2)에 둔다. 스폰에서 한 칸 떨어져 있지 않아 처음 몇 걸음이
     안전하고, 파수꾼으로 가는 길과도 겹치지 않는다.

     수치: 플레이어 DPS ≈ 13.8/초, HP 40.
       잿빛 종잇장  70HP  -> 약 5초, 맞는 피해 ≈ 9   (연습용)
       녹슨 감시자 110HP  -> 약 8초, 맞는 피해 ≈ 26  (치유를 쓰게 만든다) */
  "4,1": {
    id: "ashen_pages",
    name: "잿빛 종잇장",
    maxHp: 70,
    damage: [1, 3],
    swingMs: 1100,
    slainFlag: null,
    respawnMs: 45_000,
  },
  "5,2": {
    id: "rusted_watcher",
    name: "녹슨 감시자",
    maxHp: 110,
    damage: [2, 4],
    swingMs: 950,
    slainFlag: null,
    respawnMs: 60_000,
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
