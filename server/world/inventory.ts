/* 가방. engine(무엇인가) + db(몇 개인가) + net(무엇을 보낼까) 을 조합한다.
 *
 * ★ 메모리 사본을 두지 않는다. Session 은 hp·pos·seen 을 들고 있지만 가방은
 *   들지 않고, 필요할 때마다 DB 에서 읽는다. SQLite 는 같은 프로세스 안이고
 *   준비된 문 하나는 수십 마이크로초다. 사본을 두면 진실이 둘이 되고,
 *   "DB 커밋이 먼저, 메모리 갱신이 나중" 을 가방에도 지켜야 한다.
 *   읽는 곳(스냅샷·변경 직후)이 드물어서 그 값을 치를 이유가 없다.
 *
 * ★ 규칙 1: 무엇이 얼마나 회복되는지는 engine/items.ts 가 정하고, 여기서는
 *   그 확정된 수치를 기록·방출만 한다. */

import type { ItemStack } from "../../shared/protocol";
import type { Award } from "../engine/combat";
import type { Balance } from "../engine/enemies";
import type { Queries } from "../db/queries";
import { lines } from "../narration/lines";
import type { Emit } from "../net/emit";
import type { Registry, Session } from "../net/session";

export interface InventoryService {
  /** 지금 가진 것. 스냅샷과 self.patch 가 쓴다. */
  of(playerId: string): ItemStack[];
  /** 전리품을 넣고 각자에게 알린다. 여러 사람 분을 한 트랜잭션으로 —
   *  중간에 실패해서 누구는 받고 누구는 못 받는 상태가 없어야 한다. */
  award(awards: readonly Award[]): void;
  /** 실제로 쓴다. 실패하면 이유 문장을 돌려준다 (거절이 아니라 문장이다). */
  use(s: Session, itemId: string): string | null;
  /** 쓸 수 있는가 — 예약하기 '전에' 보는 검사. 전투 중에 예약해 두고
   *  0.5초 뒤에야 "가지고 있지 않다" 를 듣는 것은 거짓말에 가깝다. */
  check(s: Session, itemId: string): string | null;
}

export function makeInventory(
  q: Queries,
  reg: Registry,
  emit: Emit,
  balance: Balance,
  clock: () => number,
  /** 한 트랜잭션으로 묶기 위한 것. db.transaction 을 감싼 것이 들어온다. */
  tx: (fn: () => void) => void,
): InventoryService {
  function of(playerId: string): ItemStack[] {
    return q.itemsOf.all(playerId).map((r) => {
      const def = balance.items[r.item_id];
      return {
        id: r.item_id,
        // 정의가 사라진 아이템(코드에서 지웠다)도 행은 남는다. 조용히 숨기지
        // 않고 id 를 그대로 보여 준다 — 유령이 생겼다는 것이 보여야 한다.
        name: def?.name ?? r.item_id,
        qty: r.qty,
        usable: def?.kind === "potion",
      };
    });
  }

  /** 가방이 바뀐 사람에게 현재 상태를 통째로 보낸다 (델타가 아니라 전부). */
  function pushBag(s: Session): void {
    emit.send(s, { t: "self.patch", items: of(s.playerId) });
  }

  function award(awards: readonly Award[]): void {
    if (!awards.length) return;
    const now = clock();
    try {
      tx(() => {
        for (const a of awards) {
          q.addItem.run({ player_id: a.playerId, item_id: a.itemId, qty: a.qty, now });
        }
      });
    } catch (err) {
      console.error("[inventory] award", err);
      return; // 전리품을 못 받는 것이 전투가 깨지는 것보다 낫다
    }
    // 기록이 끝난 뒤에 알린다. 각자 자기 것만 듣는다.
    for (const a of awards) {
      const s = reg.get(a.playerId);
      if (!s) continue;
      emit.log(s, "good", lines.looted(balance.items[a.itemId]?.name ?? a.itemId, a.qty));
      pushBag(s);
    }
  }

  function check(s: Session, itemId: string): string | null {
    const def = balance.items[itemId];
    // 없는 아이템과 안 가진 아이템의 답이 같다 — "무엇이 존재하는가" 를
    // 묻는 오라클을 만들지 않는다 (알 수 없는 토큰을 신규로 흡수하는 것과 같은 논거).
    const have = q.itemsOf.all(s.playerId).find((r) => r.item_id === itemId);
    if (!def || !have) return lines.noSuchItem;
    if (def.kind !== "potion") return lines.itemNotUsable(def.name);
    if (s.hp >= s.maxHp) return lines.itemAtFullHp(def.name);
    return null;
  }

  function use(s: Session, itemId: string): string | null {
    const refusal = check(s, itemId);
    if (refusal) return refusal;
    const def = balance.items[itemId]!;
    const now = clock();
    const healed = Math.min(def.heal ?? 0, s.maxHp - s.hp);
    const next = s.hp + healed;

    /* 소모와 회복이 한 트랜잭션이다. 갈라지면 '마셨는데 안 찼다' 나
       '찼는데 안 줄었다' 가 생기고, 둘 다 되돌릴 방법이 없다. */
    try {
      tx(() => {
        /* ★ 지우기가 먼저다. 순서를 바꾸면 qty=2 일 때 UPDATE 가 1로 줄이고
           곧바로 DELETE 가 '이제 1이니까' 지워서, 한 번 마셨는데 두 개가
           사라진다. 둘 중 하나만 도는 것이 이 표현의 요점이라 || 로 쓴다.
             qty=1 -> DELETE 가 1행, UPDATE 는 볼 행이 없다
             qty>1 -> DELETE 는 0행, UPDATE 가 1행 */
        const changed =
          q.dropLastItem.run({ player_id: s.playerId, item_id: itemId }).changes ||
          q.consumeItem.run({ player_id: s.playerId, item_id: itemId, now }).changes;
        // 0행 = 그 사이 다른 탭이 마지막 하나를 썼다. 회복도 하지 않는다.
        if (changed === 0) throw new Error("EMPTY");
        q.setPlayerHp.run(next, now, s.playerId);
      });
    } catch (err) {
      if (err instanceof Error && err.message === "EMPTY") return lines.noSuchItem;
      console.error("[inventory] use", err);
      return lines.noSuchItem;
    }

    // DB 커밋이 먼저, 메모리 갱신이 나중 — 이동·전투와 같은 규칙.
    s.hp = next;
    emit.send(s, { t: "self.patch", hp: next });
    emit.log(s, "good", lines.drankPotion(def.name, healed));
    pushBag(s);
    return null;
  }

  return { of, award, use, check };
}
