/* 임시 분석 도구: 2인 전투. world/combat.ts 의 틱 규칙(어그로=누적피해)을 그대로 흉내낸다. */
import { pickTarget, resolveEnemySwing, resolvePlayerSwing } from "../engine/combat";
import { makeRng } from "../engine/rng";
import { loadBalance } from "../content/balance";
import type { Balance, EnemyDef } from "../engine/enemies";

type Pol = (hp: number, max: number, ready: (id: string) => boolean) => string | null;
const cowardly: Pol = (hp, max, ready) => {
  if (ready("mend") && hp <= max * 0.7) return "mend";
  if (ready("brace") && hp <= max * 0.5) return "brace";
  return ready("heavy_strike") ? "heavy_strike" : null;
};
const simSpec: Pol = (hp, max, ready) => {
  if (ready("mend") && hp <= max * 0.45) return "mend";
  if (ready("brace") && hp <= max * 0.3) return "brace";
  return ready("heavy_strike") ? "heavy_strike" : null;
};
/** '태그' — 한 대만 치고 물러난다(stop). 전리품·임무 판정은 피해>0 이면 받는다. */

function party(enemy: EnemyDef, b: Balance, n: number, pol: Pol, seed: number) {
  const rng = makeRng(seed);
  const p = b.player;
  const hp = Array.from({ length: n }, () => p.maxHp);
  const guard = Array.from({ length: n }, () => 0);
  const next = Array.from({ length: n }, () => 0);
  const cd = Array.from({ length: n }, () => new Map<string, number>());
  const threat = Array.from({ length: n }, () => 0);
  let eHp = enemy.maxHp, eNext = enemy.swingMs, now = 0;
  const LIMIT = 300000;
  while (now < LIMIT) {
    for (let i = 0; i < n; i++) {
      if (hp[i]! <= 0 || next[i]! > now) continue;
      next[i] = now + p.swingMs;
      const ready = (id: string) => (cd[i]!.get(id) ?? 0) <= now;
      const sk = pol(hp[i]!, p.maxHp, ready);
      const r = resolvePlayerSwing(`p${i}`, enemy, eHp, hp[i]!, p.maxHp, sk, rng, b);
      if (r.skill) cd[i]!.set(r.skill.id, now + r.skill.cooldownMs);
      for (const e of r.effects) {
        if (e.type === "enemyDamage") { eHp -= e.amount; threat[i]! += e.amount; }
        else if (e.type === "playerHeal") hp[i]! += e.amount;
        else if (e.type === "guard") guard[i] = e.percent;
      }
      if (eHp <= 0) return { win: true, ms: now, alive: hp.filter((h) => h > 0).length };
    }
    if (eNext <= now) {
      eNext = now + enemy.swingMs;
      const alive = hp.map((h, i) => (h > 0 ? i : -1)).filter((i) => i >= 0);
      if (alive.length === 0) return { win: false, ms: now, alive: 0 };
      const tid = pickTarget(alive.map((i) => `p${i}`), new Map(alive.map((i) => [`p${i}`, threat[i]!])))!;
      const ti = Number(tid.slice(1));
      const r = resolveEnemySwing(enemy, tid, hp[ti]!, guard[ti]!, rng);
      guard[ti] = 0;
      hp[ti]! -= r.amount;
    }
    now += 100;
  }
  return { win: false, ms: LIMIT, alive: hp.filter((h) => h > 0).length };
}

const b = loadBalance();
const runs = 2000;
console.log("인원별 승률 / 중앙 소요시간(초)   — 정책: 겁쟁이(힐70/방50)\n");
console.log("적".padEnd(14) + ["1인", "2인", "3인", "4인"].map((s) => s.padStart(14)).join(""));
console.log("─".repeat(70));
for (const id of ["static_wraith", "pale_grafting", "archivist", "proliferant"]) {
  const e = b.enemies[id]!;
  const cells = [1, 2, 3, 4].map((n) => {
    const rs = Array.from({ length: runs }, (_, i) => party(e, b, n, cowardly, i * 2654435761 + 1));
    const w = rs.filter((r) => r.win);
    const med = w.length ? [...w.map((r) => r.ms)].sort((a, c) => a - c)[Math.floor(w.length / 2)]! : 0;
    return `${String(Math.round((w.length / rs.length) * 100)).padStart(3)}%/${(med / 1000).toFixed(1)}s`;
  });
  console.log(e.name.padEnd(12) + cells.map((c) => c.padStart(14)).join(""));
}
console.log("\n같은 표, 정책 = 시뮬 기본(45/30)\n");
for (const id of ["proliferant"]) {
  const e = b.enemies[id]!;
  const cells = [1, 2, 3, 4].map((n) => {
    const rs = Array.from({ length: runs }, (_, i) => party(e, b, n, simSpec, i * 2654435761 + 1));
    const w = rs.filter((r) => r.win);
    const med = w.length ? [...w.map((r) => r.ms)].sort((a, c) => a - c)[Math.floor(w.length / 2)]! : 0;
    return `${String(Math.round((w.length / rs.length) * 100)).padStart(3)}%/${(med / 1000).toFixed(1)}s`;
  });
  console.log(e.name.padEnd(12) + cells.map((c) => c.padStart(14)).join(""));
}
