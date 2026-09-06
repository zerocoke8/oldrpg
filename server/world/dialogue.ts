/* 대화. engine(누가 있고 어떤 주제가 열렸나) + world/npcText(대사) +
 * upgrade(승급) + net(방출) 을 조합한다.
 *
 * ★ 권위는 전부 서버다. 클라이언트가 받은 주제 목록은 '안내' 이지 권한이 아니다 —
 *   잠긴 주제를 물어도 서버가 거절한다. 목록을 그대로 믿으면 devtools 로
 *   봉인된 문 이야기를 미리 들을 수 있다.
 *
 * ★ 규칙 4: 대사도 폴백이 '즉시' 나가고 LLM 확정본은 log.replace 로 조용히
 *   교체된다 — 2단계의 승급 경로를 글자 그대로 재사용한다. 전투(0.5초)만큼
 *   급하지는 않지만, "생성은 딱 한 번, 그 뒤로 모두에게 동일"(charter 20줄)이
 *   그대로 필요하기 때문에 같은 구조를 쓴다. */

import type { RoomId } from "../../shared/ids";
import { roomIdOf } from "../../shared/ids";
import type { MissionOffer, NpcBrief, TopicView } from "../../shared/protocol";
import { GREET } from "../engine/npcs";
import type { World } from "../engine/world";
import type { GameMap } from "../engine/map";
import { lines } from "../narration/lines";
import type { Emit } from "../net/emit";
import type { Session } from "../net/session";
import type { NpcTextService } from "./npcText";
import type { UpgradeService } from "./upgrade";

export interface DialogueService {
  /** 말을 건다. 실패하면 이유 문장을 돌려준다 (거절이 아니라 문장이다). */
  talk(s: Session, npcId: string): string | null;
  ask(s: Session, npcId: string, topic: string): string | null;
  /** 방 묘사용. 이름만. */
  npcsIn(roomId: RoomId): NpcBrief[];
}

export function makeDialogue(
  world: World,
  /** NPC 배치의 출처. 방·적과 같은 주입이다. */
  map: GameMap,
  npcText: NpcTextService,
  upgrades: UpgradeService,
  emit: Emit,
  /** 그 사람이 그 NPC 에게서 지금 받을 수 있는 임무. 주입인 이유는 순환이다 —
   *  world/missions 는 문장을 위해 lines 를, 기록을 위해 db 를 쓰고, 대화는
   *  그중 아무것도 알 필요가 없다. 게시 여부·자격 판정은 전부 저쪽이 한다. */
  offersFor: (s: Session, npcId: string) => MissionOffer[] = () => [],
): DialogueService {
  const npcsIn = (roomId: RoomId): NpcBrief[] =>
    map.npcsInRoom(roomId).map((n) => ({ id: n.id, name: n.name, ...(n.guild ? { guild: true } : {}) }));

  /** 지금 열려 있는 주제만. 잠긴 것은 목록에 아예 없다 —
   *  "무엇을 물을 수 있는가" 자체가 세계의 상태이고 스포일러가 될 수 있다. */
  function topicsFor(npcId: string): TopicView[] {
    return world
      .openTopics(npcId)
      .filter((t) => t.id !== GREET && t.label)
      .map((t) => ({ id: t.id, label: t.label! }));
  }

  /** 같은 방에 있는 NPC 인지 확인한다. 클라이언트가 보낸 npcId 는 신뢰하지 않는다. */
  function resolve(s: Session, npcId: string): { ok: true } | { ok: false; why: string } {
    const npc = world.npc(npcId);
    if (!npc) return { ok: false, why: lines.noSuchNpc };
    if (npc.roomId !== roomIdOf(s.pos)) return { ok: false, why: lines.npcNotHere };
    return { ok: true };
  }

  /** 대사 한 줄을 내보내고, 폴백이면 승급을 건다. */
  function say(s: Session, npcId: string, topic: string): void {
    const npc = world.npc(npcId)!;
    const epoch = s.connId;
    void npcText
      .get(npcId, topic)
      .then(({ text, source, stateHash }) => {
        // 해소 시점 재확인: 같은 에폭이고 여전히 그 NPC 옆일 때만.
        if (s.connId !== epoch) return;
        if (roomIdOf(s.pos) !== npc.roomId) return;
        // source 를 함께 싣는다: 방 묘사와 같은 규칙이고, 클라이언트의
        // "새로 생성됨" 뱃지가 대사에도 그대로 붙는다.
        const say = (t: string) => lines.npcSays(npc.name, t);
        const logId = emit.log(s, "npc", say(text), { source });
        // ★ 틀을 함께 넘긴다. 안 그러면 승급된 순간 "제단지기:" 가 사라진다.
        upgrades.watch({ kind: "npc", npcId, topic, stateHash }, source, s, logId, say);
      })
      .catch((err: unknown) => {
        console.error(`[dialogue] ${npcId}/${topic}`, err);
      });
  }

  function talk(s: Session, npcId: string): string | null {
    const r = resolve(s, npcId);
    if (!r.ok) return r.why;
    const npc = world.npc(npcId)!;
    emit.send(s, {
      t: "npc.dialogue",
      dialogue: { npc: { id: npc.id, name: npc.name }, topics: topicsFor(npcId), missions: offersFor(s, npcId) },
    });
    say(s, npcId, GREET);
    return null;
  }

  function ask(s: Session, npcId: string, topic: string): string | null {
    const r = resolve(s, npcId);
    if (!r.ok) return r.why;
    // ★ 서버가 다시 본다. 클라이언트의 목록은 권한이 아니다.
    const open = world.openTopics(npcId).some((t) => t.id === topic);
    if (!open) return lines.topicClosed;
    const npc = world.npc(npcId)!;
    // 주제 목록을 함께 갱신한다 — 그 사이 세계가 바뀌어 새 주제가 열렸을 수 있다.
    emit.send(s, {
      t: "npc.dialogue",
      dialogue: { npc: { id: npc.id, name: npc.name }, topics: topicsFor(npcId), missions: offersFor(s, npcId) },
    });
    say(s, npcId, topic);
    return null;
  }

  return { talk, ask, npcsIn };
}
