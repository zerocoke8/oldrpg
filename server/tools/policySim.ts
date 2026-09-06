/* 임시 분석 도구 (설계 리뷰용). balanceSim.ts 의 bout 을 정책 교체 가능하게 편 것. */
import { resolveEnemySwing, resolvePlayerSwing } from "../engine/combat";
import { makeRng } from "../engine/rng";
import type { Balance, EnemyDef } from "../engine/enemies";
import { loadBalance } from "../content/balance";

const TICK = 100;

export interface Ctx {
  hp: number; maxHp: number; enemyHp: number; enemyMaxHp: number;
  now: number; ready: (id: string) => boolean; potions: number;
}
export type Policy = { name: string; pick: (c: Ctx) => string | null; potion?: (c: Ctx) => boolean };

export function bout(
  enemy: EnemyDef, balance: Balance, pol: Policy, seed: number,
  startHp = balance.player.maxHp, potions = 0,
): { win: boolean; ms: number; hpLeft: number; potionsLeft: number } {
  const rng = makeRng(seed);
  const p = balance.player;
  let playerHp = Math.min(startHp, p.maxHp);
  let enemyHp = enemy.maxHp;
  let guard = 0, now = 0, pNext = 0, eNext = enemy.swingMs;
  let left = potions;
  const heal = Object.values(balance.items).find((i) => i.kind === "potion")?.heal ?? 0;
  const cd = new Map<string, number>();
  const LIMIT = 5 * 60 * 1000;
  while (now < LIMIT) {
    if (pNext <= now) {
      const ctx: Ctx = { hp: playerHp, maxHp: p.maxHp, enemyHp, enemyMaxHp: enemy.maxHp, now,
        ready: (id) => (cd.get(id) ?? 0) <= now && Boolean(balance.skills[id]), potions: left };
      // 아이템도 스킬과 '같은 한 자리' 를 쓴다 (world/combat.ts 의 f.queued).
      if (left > 0 && pol.potion?.(ctx)) {
        playerHp = Math.min(p.maxHp, playerHp + heal);
        left--;
        pNext = now + p.swingMs;
      } else {
        const skillId = pol.pick(ctx);
        const r = resolvePlayerSwing("p", enemy, enemyHp, playerHp, p.maxHp, skillId, rng, balance);
        if (r.skill) cd.set(r.skill.id, now + r.skill.cooldownMs);
        for (const e of r.effects) {
          if (e.type === "enemyDamage") enemyHp -= e.amount;
          else if (e.type === "playerHeal") playerHp += e.amount;
          else if (e.type === "guard") guard = e.percent;
        }
        if (enemyHp <= 0) return { win: true, ms: now, hpLeft: playerHp, potionsLeft: left };
        pNext = now + p.swingMs;
      }
    }
    if (eNext <= now) {
      const r = resolveEnemySwing(enemy, "p", playerHp, guard, rng);
      guard = 0;
      playerHp -= r.amount;
      if (playerHp <= 0) return { win: false, ms: now, hpLeft: 0, potionsLeft: left };
      eNext = now + enemy.swingMs;
    }
    now += TICK;
  }
  return { win: false, ms: LIMIT, hpLeft: playerHp, potionsLeft: left };
}

const median = (xs: number[]): number =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const HEAL = "mend", GUARD = "brace", STRIKE = "heavy_strike";

