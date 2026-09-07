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
import { roomIdOf } from "../../shared/ids";
import type { Award } from "../engine/combat";
import type { Balance } from "../engine/enemies";
import { givable } from "../engine/items";
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
  /** 같은 방의 사람에게 하나 건넨다. 실패하면 이유 문장을 돌려준다
   *  (거절이 아니라 문장이다 — use 와 같은 규칙). */
  give(s: Session, targetId: string, itemId: string): string | null;
  /** 가방이 바뀐 것을 알린다. 가방을 건드리는 다른 서비스(길드 승급 차감)가
   *  같은 표현을 쓰도록 밖으로 낸다 — 두 곳이 각자 만들면 모양이 갈린다. */
  push(s: Session): void;
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

  /** 같은 방의 사람에게 하나 건넨다.
   *
   *  ★ 대상을 reg.get 이 아니라 reg.inRoom 에서 얻는다. 두 가지를 동시에
   *    한다: 사거리 재검증(combat.ts 의 c.fighters.has 와 같은 모양)이고,
   *    reapStalePlayers 로 지워진 id 에 addItem 해서 FK 로 트랜잭션이 깨지는
   *    것을 막는다 (player_items 는 REFERENCES players(id) ON DELETE CASCADE).
   *
   *  ★ 실패 이유를 갈라 말하지 않는다 — giveNoOne 의 주석에 그 논거가 있다. */
  function give(s: Session, targetId: string, itemId: string): string | null {
    if (targetId === s.playerId) return lines.giveSelf;
    const target = reg.inRoom(roomIdOf(s.pos)).find((o) => o.playerId === targetId);
    if (!target) return lines.giveNoOne;

    const def = balance.items[itemId];
    const have = q.itemsOf.all(s.playerId).find((r) => r.item_id === itemId);
    // 정의가 없는 것과 가지고 있지 않은 것이 같은 문장이다 (check 와 같은 이유).
    if (!def || !have) return lines.noSuchItem;
    if (!givable(def)) return lines.notGivable(def.name);

    const now = clock();
    try {
      /* 차감과 지급이 한 트랜잭션이다. 갈라지면 '냈는데 안 갔다' 가 생기고
         그건 되돌릴 방법이 없다 — 승급의 차감과 정확히 같은 논거다. */
      tx(() => {
        const args = { player_id: s.playerId, item_id: itemId, qty: 1, now };
        /* 두 문장의 WHERE 가 qty<=1 / qty>1 로 배타적이라 하나만 돈다.
           (그래서 순서를 바꿔도 결과가 같다 — 그 함정은 가드 절이 이미 막았다.
            진짜 함정은 가드를 지우고 UPDATE 하나로 합치는 쪽이다: 정확히
            하나 가진 사람에서 CHECK (qty > 0) 이 터진다.) */
        const changed = q.spendItemAll.run(args).changes || q.spendItemSome.run(args).changes;
        // 0행 = 그 사이 다른 탭이 마지막 하나를 썼거나 다른 사람에게 건넸다.
        if (changed === 0) throw new Error("EMPTY");
        q.addItem.run({ player_id: target.playerId, item_id: itemId, qty: 1, now });
      });
    } catch (err) {
      if (err instanceof Error && err.message === "EMPTY") return lines.noSuchItem;
      console.error("[inventory] give", err);
      return lines.noSuchItem;
    }

    // 커밋이 끝난 뒤에 양쪽에. 둘은 서로 다른 문장을 듣는다.
    pushBag(s);
    pushBag(target);
    emit.log(s, "good", lines.gave(def.name, target.brief.name));
    emit.log(target, "good", lines.received(def.name, s.brief.name));
    return null;
  }

  return { of, award, use, check, give, push: pushBag };
}
