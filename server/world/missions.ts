/* 임무 서비스. engine(판정) + db(기록) + net(방출) 을 조합한다.
 * world/guild.ts 와 같은 모양이고 같은 분업이다 — 규칙은
 * engine/missions.ts 가 소유하고, 여기는 받아서 기록하고 알린다.
 *
 * ★ 제출은 한 트랜잭션이다. 완료로 찍혔는데 보수가 안 나가거나, 보수는
 *   나갔는데 완료가 안 찍힌 상태가 존재해서는 안 된다 (승급과 같은 규칙).
 *
 * ★ 진행은 전투가 부른다. 그 목록은 전리품과 '같은' 목록이어야 한다 —
 *   피해를 준 사람 전원이다. 막타 기준으로 두면 "같이 잡으면 전리품은
 *   나오는데 임무는 안 오른다" 가 되고, 그건 함께 싸울 이유를 깎는다. */

import { resolveAccept, resolveTurnIn, isPosted, isComplete, slayCredit } from "../engine/missions";
import type { MissionDef, MissionState } from "../engine/missions";
import type { Balance } from "../engine/enemies";
import type { GameMap } from "../engine/map";
import { rankName } from "../engine/guild";
import type { Queries, MissionRow } from "../db/queries";
import { lines } from "../narration/lines";
import type { Emit } from "../net/emit";
import type { Registry, Session } from "../net/session";
import type { MissionOffer, MissionView } from "../../shared/protocol";
import type { PlayerId } from "../../shared/ids";

export interface MissionService {
  /** 지금 받은 것들. 스냅샷과 self.patch 가 쓴다. 끝낸 것은 싣지 않는다 —
   *  일지는 '할 일' 이고, 지나간 것까지 쌓이면 목록이 영원히 자란다. */
  of(playerId: string): MissionView[];
  /** 그 NPC 가 지금 이 사람에게 내보일 것. 대화에 실린다. */
  offers(s: Session, npcId: string): MissionOffer[];
  accept(s: Session, npcId: string, missionId: string): string | null;
  turnIn(s: Session, npcId: string, missionId: string): string | null;
  /** 적 하나가 쓰러졌다. 공로자 전원의 진행을 올린다.
   *  ★ 전투의 핫패스에서 불린다. 임무를 하나도 안 받은 사람은 SELECT 한 번에
   *    끝난다 (행이 없으면 그걸로 끝). */
  onSlain(enemyId: string, playerIds: readonly PlayerId[]): void;
  /** 일지가 바뀐 것을 알린다. */
  push(s: Session): void;
}

const stateOf = (r: MissionRow): MissionState => ({
  missionId: r.mission_id,
  progress: r.progress,
  done: r.done_at !== null,
});