export const policies: Policy[] = [
  { name: "기본공격만(스킬0)", pick: () => null },
  { name: "강타만", pick: (c) => (c.ready(STRIKE) ? STRIKE : null) },
  { name: "시뮬 기본(45/30)", pick: (c) => {
      if (c.ready(HEAL) && c.hp <= c.maxHp * 0.45) return HEAL;
      if (c.ready(GUARD) && c.hp <= c.maxHp * 0.3) return GUARD;
      return c.ready(STRIKE) ? STRIKE : null; } },
  { name: "무뇌 연타(강>힐>방)", pick: (c) => {
      if (c.ready(STRIKE)) return STRIKE;
      if (c.ready(HEAL) && c.hp < c.maxHp) return HEAL;
      if (c.ready(GUARD)) return GUARD;
      return null; } },
  { name: "쿨돌면무조건(강>힐>방)", pick: (c) => {
      if (c.ready(STRIKE)) return STRIKE;
      if (c.ready(HEAL)) return HEAL;
      if (c.ready(GUARD)) return GUARD;
      return null; } },
  { name: "힐 없음(강+방30)", pick: (c) => {
      if (c.ready(GUARD) && c.hp <= c.maxHp * 0.3) return GUARD;
      return c.ready(STRIKE) ? STRIKE : null; } },
  { name: "방어 없음(강+힐45)", pick: (c) => {
      if (c.ready(HEAL) && c.hp <= c.maxHp * 0.45) return HEAL;
      return c.ready(STRIKE) ? STRIKE : null; } },
  { name: "손실최대힐(hp<=22)", pick: (c) => {
      if (c.ready(HEAL) && c.hp <= 22) return HEAL;
      if (c.ready(GUARD) && c.hp <= c.maxHp * 0.3) return GUARD;
      return c.ready(STRIKE) ? STRIKE : null; } },
  { name: "겁쟁이(힐70/방50)", pick: (c) => {
      if (c.ready(HEAL) && c.hp <= c.maxHp * 0.7) return HEAL;
      if (c.ready(GUARD) && c.hp <= c.maxHp * 0.5) return GUARD;
      return c.ready(STRIKE) ? STRIKE : null; } },
  { name: "힐 최우선(쿨마다)", pick: (c) => {
      if (c.ready(HEAL) && c.hp < c.maxHp) return HEAL;
      if (c.ready(STRIKE)) return STRIKE;
      if (c.ready(GUARD)) return GUARD;
      return null; } },
  { name: "겁쟁이-방어없음(힐70)", pick: (c) => {
      if (c.ready(HEAL) && c.hp <= c.maxHp * 0.7) return HEAL;
      return c.ready(STRIKE) ? STRIKE : null; } },
  { name: "겁쟁이-강타없음(힐70방50)", pick: (c) => {
      if (c.ready(HEAL) && c.hp <= c.maxHp * 0.7) return HEAL;
      if (c.ready(GUARD) && c.hp <= c.maxHp * 0.5) return GUARD;
      return null; } },
  { name: "겁쟁이+물약(힐70/방50)", pick: (c) => {
      if (c.ready(HEAL) && c.hp <= c.maxHp * 0.7) return HEAL;
      if (c.ready(GUARD) && c.hp <= c.maxHp * 0.5) return GUARD;
      return c.ready(STRIKE) ? STRIKE : null; },
    potion: (c) => c.hp <= c.maxHp * 0.5 && !c.ready(HEAL) },
];

function main(): void {
  const balance = loadBalance();
  const runs = Number(process.argv.includes("--runs") ? process.argv[process.argv.indexOf("--runs") + 1] : 2000);
  const targets = ["static_wraith", "pale_grafting", "archivist", "proliferant"];
  console.log(`정책 비교 (runs=${runs}, 만피 1대1)\n`);
  const head = "정책".padEnd(24) + targets.map((t) => (balance.enemies[t]!.name).padStart(16)).join("");
  console.log(head); console.log("─".repeat(head.length + 8));
  for (const pol of policies) {
    const cells = targets.map((t) => {
      const e = balance.enemies[t]!;
      const bs = Array.from({ length: runs }, (_, i) => bout(e, balance, pol, i * 2654435761 + 1));
      const w = bs.filter((b) => b.win);
      return `${String(Math.round((w.length / bs.length) * 100)).padStart(3)}% ${(median(w.map((b) => b.ms)) / 1000).toFixed(1)}s ${String(Math.round((median(w.map((b) => b.hpLeft)) / balance.player.maxHp) * 100)).padStart(3)}%`;
    });
    console.log(pol.name.padEnd(24) + cells.map((c) => c.padStart(16)).join(""));
  }
  console.log("\n(승률 / 중앙 소요시간 / 이겼을 때 남은 체력 중앙값)");
}
if (process.argv[1]?.endsWith("policySim.ts")) main();
