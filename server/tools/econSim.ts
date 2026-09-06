/* 임시 분석 도구: 소모품 수지. 100연전 동안 물약이 쌓이는가 마르는가.
 * 전리품 확률은 content/balance/enemies.json 의 값을 그대로 쓴다. */
import { bout, policies } from "./policySim";
import { makeRng } from "../engine/rng";
import { loadBalance } from "../content/balance";

const b = loadBalance();
const pol = policies.find((p) => p.name === "겁쟁이+물약(힐70/방50)")!;
const runs = 500;

console.log("100연전 (사이 회복 없음, 죽으면 체력 50%로 부활 후 계속). 물약 재고 추이\n");
console.log("적".padEnd(14) + "시작0개".padStart(12) + "시작3개".padStart(12) + "죽은 횟수".padStart(12) + "어둠결정".padStart(12));
console.log("─".repeat(62));
for (const id of ["static_wraith", "pale_grafting"]) {
  const e = b.enemies[id]!;
  const cells: string[] = [];
  for (const start of [0, 3]) {
    const ends: number[] = [];
    const deaths: number[] = [];
    const shards: number[] = [];
    for (let r = 0; r < runs; r++) {
      const rng = makeRng(r * 2654435761 + 7);
      let hp = b.player.maxHp, pot = start, dead = 0, shard = 0;
      for (let i = 0; i < 100; i++) {
        const res = bout(e, b, pol, r * 104729 + i * 7919, hp, pot);
        pot = res.potionsLeft;
        if (!res.win) { dead++; hp = Math.floor(b.player.maxHp / 2); continue; }
        hp = res.hpLeft;
        for (const d of e.drops) if (d.chance >= 1 || rng.chance(d.chance)) {
          if (d.itemId === "stabilizer") pot += d.qty; else if (d.itemId === "dark_shard") shard += d.qty;
        }
      }
      ends.push(pot); deaths.push(dead); shards.push(shard);
    }
    const med = (xs: number[]) => [...xs].sort((a, c) => a - c)[Math.floor(xs.length / 2)]!;
    cells.push(String(med(ends)));
    if (start === 3) { cells.push(String(med(deaths))); cells.push(String(med(shards))); }
  }
  console.log(e.name.padEnd(12) + cells.map((c) => c.padStart(12)).join(""));
}

/* 등급 사다리의 총 비용. ranks.json 은 승급마다 차감한다(engine/guild.ts resolvePromote). */
const total = b.ranks.reduce((a, r) => a + r.requires.reduce((x, y) => x + y.qty, 0), 0);
const pg = b.enemies["pale_grafting"]!;
const chance = pg.drops.find((d) => d.itemId === "dark_shard")!.chance;
const fixed = 1 + 1 + 2; // 증식체 드랍 1 + m_containment 보수 1 + m_proliferant 보수 2 (전부 1회성)
const need = total - fixed;
const kills = need / chance;
const spawnPoints = 2, respawnSec = pg.respawnMs! / 1000;
console.log(`\n등급 사다리: 최고 등급까지 어둠 결정 ${total}개 (누적 차감).`);
console.log(`  1회성 공급 ${fixed}개 → 반복 공급으로 ${need}개 = ${pg.name} ${kills}킬 (드랍 ${chance * 100}%)`);
console.log(`  ${pg.name} 배치 ${spawnPoints}자리, 리스폰 ${respawnSec}초 → 지속 처치율 ${(spawnPoints / respawnSec * 60).toFixed(1)}킬/분`);
console.log(`  = 최소 ${(kills / (spawnPoints / respawnSec) / 60).toFixed(0)}분 순수 반복.`);
