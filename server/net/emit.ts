/* 타입 안전 송신. 서버에서 소켓에 바이트를 쓰는 유일한 곳.
 *
 * ★ 에폭 가드가 '방출'의 성질이지 close 핸들러의 성질이 아니다.
 *   send() 는 Session 을 받고(PlayerId 가 아니라) 그 세션이 여전히 현재
 *   에폭인지 확인한다. 그래서 Phase B 가 늦게 해소되어도 옛 소켓으로
 *   가지 않고, 유예 중인 세션(socket === null)에는 조용히 버려진다. */

import type { ServerMsg, LogKind, LogEvent, PlayerBrief, TextSource } from "../../shared/protocol";
import type { RoomId } from "../../shared/ids";
import type { Registry, Session } from "./session";

export function makeEmit(reg: Registry) {
  function send(s: Session, msg: ServerMsg): void {
    if (!reg.isCurrent(s)) return; // 옛 에폭 — 조용히 버린다
    const sock = s.socket;
    if (!sock || sock.readyState !== sock.OPEN) return; // 유예 중이거나 닫히는 중
    sock.send(JSON.stringify(msg));
  }

  /** 로그 id 는 수신자별로 스코프된 불투명 문자열이다. 접두사가 무작위라
   *  전역 순서 정보를 담지 않고(남의 활동량이 새지 않고), 서버 재시작 후에도
   *  옛 id 와 충돌하지 않는다. log.replace 가 주소로 쓰기에 충분하다. */
  function log(
    s: Session,
    kind: LogKind,
    text: string,
    extra?: { speaker?: PlayerBrief; roomId?: RoomId; source?: TextSource },
  ): string {
    const id = `${s.logPrefix}:${s.logN++}`;
    const msg: LogEvent = { t: "log", id, kind, text };
    if (extra?.speaker) msg.speaker = extra.speaker;
    if (extra?.roomId) msg.roomId = extra.roomId;
    if (extra?.source) msg.source = extra.source;
    send(s, msg);
    return id;
  }

  /** 그 방의 재실자에게. 유예 중인 세션도 목록에는 있지만 send() 가
   *  소켓 없음을 이유로 버리므로, 호출부가 유예를 신경 쓸 필요가 없다. */
  function toRoom(roomId: RoomId, except: Session | null, fn: (s: Session) => void): void {
    for (const s of reg.inRoom(roomId)) {
      if (except && s.playerId === except.playerId) continue;
      fn(s);
    }
  }

  return { send, log, toRoom };
}

export type Emit = ReturnType<typeof makeEmit>;
