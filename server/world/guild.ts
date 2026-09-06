/* 길드 등급 서비스. engine(판정) + db(기록) + net(방출) 을 조합한다.
 *
 * ★ 규칙은 engine/guild.ts 가 소유한다. 여기는 그 판정을 받아서 차감하고
 *   기록하고 알린다 — 이동·전투와 같은 분업이다.
 *
 * ★ 한 트랜잭션이다. 아이템은 냈는데 등급이 안 오르거나, 등급은 올랐는데
 *   아이템이 그대로인 상태가 존재해서는 안 된다. */

import { resolvePromote, rankName } from "../engine/guild";
import type { Balance } from "../engine/enemies";
import type { GameMap } from "../engine/map";
import type { Queries } from "../db/queries";
import { lines } from "../narration/lines";
import type { Emit } from "../net/emit";
import type { Session } from "../net/session";
import type { RankView } from "../../shared/protocol";

export interface GuildService {
  /** 지금 등급. 스냅샷이 쓴다. */
  view(rank: number): RankView;
  /** 승급을 신청한다. 실패하면 이유 문장을 돌려준다 (거절이 아니라 문장이다 —
   *  "아직 모자란다" 는 세계의 진실이지 클라이언트 계약 위반이 아니다). */
  promote(s: Session, npcId: string): string | null;
}

export function makeGuild(
  q: Queries,
  emit: Emit,
  map: GameMap,
  balance: Balance,
  clock: () => number,
  tx: (fn: () => void) => void,
  /** 가방이 바뀐 것을 알린다 (inventory 가 소유한 표현을 그대로 쓴다). */
  pushBag: (s: Session) => void,
): GuildService {
  const view = (rank: number): RankView => ({ level: rank, name: rankName(rank, balance) });

  function promote(s: Session, npcId: string): string | null {
    const npc = map.npc(npcId);
    if (!npc) return lines.noSuchNpc;
    /* 같은 방에 있어야 한다. 클라이언트가 어디서든 신청을 보낼 수 있으므로
       서버가 다시 본다 — 대화와 같은 규칙이다. */
    if (npc.roomId !== `${s.pos.region}:${s.pos.x},${s.pos.y}`) return lines.npcNotHere;
    if (!npc.guild) return lines.notGuild(npc.name);

    const r = resolvePromote(s.rank, balance, (itemId) => q.qtyOf.get(s.playerId, itemId)?.qty ?? 0);
    if (!r.ok && r.reason === "max") return lines.rankMax;
    if (!r.ok) {
      return lines.rankShort(
        r.to.name,
        r.missing.map((m) => `${balance.items[m.itemId]?.name ?? m.itemId} ${m.qty}개`).join(", "),
      );
    }

    const now = clock();
    try {
      /* ★ DB 커밋이 먼저, 메모리 갱신이 나중 (이동·전투와 같은 규칙). */
      tx(() => {
        for (const sp of r.spend) {
          const args = { player_id: s.playerId, item_id: sp.itemId, qty: sp.qty, now };
          /* 지우기가 먼저다. 순서를 바꾸면 정확히 요구 수량만큼 가진 사람이
             UPDATE 로 0이 되고(CHECK 위반) 트랜잭션이 통째로 깨진다. */
          const changed = q.spendItemAll.run(args).changes || q.spendItemSome.run(args).changes;
          if (changed === 0) throw new Error(`승급 차감 실패: ${sp.itemId}`);
        }
        q.promotePlayer.run(r.to.level, now, s.playerId);
      });
    } catch (err) {
      console.error("[guild] promote", err);
      return lines.rankFailed;
    }

    s.rank = r.to.level;
    emit.send(s, { t: "self.patch", rank: view(s.rank) });
    if (r.spend.length) pushBag(s);
    emit.log(s, "sys", lines.rankUp(r.to.name));
    return null;
  }

  return { view, promote };
}
