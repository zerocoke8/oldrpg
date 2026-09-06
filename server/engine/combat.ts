/* 전투 판정. 순수 함수만 있다 — 상태를 바꾸지 않고 '무엇이 바뀌어야 하는지'를
 * 반환한다. 영속화도 방출도 호출자(world/combat.ts)의 일이다.
 *
 * 이건 1단계 engine/move.ts 주석에 못박아 둔 규약 그대로다:
 *   resolveAttack(attacker, target, roll) => { damage, effects: [...] }
 * 그때 정해 뒀기 때문에 지금 engine/ 을 뜯어고칠 일이 없다.
 *
 * 난수도 시각도 스스로 만들지 않는다 — 호출자가 주입한다.
 * (.eslintrc.cjs 가 engine/ 안의 Math.random 을 빌드 에러로 막는다.) */

import type { PlayerId } from "../../shared/ids";
import {
  CRIT_CHANCE,
  CRIT_MULT,
  PLAYER_DAMAGE,
  SKILLS,
  type EnemyDef,
  type SkillDef,
} from "./enemies";
import type { Rng } from "./rng";

/** 엔진이 낼 수 있는 상태 변경. 호출자가 이걸 보고 DB/월드를 만진다. */
export type Effect =
  | { type: "enemyDamage"; amount: number }
  | { type: "playerDamage"; playerId: PlayerId; amount: number }
  | { type: "playerHeal"; playerId: PlayerId; amount: number }
  | { type: "guard"; playerId: PlayerId; percent: number }
  | { type: "flag"; key: string; value: boolean };

export interface SwingResult {
  readonly effects: readonly Effect[];
  /** 서술을 위한 사실들. 문장은 narration/ 이 만든다. */
  readonly crit: boolean;
  readonly amount: number;
  readonly skill: SkillDef | null;
  /** 이 스윙으로 적이 죽었는가. */
  readonly lethal: boolean;
}

/** 플레이어의 한 스윙. 스킬이 예약돼 있으면 기본 공격을 '대신한다'. */
export function resolvePlayerSwing(
  playerId: PlayerId,
  enemy: EnemyDef,
  enemyHp: number,
  playerHp: number,
  playerMaxHp: number,
  queuedSkillId: string | null,
  rng: Rng,
): SwingResult {
  const skill = queuedSkillId ? (SKILLS[queuedSkillId] ?? null) : null;

  if (skill?.kind === "heal") {
    // 잃은 만큼만 회복한다 — max_hp CHECK 제약이 DB 에 있다.
    const rolled = rng.int(skill.power[0], skill.power[1]);
    const amount = Math.min(rolled, playerMaxHp - playerHp);
    return {
      effects: amount > 0 ? [{ type: "playerHeal", playerId, amount }] : [],
      crit: false,
      amount,
      skill,
      lethal: false,
    };
  }

  if (skill?.kind === "guard") {
    const percent = rng.int(skill.power[0], skill.power[1]);
    return {
      effects: [{ type: "guard", playerId, percent }],
      crit: false,
      amount: percent,
      skill,
      lethal: false,
    };
  }

  // 기본 공격 또는 strike 스킬
  const range = skill ? skill.power : PLAYER_DAMAGE;
  let amount = rng.int(range[0], range[1]);
  // 치명타는 기본 공격에만 — 스킬은 이미 큰 숫자라 겹치면 스파이크가 과하다.
  const crit = !skill && rng.chance(CRIT_CHANCE);
  if (crit) amount *= CRIT_MULT;

  const dealt = Math.min(amount, enemyHp);
  const lethal = dealt >= enemyHp;

  const effects: Effect[] = [{ type: "enemyDamage", amount: dealt }];
  // 적이 죽으면 월드 플래그를 켠다 — 3단계의 재렌더링 경로가 여기서 시작된다.
  // 플래그가 없는 적(반복되는 적)은 세계를 바꾸지 않는다. 그쪽의 '죽음' 은
  // 월드 플래그가 아니라 world/combat.ts 의 리스폰 대기가 소유한다.
  if (lethal && enemy.slainFlag !== null) {
    effects.push({ type: "flag", key: enemy.slainFlag, value: true });
  }

  return { effects, crit, amount: dealt, skill, lethal };
}

export interface EnemySwingResult {
  readonly effects: readonly Effect[];
  readonly targetId: PlayerId;
  readonly amount: number;
  /** 방어 태세로 경감됐는가. */
  readonly guarded: boolean;
  /** 이 스윙으로 대상이 쓰러졌는가. */
  readonly lethal: boolean;
}

/** 적의 한 스윙. 대상은 호출자가 pickTarget 으로 정해 넘긴다. */
export function resolveEnemySwing(
  enemy: EnemyDef,
  targetId: PlayerId,
  targetHp: number,
  guardPercent: number,
  rng: Rng,
): EnemySwingResult {
  let amount = rng.int(enemy.damage[0], enemy.damage[1]);
  const guarded = guardPercent > 0;
  if (guarded) amount = Math.max(1, Math.round((amount * (100 - guardPercent)) / 100));
  const dealt = Math.min(amount, targetHp);
  return {
    effects: [{ type: "playerDamage", playerId: targetId, amount: dealt }],
    targetId,
    amount: dealt,
    guarded,
    lethal: dealt >= targetHp,
  };
}

/** ★ 어그로: 누적 피해가 가장 큰 사람을 노린다.
 *
 *  동점이면 '먼저 교전한' 쪽 — candidates 의 순서가 교전 순서다.
 *  난수를 쓰지 않으므로 같은 입력이면 언제나 같은 대상이 나오고,
 *  그래서 테스트가 결정론적이다.
 *
 *  치유·방어가 의미를 갖는 것도 이 모델 덕분이다: 딜을 많이 넣는 사람이
 *  맞으므로, 여럿이 붙으면 누가 맞을지가 플레이의 결과가 된다. */
export function pickTarget(
  candidates: readonly PlayerId[],
  threat: ReadonlyMap<PlayerId, number>,
): PlayerId | null {
  let best: PlayerId | null = null;
  let bestThreat = -1;
  for (const id of candidates) {
    const t = threat.get(id) ?? 0;
    if (t > bestThreat) {
      bestThreat = t;
      best = id;
    }
  }
  return best;
}
