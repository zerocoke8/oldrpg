/* 세션 레지스트리와 유예(linger) 상태기계.
 *
 * ★ 유예의 계약 — 이걸 어기면 미니맵과 방 로스터가 어긋난다:
 *
 *   유예는 프로토콜에 '보이지 않는다'. 유예 중인 플레이어는 모든 관찰자와
 *   모든 스냅샷에게 그냥 "가만히 서 있는 플레이어"다.
 *
 *   - 소켓 종료 시 아무것도 방출하지 않는다 (presence.leave 도 room.leave 도 로그도).
 *     byRoom 과 sessions 에 그대로 남는다.
 *   - room.describe.occupants 와 snapshot.presence 에 '둘 다' 포함한다.
 *     하나만 포함하면 둘이 어긋나 '점 없는 유령'이 생긴다. 둘 다 포함하면
 *     pos 를 실어 보내므로 제3자도 점을 정상적으로 렌더한다.
 *   - 유예 안에 같은 토큰으로 돌아오면 타이머만 취소하고 역시 아무것도
 *     방출하지 않는다 (위치가 안 바뀌었으니 presence.move 조차 없다).
 *   - 유예가 만료돼야 비로소 presence.leave + room.leave + log 가 나간다.
 *
 *   이게 성립하려면 presence.join / room.enter 가 player.id 기준 '멱등 upsert'
 *   이고, 모르는 id 에 대한 leave 가 'no-op' 이어야 한다. 프로토콜에 그렇게
 *   적혀 있다.
 *
 * ★ connId 에폭 가드:
 *   close 핸들러와 Phase B 연속(continuation)은 반드시 connId 를 확인한다.
 *   이 한 줄이 없으면 새로고침이 옛 소켓의 늦은 close 를 통해 '새' 세션을
 *   지워, 상대 미니맵에서 영구히 사라진다. 두 브라우저 테스트에서 가장 먼저
 *   만나는 버그다. */

import type { WebSocket } from "ws";
import type { PlayerId, Pos, RoomId } from "../../shared/ids";
import { roomIdOf } from "../../shared/ids";
import type { PlayerBrief } from "../../shared/protocol";

/** 새로고침이 조용하도록. 로컬 새로고침 왕복은 보통 1초 미만이다. */
export const GRACE_MS = 8_000;

export interface Session {
  readonly playerId: PlayerId;
  /** 전역 단조. 소켓이 바뀔 때마다 증가한다. 에폭 가드의 근거. */
  connId: number;
  /** 유예 중에는 null 이다. 그래도 세션은 레지스트리에 살아 있다. */
  socket: WebSocket | null;
  brief: PlayerBrief;
  pos: Pos;
  seen: Set<RoomId>;
  hp: number;
  maxHp: number;
  /** '연결' 단위 seq. 소켓이 바뀌면 0으로 리셋한다 — 플레이어 단위로 두면
   *  재접속한 클라이언트가 seq 1을 보내고 전부 거절당해, 미니맵에는 살아
   *  있는데 움직일 수 없는 상태가 된다. */
  lastSeq: number;
  /** 로그 id = `${logPrefix}:${logN++}`.
   *  접두사가 '연결마다 무작위' 인 이유 둘:
   *   - 전역 단조 카운터(connId)를 쓰면 남의 접속 활동량이 id 로 샌다
   *   - 서버를 재시작하면 connId 가 1부터 다시 시작해, 재접속한 클라이언트의
   *     로그 리스트에서 옛 줄과 새 줄의 id 가 충돌한다 (React key 중복) */
  logPrefix: string;
  logN: number;
  /** Phase B 직렬화. 세션마다 하나라, 방 A 의 묘사가 이미 방 B 로 간
   *  플레이어에게 도착하는 인터리브가 구조적으로 불가능하다. */
  chain: Promise<void>;
  linger: NodeJS.Timeout | null;
  // 레이트리밋 상태 (토큰 버킷). 프레임 버킷은 연결 단위라 net/server.ts 가 따로 든다.
  actionTokens: number;
  resyncTokens: number;
  lastRefill: number;
  awaitingPong: number;
}

export class Registry {
  private readonly sessions = new Map<PlayerId, Session>();
  private readonly byRoom = new Map<RoomId, Set<PlayerId>>();
  private nextConnId = 1;

  newConnId(): number {
    return this.nextConnId++;
  }

  get(playerId: PlayerId): Session | undefined {
    return this.sessions.get(playerId);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  /** 유예 중인 세션도 포함한다 — 그것이 '가만히 서 있는 플레이어' 계약이다. */
  inRoom(roomId: RoomId): Session[] {
    const ids = this.byRoom.get(roomId);
    if (!ids) return [];
    const out: Session[] = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  add(s: Session): void {
    this.sessions.set(s.playerId, s);
    this.index(roomIdOf(s.pos), s.playerId);
  }

  remove(playerId: PlayerId): void {
    const s = this.sessions.get(playerId);
    if (!s) return;
    this.deindex(roomIdOf(s.pos), playerId);
    this.sessions.delete(playerId);
  }

  /** 위치 이동은 반드시 이걸로. byRoom 인덱스와 pos 가 어긋나면
   *  remove() 가 엉뚱한 방에서 지우고 유령이 남는다. */
  reposition(s: Session, to: Pos): void {
    this.deindex(roomIdOf(s.pos), s.playerId);
    s.pos = to;
    this.index(roomIdOf(to), s.playerId);
  }

  /** 에폭 가드. close 핸들러와 모든 지연 연속의 첫 줄. */
  isCurrent(s: Session): boolean {
    return this.sessions.get(s.playerId)?.connId === s.connId;
  }

  private index(roomId: RoomId, playerId: PlayerId): void {
    let set = this.byRoom.get(roomId);
    if (!set) {
      set = new Set();
      this.byRoom.set(roomId, set);
    }
    set.add(playerId);
  }

  private deindex(roomId: RoomId, playerId: PlayerId): void {
    const set = this.byRoom.get(roomId);
    if (!set) return;
    set.delete(playerId);
    if (set.size === 0) this.byRoom.delete(roomId);
  }
}

export const briefOf = (s: Session): PlayerBrief => s.brief;

/** 1단계의 가시성: 같은 region.
 *
 * 이건 월핵이자 O(N^2) 팬아웃이고, 7x7 프로토타입에서는 둘 다 정답,
 * 공개 서비스에서는 둘 다 오답이다. 여기가 '유일한 관문'인 것이 요점이다 —
 * 반경/파티/시야 조건이 붙어도 프로토콜은 한 글자도 바뀌지 않는다.
 * canSee 가 거짓이 되는 순간 서버는 presence.leave 를 보내는데, 그건 접속
 * 종료가 보내는 것과 '글자 그대로 같은 메시지'라 거리 탐침이 불가능하다. */
export const canSee = (viewer: Pos, subject: Pos): boolean => viewer.region === subject.region;
