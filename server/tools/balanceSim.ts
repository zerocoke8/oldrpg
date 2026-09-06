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

import { resolveEnemySwing, resolvePlayerSwing, windsUp } from "../engine/combat";
import { makeRng } from "../engine/rng";
import type { Balance, EnemyDef } from "../engine/enemies";
import { loadBalance } from "../content/balance";
import { makeMap } from "../engine/map";
import { loadWorld } from "../content/world";

/** 플레이어가 어떻게 싸우는가.
 *  basic    스킬을 안 쓴다
 *  skilled  체력을 보고 쓴다 (불린 하나짜리 전략)
 *  reactive 예고를 보고 방어 태세를 맞춰 쓴다 — 예고가 만든 '언제' 축을 쓴다 */
export type Style = "basic" | "skilled" | "reactive";

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
export function bout(
  enemy: EnemyDef,
  balance: Balance,
  style: Style,
  seed: number,
  /** 시작 체력. 임무처럼 '연달아 싸우는' 경우를 재려면 만피가 아니어야 한다. */
  startHp = balance.player.maxHp,
): Bout {
  const rng = makeRng(seed);
  const p = balance.player;
  let playerHp = Math.min(startHp, p.maxHp);
  let enemyHp = enemy.maxHp;
  let guard = 0;
  let now = 0;
  let pNext = 0;
  let eNext = enemy.swingMs; // 적은 한 박자 늦게 시작한다 (교전을 건 쪽이 먼저 친다)
  const cooldowns = new Map<string, number>();
  // 예고 상태. 전투 루프(world/combat.ts)가 들고 있는 것과 같은 두 값이다.
  let swingsSinceWindup = 0;
  let charged = false;

  /** 스킬을 쓰는 사람의 판단. 체력이 낮으면 회복, 아니면 강타. */
  const pickSkill = (): string | null => {
    if (style === "basic") return null;
    const ready = (id: string): boolean => (cooldowns.get(id) ?? 0) <= now && Boolean(balance.skills[id]);
    const heal = balance.skillList.find((s) => s.kind === "heal");
    const strike = balance.skillList.find((s) => s.kind === "strike");
    const guardSkill = balance.skillList.find((s) => s.kind === "guard");
    /* ★ 예고를 보고 막는다. 이 한 줄이 reactive 와 skilled 의 전부다 —
       두 표의 차이가 곧 '예고가 방어 태세에 값을 붙였는가' 다. */
    if (style === "reactive" && charged && guardSkill && ready(guardSkill.id)) return guardSkill.id;
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
      // 예고는 한 박자를 통째로 쓴다 — 전투 루프와 같은 규칙이다.
      if (!charged && windsUp(enemy, swingsSinceWindup)) {
        charged = true;
        swingsSinceWindup = 0;
      } else {
        const r = resolveEnemySwing(enemy, "p", playerHp, guard, rng, charged);
        if (!charged) swingsSinceWindup++;
        charged = false;
        guard = 0; // 한 번 쓰면 사라진다
        playerHp -= r.amount;
        if (playerHp <= 0) return { win: false, ms: now, hpLeft: 0 };
      }
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

/** 표에 쓰는 이름. 예고를 보고 막는 쪽은 '반응' 이다. */
const styleLabel = (s: Style): string =>
  s === "basic" ? "기본" : s === "skilled" ? "스킬" : "반응";

const median = (xs: number[]): number =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

export function simulate(balance: Balance, runs = 200): Summary[] {
  const out: Summary[] = [];
  for (const enemy of Object.values(balance.enemies)) {
    for (const style of ["basic", "skilled", "reactive"] as const) {
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

/* ── 임무는 '연달아' 싸운다 ────────────────────────────────────────────
   한 판 승률이 100%여도 임무가 깨진다는 것을 실제로 겪었다. 잔류 괴령은
   혼자서는 100% 이기지만 남는 체력이 40% 라, 둘을 연달아 잡으라는 임무는
   회복 없이는 두 번째에서 죽는다.

   ★ 그래서 '한 판' 만 재는 표로는 임무를 검토할 수 없다. 곡선은 결국
     '쉬지 않고 이어지는 판들' 의 이야기다. */

export interface RunSummary {
  id: string;
  name: string;
  style: Style;
  /** 물약을 몇 개 들고 들어가는가. */
  potions: number;
  clearRate: number;
  /** 끝까지 갔을 때 남은 체력 중앙값(%). */
  medianHpPct: number;
}

/** 목표 수만큼 연달아 싸운다. 사이에 회복은 물약뿐이고, 체력이 절반 아래로
 *  떨어지면 하나 마신다 (사람이 할 법한 판단). */
export function runMission(
  enemy: EnemyDef,
  count: number,
  balance: Balance,
  style: Style,
  potions: number,
  seed: number,
): { cleared: boolean; hpLeft: number } {
  const p = balance.player;
  const heal = Object.values(balance.items).find((i) => i.kind === "potion")?.heal ?? 0;
  let hp = p.maxHp;
  let left = potions;
  for (let i = 0; i < count; i++) {
    while (left > 0 && hp <= p.maxHp * 0.5) {
      hp = Math.min(p.maxHp, hp + heal);
      left--;
    }
    const b = bout(enemy, balance, style, seed + i * 7919, hp);
    if (!b.win) return { cleared: false, hpLeft: 0 };
    hp = b.hpLeft;
  }
  return { cleared: true, hpLeft: hp };
}

export function simulateMissions(balance: Balance, runs = 200): RunSummary[] {
  const map = makeMap(loadWorld());
  const out: RunSummary[] = [];
  for (const m of map.missions()) {
    const enemy = balance.enemies[m.goal.enemyId];
    if (!enemy) continue;
    for (const style of ["basic", "skilled", "reactive"] as const) {
      for (const potions of [0, 2]) {
        const rs = Array.from({ length: runs }, (_, i) =>
          runMission(enemy, m.goal.count, balance, style, potions, i * 2654435761 + 1),
        );
        const ok = rs.filter((r) => r.cleared);
        out.push({
          id: m.id,
          name: `${m.name} (${enemy.name} x${m.goal.count})`,
          style,
          potions,
          clearRate: ok.length / rs.length,
          medianHpPct: Math.round((median(ok.map((r) => r.hpLeft)) / balance.player.maxHp) * 100),
        });
      }
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
      `${r.name.padEnd(16)} ${styleLabel(r.style).padEnd(6)} ` +
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

  /* 임무는 연달아 싸운다. 한 판 승률 100%가 임무 완주를 뜻하지 않는다. */
  console.log("\n임무 완주 (만피에서 시작, 사이에 회복은 물약뿐)");
  console.log("─".repeat(72));
  console.log("임무                              방식   물약   완주율   남은 체력");
  for (const r of simulateMissions(balance, Number(at("--runs") ?? 200))) {
    const bar = "█".repeat(Math.round(r.clearRate * 10)).padEnd(10, "·");
    console.log(
      `${r.name.padEnd(32)} ${styleLabel(r.style).padEnd(5)} ` +
        `${String(r.potions).padStart(3)}개  ${bar} ${String(Math.round(r.clearRate * 100)).padStart(3)}%  ` +
        `${String(r.medianHpPct).padStart(3)}%`,
    );
  }
}

if (process.argv[1]?.endsWith("balanceSim.ts")) main(process.argv.slice(2));
