/* 임시 분석 도구: 연속 전투에서 자원(물약)이 하는 일. 실제 게임에는 전투 밖 자연회복이
 * 없고(grep: setPlayerHp 호출처 4곳뿐), 회복 스킬 쿨다운은 전투가 끝나면 사라진다
 * (world/combat.ts 의 Fighter 가 전투와 함께 소멸). 그 두 사실을 그대로 반영한다. */
import { bout, policies } from "./policySim";
import { loadBalance } from "../content/balance";

const b = loadBalance();
const cowardly = policies.find((p) => p.name === "겁쟁이(힐70/방50)")!;
const withPotion = policies.find((p) => p.name === "겁쟁이+물약(힐70/방50)")!;
const runs = 2000;

function chain(enemyId: string, n: number, pol: typeof cowardly, potions: number, seed: number) {
  const e = b.enemies[enemyId]!;
  let hp = b.player.maxHp, left = potions;
  for (let i = 0; i < n; i++) {
    const r = bout(e, b, pol, seed + i * 7919, hp, left);
    if (!r.win) return { cleared: false, hp: 0, left: r.potionsLeft };
    hp = r.hpLeft; left = r.potionsLeft;
  }
  return { cleared: true, hp, left };
}

console.log("연속 전투 (사이에 회복 없음). 완주율 / 마지막 남은 체력%\n");
console.log("적 x 연전".padEnd(24) + "물약0".padStart(14) + "물약3".padStart(14) + "물약9".padStart(14));
console.log("─".repeat(66));
for (const [id, n] of [["static_wraith", 3], ["pale_grafting", 3], ["pale_grafting", 5], ["proliferant", 2], ["archivist", 3]] as const) {
  const cells = [0, 3, 9].map((pot) => {
    const rs = Array.from({ length: runs }, (_, i) => chain(id, n, pot ? withPotion : cowardly, pot, i * 2654435761 + 1));
    const ok = rs.filter((r) => r.cleared);
    const med = ok.length ? [...ok.map((r) => r.hp)].sort((a, c) => a - c)[Math.floor(ok.length / 2)]! : 0;
    return `${String(Math.round((ok.length / rs.length) * 100)).padStart(3)}% ${String(Math.round((med / b.player.maxHp) * 100)).padStart(3)}%`;
  });
  console.log(`${b.enemies[id]!.name} x${n}`.padEnd(24) + cells.map((c) => c.padStart(14)).join(""));
}

/* '전투 밖 회복' 의 실제 값: 약한 적에게 붙어 회복 스킬만 쓰고 물러난다.
   회복 15/8초 vs 이야기의 편린 피해 1.5/1.2초 = 1.25/초. 순이득을 잰다. */
const shard = b.enemies["story_shard"]!;
const mend = b.skills["mend"]!;
const mendHps = ((mend.power[0] + mend.power[1]) / 2) / (mend.cooldownMs / 1000);
const shardDps = ((shard.damage[0] + shard.damage[1]) / 2) / (shard.swingMs / 1000);
console.log(`\n가장 약한 적(${shard.name})에 붙어 회복만 쓸 때`);
console.log(`  회복 ${mendHps.toFixed(2)}/초  vs  피해 ${shardDps.toFixed(2)}/초  →  순 ${(mendHps - shardDps).toFixed(2)}/초`);
console.log(`  체력 0 → ${b.player.maxHp} 까지 ${(b.player.maxHp / (mendHps - shardDps)).toFixed(0)}초. 비용 0. 물약 소모 0.`);