export function makeMissions(
  q: Queries,
  reg: Registry,
  emit: Emit,
  map: GameMap,
  balance: Balance,
  isFlagOn: (key: string) => boolean,
  clock: () => number,
  tx: (fn: () => void) => void,
  pushBag: (s: Session) => void,
): MissionService {
  const itemName = (id: string): string => balance.items[id]?.name ?? id;
  const reward = (r: readonly { itemId: string; qty: number }[]): string =>
    r.map((x) => `${itemName(x.itemId)} ${x.qty}개`).join(", ");

  function rowsOf(playerId: string): MissionRow[] {
    return q.missionsOf.all(playerId);
  }

  function of(playerId: string): MissionView[] {
    const out: MissionView[] = [];
    for (const row of rowsOf(playerId)) {
      if (row.done_at !== null) continue;
      const def = map.mission(row.mission_id);
      /* 정의가 사라진 임무(파일에서 지웠다)도 행은 남는다. 조용히 숨기지 않고
         id 를 그대로 보여 준다 — 유령이 생겼다는 것이 보여야 한다
         (가방의 '정의가 사라진 아이템' 과 같은 처리다). */
      if (!def) {
        out.push({ id: row.mission_id, name: row.mission_id, brief: "", progress: row.progress, goal: 0, done: false });
        continue;
      }
      out.push({
        id: def.id,
        name: def.name,
        brief: def.brief,
        progress: Math.min(row.progress, def.goal.count),
        goal: def.goal.count,
        done: isComplete(def, stateOf(row)),
      });
    }
    return out;
  }

  function push(s: Session): void {
    emit.send(s, { t: "self.patch", missions: of(s.playerId) });
  }

  /** 게시하는 NPC 인가, 그리고 같은 방인가. 승급과 같은 검사다 —
   *  클라이언트가 어디서든 보낼 수 있으므로 서버가 다시 본다. */
  function atNpc(s: Session, npcId: string): { def: MissionDef[] } | string {
    const npc = map.npc(npcId);
    if (!npc) return lines.noSuchNpc;
    if (npc.roomId !== `${s.pos.region}:${s.pos.x},${s.pos.y}`) return lines.npcNotHere;
    const posted = map.missionsOf(npcId);
    if (posted.length === 0) return lines.noMissions(npc.name);
    return { def: [...posted] };
  }

  function offers(s: Session, npcId: string): MissionOffer[] {
    const rows = new Map(rowsOf(s.playerId).map((r) => [r.mission_id, r]));
    const out: MissionOffer[] = [];
    for (const m of map.missionsOf(npcId)) {
      /* 아직 게시되지 않은 임무는 아예 나가지 않는다 — 잠긴 대화 주제와 같은
         이유다. "무엇을 하게 될 것인가" 자체가 스포일러가 된다. */
      if (!isPosted(m, isFlagOn)) continue;
      const row = rows.get(m.id);
      /* 끝낸 것은 목록에서 사라진다. 반복 임무가 없으므로 남겨 두면
         영영 누를 수 없는 항목이 쌓인다. */
      if (row?.done_at !== null && row !== undefined) continue;
      const st = row ? stateOf(row) : null;
      out.push({
        id: m.id,
        name: m.name,
        brief: m.brief,
        reward: reward(m.reward),
        minRank: m.minRank,
        /* ★ 자격이 모자라도 목록에는 나온다. 문의 minRank 와 같은 판단이다 —
           무엇을 하면 되는지는 감출 이유가 없다. 다만 무엇이 모자란지를
           클라이언트가 문구로 조립하지 않도록 상태만 실어 보낸다. */
        state: st === null ? (m.minRank > s.rank ? "locked" : "open") : isComplete(m, st) ? "complete" : "taken",
        progress: st?.progress ?? 0,
        goal: m.goal.count,
      });
    }
    return out;
  }

  function accept(s: Session, npcId: string, missionId: string): string | null {
    const at = atNpc(s, npcId);
    if (typeof at === "string") return at;
    const def = map.mission(missionId);
    /* 그 NPC 가 게시하는 것이어야 한다. 아니면 접수원 앞에서 아무 임무나
       받을 수 있고, 게시 장소가 뜻을 잃는다. */
    if (!def || def.npcId !== npcId) return lines.noSuchMission;

    const row = q.missionOf.get(s.playerId, missionId);
    const r = resolveAccept(def, s.rank, row ? stateOf(row) : null, isFlagOn);
    if (!r.ok) {
      if (r.reason === "unposted") return lines.noSuchMission;
      if (r.reason === "rank") {
        return lines.missionRank(def.name, rankName(r.need, balance) ?? `${r.need}등급`);
      }
      if (r.reason === "done") return lines.missionDone(def.name);
      return lines.missionTaken(def.name);
    }

    /* DO NOTHING 이라 경합해도 진행도가 0 으로 돌아가지 않는다. 0행이면
       그 사이에 다른 탭이 먼저 받은 것이고, 그건 실패가 아니다. */
    if (q.acceptMission.run({ player_id: s.playerId, mission_id: missionId, now: clock() }).changes === 0) {
      return lines.missionTaken(def.name);
    }
    push(s);
    emit.log(s, "sys", lines.missionAccepted(def.name, def.goal.count));
    return null;
  }

  function turnIn(s: Session, npcId: string, missionId: string): string | null {
    const at = atNpc(s, npcId);
    if (typeof at === "string") return at;
    const def = map.mission(missionId);
    if (!def || def.npcId !== npcId) return lines.noSuchMission;

    const row = q.missionOf.get(s.playerId, missionId);
    const r = resolveTurnIn(def, row ? stateOf(row) : null);
    if (!r.ok) {
      if (r.reason === "not_taken") return lines.missionNotTaken(def.name);
      if (r.reason === "done") return lines.missionDone(def.name);
      return lines.missionShort(def.name, r.have, r.need);
    }

    const now = clock();
    try {
      /* ★ DB 커밋이 먼저, 알림이 나중 (승급·이동과 같은 규칙).
         완료 찍기가 '먼저' 이고 그 0행 검사가 보수 지급을 막는다 — 두 탭에서
         동시에 제출해도 보수는 한 번만 나간다. 순서를 바꾸면 둘 다 지급된다. */
      tx(() => {
        if (q.completeMission.run({ player_id: s.playerId, mission_id: missionId, now }).changes === 0) {
          throw new Error("이미 제출됐다");
        }
        for (const rw of r.reward) {
          q.addItem.run({ player_id: s.playerId, item_id: rw.itemId, qty: rw.qty, now });
        }
      });
    } catch (err) {
      /* 경합으로 진 쪽은 '이미 냈다' 가 진실이다. 그 밖의 실패만 로그로 남긴다. */
      if (!(err instanceof Error && err.message === "이미 제출됐다")) {
        console.error("[missions] turnIn", err);
        return lines.missionFailed;
      }
      return lines.missionDone(def.name);
    }

    push(s);
    pushBag(s);
    emit.log(s, "good", lines.missionCleared(def.name, reward(r.reward)));
    return null;
  }

  function onSlain(enemyId: string, playerIds: readonly PlayerId[]): void {
    for (const playerId of playerIds) {
      const rows = rowsOf(playerId);
      if (rows.length === 0) continue;
      let changed = false;
      for (const row of rows) {
        const def = map.mission(row.mission_id);
        if (!def) continue;
        const by = slayCredit(def, stateOf(row), enemyId);
        if (by === 0) continue;
        q.advanceMission.run({
          player_id: playerId,
          mission_id: row.mission_id,
          by,
          cap: def.goal.count,
        });
        changed = true;
        const s = reg.get(playerId);
        if (!s) continue;
        const now = Math.min(row.progress + by, def.goal.count);
        emit.log(
          s,
          "sys",
          now >= def.goal.count
            ? lines.missionGoalMet(def.name)
            : lines.missionProgress(def.name, now, def.goal.count),
        );
      }
      /* 일지는 하나라도 바뀌었을 때 한 번만 보낸다 — 임무 셋이 같은 적을
         세면 self.patch 가 셋 나갈 이유가 없다. */
      if (!changed) continue;
      const s = reg.get(playerId);
      if (s) push(s);
    }
  }

  return { of, offers, accept, turnIn, onSlain, push };
}
