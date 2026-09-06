/* presence 계열(미니맵 피드)과 room 계열(방 서사 피드)의 팬아웃.
 *
 * 두 계열을 구조적으로 분리한 이유: 팬아웃이 아파지면 제일 먼저 하는 일이
 * presence 를 throttle 하고 중간 위치를 버리는 것인데, 하나로 합쳐 뒀다면
 * 그 throttle 이 "○○ 님이 들어왔다"를 조용히 삼킨다.
 *
 * ★ 가시성 diff 는 '대칭'으로 돌린다 — 관찰자->이동자와 이동자->관찰자 양쪽.
 *   1단계 canSee 는 지역 동일성이라 결과가 늘 참이지만, 반경 기반이 되는 날
 *   "내가 남에게 걸어가면 남이 안 보인다" 는 침묵 버그가 이미 막혀 있다.
 *
 * ★ 방출 순서 규칙: presence.* 를 room.* 보다 먼저 보낸다.
 *   로그에 "사라졌다" 가 찍히는 순간 미니맵의 점은 이미 옮겨져 있어야 한다. */

import type { Dir, Pos, RoomId } from "../../shared/ids";
import { OPPOSITE, roomIdOf } from "../../shared/ids";
import type { PresenceEntry, RoomView, Snapshot, WorldFlagView } from "../../shared/protocol";
import { lines } from "../narration/lines";
import { regionView } from "../engine/map";
import type { Emit } from "./emit";
import { canSee, type Registry, type Session } from "./session";

export function makePresence(
  reg: Registry,
  emit: Emit,
  /** 공개된 월드 플래그. 스냅샷이 실어야 재접속한 클라이언트가 접속 전에
   *  일어난 일을 알 수 있다 — world.flag 델타만으로는 영영 모른다.
   *  주입인 이유: presence 는 world/events 를 import 하지 않는다 (순환). */
  publicFlags: () => WorldFlagView[] = () => [],
) {
  const others = (self: Session): Session[] =>
    reg.all().filter((s) => s.playerId !== self.playerId);

  /** 유예 중인 세션도 포함한다. snapshot.presence 와 반드시 같은 규칙이어야
   *  하고, 둘이 어긋나면 '점 없는 유령' 이 생긴다. */
  function roomView(pos: Pos, self: Session | null): RoomView {
    const roomId = roomIdOf(pos);
    const occupants = reg
      .inRoom(roomId)
      .filter((s) => !self || s.playerId !== self.playerId)
      .map((s) => s.brief);
    return { roomId, pos, occupants };
  }

  function visiblePresence(self: Session): PresenceEntry[] {
    return others(self)
      .filter((o) => canSee(self.pos, o.pos))
      .map((o) => ({ player: o.brief, pos: o.pos }));
  }

  function snapshotFor(self: Session, reason: Snapshot["reason"], ackSeq: number): Snapshot {
    return {
      t: "snapshot",
      reason,
      ackSeq,
      self: {
        id: self.playerId,
        name: self.brief.name,
        pos: self.pos,
        hp: self.hp,
        maxHp: self.maxHp,
        seen: [...self.seen],
      },
      region: regionView(),
      room: roomView(self.pos, self),
      presence: visiblePresence(self),
      world: publicFlags(),
    };
  }

  /** 자기 방에 이미 서 있는 사람들. Phase A 에서 나간다 —
   *  room.occupants 에서 순수 파생되므로 await 가 필요 없다.
   *  (Phase B 에 두면 Phase B 가 '방 묘사 한 종류'라는 성질이 깨진다.) */
  function sendRoster(self: Session, roomId: RoomId): void {
    const names = reg
      .inRoom(roomId)
      .filter((s) => s.playerId !== self.playerId)
      .map((s) => s.brief.name);
    if (names.length) emit.log(self, "presence", lines.roster(names));
  }

  /** 새 세션이 세계에 처음 등장했다 (신규 캐릭터 또는 유예가 이미 만료된 뒤의 재접속).
   *  유예 안에 돌아온 '입양(adopt)' 경로는 이걸 부르지 않는다 — 아무도 그가
   *  떠났다는 말을 듣지 못했으므로 돌아왔다는 말도 필요 없다. */
  function announceArrival(self: Session): void {
    for (const o of others(self)) {
      if (canSee(o.pos, self.pos)) emit.send(o, { t: "presence.join", player: self.brief, pos: self.pos });
    }
    const roomId = roomIdOf(self.pos);
    emit.toRoom(roomId, self, (o) => {
      emit.send(o, { t: "room.enter", player: self.brief, fromDir: null });
      emit.log(o, "presence", lines.entered(self.brief.name, null));
    });
  }

  /** 유예 만료. 여기서야 비로소 '떠났다'가 방출된다. */
  function announceDeparture(self: Session): void {
    for (const o of others(self)) {
      if (canSee(o.pos, self.pos)) emit.send(o, { t: "presence.leave", playerId: self.playerId });
    }
    emit.toRoom(roomIdOf(self.pos), self, (o) => {
      emit.send(o, { t: "room.leave", playerId: self.playerId, toDir: null });
      emit.log(o, "presence", lines.left(self.brief.name, null));
    });
  }

  /** 이동 확정 후의 Phase A 방출 전부. await 가 하나도 없다 (규칙 4). */
  function announceMove(self: Session, from: Pos, to: Pos, dir: Dir): void {
    // ── 1. presence: 대칭 가시성 diff ──────────────────────────────────
    for (const o of others(self)) {
      // 관찰자 o 가 '이동자' 를 보는가
      const was = canSee(o.pos, from);
      const now = canSee(o.pos, to);
      if (!was && now) emit.send(o, { t: "presence.join", player: self.brief, pos: to });
      else if (was && !now) emit.send(o, { t: "presence.leave", playerId: self.playerId });
      else if (was && now) emit.send(o, { t: "presence.move", playerId: self.playerId, pos: to });

      // '이동자' 가 관찰자 o 를 보는가 (o 는 가만히 있지만 내 시야가 움직였다)
      const sawBefore = canSee(from, o.pos);
      const seesNow = canSee(to, o.pos);
      if (!sawBefore && seesNow) emit.send(self, { t: "presence.join", player: o.brief, pos: o.pos });
      else if (sawBefore && !seesNow) emit.send(self, { t: "presence.leave", playerId: o.playerId });
    }

    // ── 2. room: 방이 바뀐 경우에만 ────────────────────────────────────
    const fromRoom = roomIdOf(from);
    const toRoom = roomIdOf(to);
    if (fromRoom !== toRoom) {
      emit.toRoom(fromRoom, self, (o) => {
        emit.send(o, { t: "room.leave", playerId: self.playerId, toDir: dir });
        emit.log(o, "presence", lines.left(self.brief.name, dir));
      });
      const fromDir = OPPOSITE[dir];
      emit.toRoom(toRoom, self, (o) => {
        emit.send(o, { t: "room.enter", player: self.brief, fromDir });
        emit.log(o, "presence", lines.entered(self.brief.name, fromDir));
      });
    }

    // ── 3. 이동자 자신 ────────────────────────────────────────────────
    emit.send(self, { t: "room.describe", room: roomView(to, self) });
    if (fromRoom !== toRoom) sendRoster(self, toRoom);
  }

  return {
    roomView,
    visiblePresence,
    snapshotFor,
    sendRoster,
    announceArrival,
    announceDeparture,
    announceMove,
  };
}

export type Presence = ReturnType<typeof makePresence>;
