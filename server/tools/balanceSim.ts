/* 밸런스 시뮬레이터. 1대1 전투를 엔진 함수로 그대로 돌려 본다.
 *
 *     npm run sim
 *     npm run sim -- --runs 400
 *
 * ★ 왜 도구인가: '올바른 수치' 는 설계 결정이라 검사가 정할 수 없다. 검사가
 *   할 수 있는 것은 불변식뿐이다 ("이길 수 없는 적은 없다"). 곡선을 눈으로
 *   보고 고르는 일은 사람이 하고, 이 도구는 그 근거를 만든다.
 *
 * ★ 왜 엔진 함수를 그대로 부르는가: 데미지 공식을 여기서 다시 쓰면 그 순간
 *   시뮬레이터는 게임이 아니라 시뮬레이터를 재는 물건이 된다. 치명타·가드·
 *   스킬 쿨다운이 전부 engine/combat.ts 의 것이어야 한다.
 *
 * ★ 왜 여러 번 도는가: 굴림이 난수라 한 번은 아무것도 말해 주지 않는다.
 *   시드를 바꿔 가며 돌리고 승률과 분포를 본다. */

import { resolveEnemySwing, resolvePlayerSwing } from "../engine/combat";
import { makeRng } from "../engine/rng";
import type { Balance, EnemyDef } from "../engine/enemies";
import { loadBalance } from "../content/balance";
import { makeMap } from "../engine/map";
import { loadWorld } from "../content/world";

/** 플레이어가 어떻게 싸우는가. '잘 하는 사람' 과 '안 쓰는 사람' 을 나눠 본다. */
export type Style = "basic" | "skilled";

export interface Bout {
  win: boolean;
  /** 전투에 걸린 시각(ms, 단조). */
  ms: number;
  /** 끝났을 때 남은 체력. 진 경우 0. */
  hpLeft: number;
}

const TICK = 100;

/** 한 판. 실제 전투 루프와 같은 규칙으로 돈다 —
 *  전투원마다 nextActAt 이 있고, 100ms 틱에서 때가 된 쪽이 친다. */
export function bout(enemy: EnemyDef, balance: Balance, style: Style, seed: number): Bout {
  const rng = makeRng(seed);
  const p = balance.player;
  let playerHp = p.maxHp;
  let enemyHp = enemy.maxHp;
  let guard = 0;
  let now = 0;
  let pNext = 0;
  let eNext = enemy.swingMs; // 적은 한 박자 늦게 시작한다 (교전을 건 쪽이 먼저 친다)
  const cooldowns = new Map<string, number>();

  /** 스킬을 쓰는 사람의 판단. 체력이 낮으면 회복, 아니면 강타. */
  const pickSkill = (): string | null => {
    if (style === "basic") return null;
    const ready = (id: string): boolean => (cooldowns.get(id) ?? 0) <= now && Boolean(balance.skills[id]);
    const heal = balance.skillList.find((s) => s.kind === "heal");
    const strike = balance.skillList.find((s) => s.kind === "strike");
    const guardSkill = balance.skillList.find((s) => s.kind === "guard");
    if (heal && ready(heal.id) && playerHp <= p.maxHp * 0.45) return heal.id;
    if (guardSkill && ready(guardSkill.id) && playerHp <= p.maxHp * 0.3) return guardSkill.id;
    if (strike && ready(strike.id)) return strike.id;
    return null;
  };

  /* 무한 루프 방지. 5분이면 어떤 조합이든 결판이 나 있어야 한다 —
     안 났다면 그 자체가 보고할 만한 사실이다 (아래에서 win:false 로 나간다). */
  const LIMIT = 5 * 60 * 1000;
  while (now < LIMIT) {
    if (pNext <= now) {
      const skillId = pickSkill();
      const r = resolvePlayerSwing("p", enemy, enemyHp, playerHp, p.maxHp, skillId, rng, balance);
      if (r.skill) cooldowns.set(r.skill.id, now + r.skill.cooldownMs);
      for (const e of r.effects) {
        if (e.type === "enemyDamage") enemyHp -= e.amount;
        else if (e.type === "playerHeal") playerHp += e.amount;
        else if (e.type === "guard") guard = e.percent;
      }
      if (enemyHp <= 0) return { win: true, ms: now, hpLeft: playerHp };
      pNext = now + p.swingMs;
    }
    if (eNext <= now) {
      const r = resolveEnemySwing(enemy, "p", playerHp, guard, rng);
      guard = 0; // 한 번 쓰면 사라진다
      playerHp -= r.amount;
      if (playerHp <= 0) return { win: false, ms: now, hpLeft: 0 };
      eNext = now + enemy.swingMs;
    }
    now += TICK;
  }
  return { win: false, ms: LIMIT, hpLeft: playerHp };
}

export interface Summary {
  id: string;
  name: string;
  style: Style;
  winRate: number;
  /** 이긴 판의 중앙 소요 시간(초). */
  medianSec: number;
  /** 이긴 판의 남은 체력 중앙값(%). 낮을수록 아슬아슬하다. */
  medianHpPct: number;
}

const median = (xs: number[]): number =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

export function simulate(balance: Balance, runs = 200): Summary[] {
  const out: Summary[] = [];
  for (const enemy of Object.values(balance.enemies)) {
    for (const style of ["basic", "skilled"] as const) {
      const bouts = Array.from({ length: runs }, (_, i) => bout(enemy, balance, style, i * 2654435761 + 1));
      const wins = bouts.filter((b) => b.win);
      out.push({
        id: enemy.id,
        name: enemy.name,
        style,
        winRate: wins.length / bouts.length,
        medianSec: Math.round(median(wins.map((b) => b.ms)) / 100) / 10,
        medianHpPct: Math.round((median(wins.map((b) => b.hpLeft)) / balance.player.maxHp) * 100),
      });
    }
  }
  return out;
}

function main(argv: string[]): void {
  const at = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const balance = loadBalance();
  const rows = simulate(balance, Number(at("--runs") ?? 200));

  console.log(`플레이어: 체력 ${balance.player.maxHp} · 피해 ${balance.player.damage.join("~")}` +
    ` · ${balance.player.swingMs}ms · 치명 ${balance.player.critChance * 100}%×${balance.player.critMult}\n`);
  console.log("적                 방식     승률    소요     남은 체력");
  console.log("─".repeat(56));
  for (const r of rows) {
    const bar = "█".repeat(Math.round(r.winRate * 10)).padEnd(10, "·");
    console.log(
      `${r.name.padEnd(16)} ${(r.style === "basic" ? "기본" : "스킬").padEnd(6)} ` +
        `${bar} ${String(Math.round(r.winRate * 100)).padStart(3)}%  ` +
        `${String(r.medianSec).padStart(5)}s  ${String(r.medianHpPct).padStart(3)}%`,
    );
  }

  /* 배치도 함께 보여 준다 — 수치만 봐서는 '어디서 만나는가' 를 알 수 없고,
     곡선은 결국 '순서대로 만나는 적들' 의 이야기다. */
  const map = makeMap(loadWorld());
  console.log("\n지역별 배치");
  console.log("─".repeat(56));
  for (const r of map.regions()) {
    const es = Object.values(r.enemies);
    const names = es.map((id) => balance.enemies[id]?.name ?? `?${id}`);
    console.log(`${r.id.padEnd(9)} ${String(Object.keys(r.seeds).length).padStart(3)}방  적 ${String(es.length).padStart(2)}  ${names.join(", ") || "-"}`);
  }
}

if (process.argv[1]?.endsWith("balanceSim.ts")) main(process.argv.slice(2));
