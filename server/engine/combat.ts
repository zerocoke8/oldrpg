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
import type { Balance, EnemyDef, SkillDef } from "./enemies";
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
  /** 수치는 코드가 아니라 데이터가 소유한다 (content/balance/). 난수·시계와
   *  같은 이유로 주입받는다 — engine/ 은 파일도 DB 도 모른다. */
  balance: Balance,
): SwingResult {
  const skill = queuedSkillId ? (balance.skills[queuedSkillId] ?? null) : null;

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
  const range = skill ? skill.power : balance.player.damage;
  let amount = rng.int(range[0], range[1]);
  // 치명타는 기본 공격에만 — 스킬은 이미 큰 숫자라 겹치면 스파이크가 과하다.
  const crit = !skill && rng.chance(balance.player.critChance);
  if (crit) amount *= balance.player.critMult;

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

/* ── 전리품 ──────────────────────────────────────────────────────────────
 *
 * ★ 순수 함수다. 난수는 주입된 시드 PRNG 이므로 같은 전투는 같은 전리품을
 *   낸다 (engine/ 은 결정론이어야 한다 — .eslintrc.cjs 가 Math.random 을 막는다).
 *   여기서 하는 일은 '무엇이 누구에게' 를 계산하는 것뿐이고, 기록은 호출자다. */

/** 이 전투에서 한 사람이 낸 피해. 어그로(위협)와 같은 수치다. */
export interface Contribution {
  readonly playerId: PlayerId;
  readonly damage: number;
}

export interface Award {
  readonly playerId: PlayerId;
  readonly itemId: string;
  readonly qty: number;
}

/** 피해를 준 사람 '전원' 이 각자 따로 판정을 받는다.
 *
 *  같이 잡으면 손해가 되지 않는 것이 요점이다 — 막타 경쟁도 없다.
 *  (실시간 0.5초 스윙에서 막타는 사실상 운이라, 그걸로 보상을 가르면
 *   함께 싸울 이유가 줄어든다.)
 *
 *  ★ damage 를 지금은 쓰지 않는다. 그래도 인자로 받는 이유는, 나중에
 *    '기여도에 비례한 차등 지급' 으로 가는 문을 여기 열어 두기 위해서다 —
 *    그때 바뀌는 것은 이 함수의 몸통뿐이고 호출부도 표도 그대로다.
 *    (호출자가 순서를 고정해서 넘긴다. rng 를 쓰므로 순서가 곧 결과다.) */
/** 이 전투의 '몫을 받는 사람들'. 전리품과 임무 공로가 **같은 목록**이어야
 *  하므로 호출자가 이걸 한 번 계산해 둘 다에 넘긴다.
 *
 *  ★ 막타 경쟁은 여전히 없다 — 넘긴 사람들끼리는 완전히 동등하다.
 *    거르는 것은 '기여가 없는데 받는' 쪽뿐이다. 문턱이 없으면 피해 1을 넣은
 *    사람과 229를 넣은 사람의 기대 전리품이 같고, 등급 사다리 전체가 전리품
 *    수량이므로 "강한 사람 옆에서 한 대 치기" 가 최적 전략이 된다.
 *
 *  ★ 문턱은 적의 최대 체력 기준이다. 총 피해 기준으로 하면 여럿이 붙을수록
 *    각자의 몫이 작아져, 사람이 늘면 늘수록 자격을 잃는다 — 함께 싸울 이유를
 *    깎지 않는 것이 이 목록의 존재 이유인데 그러면 정반대가 된다. */
export function sharers(
  enemy: EnemyDef,
  contributions: readonly Contribution[],
  minShare: number,
): Contribution[] {
  const need = Math.max(1, Math.ceil(enemy.maxHp * minShare));
  return contributions.filter((c) => c.damage >= need);
}

export function rollDrops(
  enemy: EnemyDef,
  contributions: readonly Contribution[],
  rng: Rng,
): Award[] {
  const out: Award[] = [];
  for (const c of contributions) {
    if (c.damage <= 0) continue;
    for (const d of enemy.drops) {
      if (d.chance >= 1 || rng.chance(d.chance)) {
        out.push({ playerId: c.playerId, itemId: d.itemId, qty: d.qty });
      }
    }
  }
  return out;
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
