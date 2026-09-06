/* 길드 등급의 '규칙'. 사다리와 이름은 데이터가 소유하고(content/balance/ranks.json),
 * 여기 있는 것은 판정뿐이다 — 순수 함수이고 DB 도 파일도 모른다.
 *
 * ★ 등급이 세계 플래그가 아니라 플레이어의 값인 이유: 플래그는 세계가 한 번
 *   바뀌면 모두에게 바뀐다. "파수꾼이 죽었다" 는 모두에게 참이지만 "이 사람이
 *   3급이다" 는 그 사람에게만 참이다. 둘을 같은 통에 넣으면 한 명이 승급하는
 *   순간 전원이 승급한다.
 *
 * ★ 그래서 문의 조건이 두 종류다: requires(세계 플래그)와 minRank(그 사람).
 *   앞의 것은 "세계가 열렸는가", 뒤의 것은 "당신이 자격이 있는가" 다. */

import type { Balance, RankDef } from "./enemies";

/** 지금 등급의 이름. 0 은 미등록이라 사다리에 없다. */
export function rankName(level: number, balance: Balance): string | null {
  return balance.ranks.find((r) => r.level === level)?.name ?? null;
}

/** 다음 등급. 이미 꼭대기면 null. */
export function nextRank(level: number, balance: Balance): RankDef | null {
  return balance.ranks.find((r) => r.level === level + 1) ?? null;
}

export type PromoteResult =
  | { ok: true; to: RankDef; /** 내야 하는 것. 호출자가 실제로 차감한다. */ spend: readonly { itemId: string; qty: number }[] }
  | { ok: false; reason: "max" }
  | { ok: false; reason: "short"; to: RankDef; missing: readonly { itemId: string; qty: number }[] };

/** 승급 판정. **아무것도 바꾸지 않는다** — 무엇을 차감해야 하는지를 돌려줄 뿐이고
 *  차감과 기록은 호출자(world/guild.ts)의 일이다. engine 의 규약 그대로다.
 *
 *  have 는 '그 사람이 지금 가진 수량' 이다. 가방 전체가 아니라 필요한 것만
 *  물어보게 두면 호출자가 무엇을 읽어야 하는지가 서명에 드러난다. */
export function resolvePromote(
  level: number,
  balance: Balance,
  have: (itemId: string) => number,
): PromoteResult {
  const to = nextRank(level, balance);
  if (!to) return { ok: false, reason: "max" };

  const missing = to.requires
    .map((need) => ({ itemId: need.itemId, qty: need.qty - have(need.itemId) }))
    .filter((m) => m.qty > 0);
  if (missing.length) return { ok: false, reason: "short", to, missing };

  return { ok: true, to, spend: to.requires.map((r) => ({ itemId: r.itemId, qty: r.qty })) };
}
