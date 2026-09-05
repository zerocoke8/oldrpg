/* hello / action 디스패치.
 *
 * ★ 2단계 파싱이 이 파일의 골격이다:
 *   1) 봉투만 느슨하게 파싱해서 seq 를 '먼저' 확보한다.
 *   2) 액션 본문을 variant 별로 엄격 검증한다.
 *   seq 를 뽑을 수 있는 모든 실패는 ack{ok:false} 로 답한다. error 로 답하면
 *   그 액션의 pending 엔트리가 클라이언트 큐에 영원히 남아, 예측 위치가
 *   서버와 한 칸 어긋난 채 연결이 끝날 때까지 복구되지 않는다.
 *
 * ★ Phase A / Phase B (규칙 4를 1단계 프로토콜 속성으로 못박는다):
 *   Phase A — await 가 하나도 없다. ack + self.patch + room.describe +
 *             모든 presence/room 이벤트 + 로스터 줄.
 *   Phase B — await roomText() 뒤의 log{narr} '하나뿐'. 세션별 프로미스 체인.
 *   2단계에 LLM 이 들어와도 (a) 이동이 LLM 뒤에 서지 않고 (b) 방 A 의 묘사가
 *   이미 방 B 에 선 플레이어에게 도착하는 인터리브가 구조적으로 불가능하다. */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { Dir, Pos, RoomId } from "../../shared/ids";
import { roomIdOf } from "../../shared/ids";
import type { Action, Limits, RejectReason, Snapshot } from "../../shared/protocol";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { makeActionSchemas, type Envelope } from "../../shared/validators";
import { sanitize, sanitizeName } from "../../shared/sanitize";
import { SPAWN, walkableAt } from "../engine/map";
import { resolveMove } from "../engine/move";
import type { World } from "../engine/world";
import type { Queries } from "../db/queries";
import { defaultName, lines } from "../narration/lines";
import type { RoomTextService } from "../world/roomText";
import type { Emit } from "./emit";
import type { Presence } from "./presence";
import { GRACE_MS, type Registry, type Session } from "./session";

export const LIMITS: Limits = {
  sayMaxLen: 200,
  unparsedMaxLen: 200,
  nameMaxLen: 16,
  actionsPerSec: 20,
  resyncPerSec: 1,
  framesPerSec: 40,
  maxFrameBytes: 16 * 1024,
  pingIntervalMs: 15_000,
  maxPending: 8,
};

const SCHEMAS = makeActionSchemas(LIMITS);

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export interface Ctx {
  reg: Registry;
  emit: Emit;
  presence: Presence;
  world: World;
  q: Queries;
  roomText: RoomTextService;
  clock: () => number;
}

/* ------------------------------------------------------------------ */
/* Phase B                                                             */
/* ------------------------------------------------------------------ */

/** 방 묘사를 세션별 체인에 얹는다. 이 체인 밖에서 log{narr} 을 보내는 곳은 없다. */
export function enqueueRoomText(ctx: Ctx, s: Session, roomId: RoomId): void {
  const epoch = s.connId; // 해소 시점에 비교할 에폭을 '지금' 붙잡는다
  s.chain = s.chain
    .then(async () => {
      if (s.connId !== epoch || !ctx.reg.isCurrent(s)) return;
      const { text, source } = await ctx.roomText.get(roomId);
      // 해소 시점 재확인: 같은 에폭이고 '여전히 그 방'일 때만 방출한다.
      // 1단계는 동기 렌더러라 무해하지만, 2단계에 가서야 넣으면
      // 그때는 이미 낡은 줄이 화면에 찍힌 뒤다.
      if (s.connId !== epoch || !ctx.reg.isCurrent(s)) return;
      if (roomIdOf(s.pos) !== roomId) return;
      ctx.emit.log(s, "narr", text, { roomId, source });
    })
    .catch((err: unknown) => {
      // 반드시 삼킨다 — 거부가 체인을 오염시키면 그 세션은 다시는
      // 방 묘사를 받지 못한다.
      console.error("[phaseB]", err);
    });
}

/* ------------------------------------------------------------------ */
/* hello                                                               */
/* ------------------------------------------------------------------ */

export interface HelloOutcome {
  session: Session;
  /** welcome 으로 돌려줄 원문 토큰. DB 에는 sha256 만 있다. */
  token: string;
  /** 저장된 좌표가 벽 안이라 스폰으로 이송했는가. */
  displaced: boolean;
  /** 기존 세션을 이어받았는가. 이어받았으면 관찰자 입장에서 그 플레이어는
   *  한 번도 사라진 적이 없으므로, 도착을 방출하지 '않는다'. */
  adopted: boolean;
}

export function handleHello(
  ctx: Ctx,
  socket: WebSocket,
  env: Extract<Envelope, { t: "hello" }>,
): HelloOutcome | { error: "protocol_version" } {
  if (env.pv !== PROTOCOL_VERSION) return { error: "protocol_version" };

  const now = ctx.clock();

  // 토큰 조회. '알 수 없는 토큰'도 오류가 아니라 신규 생성으로 흡수한다 —
  // 그러지 않으면 토큰 존재 여부를 묻는 오라클이 된다.
  const row = env.token ? ctx.q.playerByTokenHash.get(sha256(env.token)) : undefined;

  let playerId: string;
  let name: string;
  let token: string;
  let pos: Pos;
  let seen: Set<RoomId>;
  let hp: number;
  let maxHp: number;
  let displaced = false;

  if (row) {
    playerId = row.id;
    name = row.name;
    token = env.token!;
    pos = { region: row.region, x: row.x, y: row.y };
    // 저장된 좌표가 벽 안이면(맵이 바뀌었으면) 스폰으로 이송한다.
    // 메모리 권위 위치가 '처음 확립되는' 지점이 여기라, 검증도 여기가 맞다.
    if (!walkableAt(pos)) {
      pos = SPAWN;
      displaced = true;
    }
    seen = new Set(JSON.parse(row.seen) as RoomId[]);
    seen.add(roomIdOf(pos));
    hp = row.hp;
    maxHp = row.max_hp;
    if (displaced) {
      ctx.q.commitMove.run({ ...pos, seen: JSON.stringify([...seen]), now, id: playerId });
    } else {
      ctx.q.touchPlayer.run(now, playerId);
    }
  } else {
    playerId = randomUUID();
    name = sanitizeName(env.name, LIMITS.nameMaxLen) ?? defaultName(playerId);
    token = randomBytes(32).toString("hex");
    pos = SPAWN;
    seen = new Set([roomIdOf(SPAWN)]);
    hp = 40;
    maxHp = 40;
    ctx.q.insertPlayer.run({
      id: playerId,
      name,
      token_hash: sha256(token),
      region: pos.region,
      x: pos.x,
      y: pos.y,
      hp,
      max_hp: maxHp,
      seen: JSON.stringify([...seen]),
      now,
    });
  }

  const connId = ctx.reg.newConnId();
  const existing = ctx.reg.get(playerId);

  if (existing) {
    // 같은 캐릭터의 세션이 이미 있다. 두 경우 모두 '새 소켓이 이긴다'.
    if (existing.linger) {
      clearTimeout(existing.linger);
      existing.linger = null;
    }
    if (existing.socket) {
      // 살아 있는 소켓 교체. 옛 소켓에 이유를 알려주고 닫는다.
      // reconnect:false — 안 그러면 같은 탭 두 개가 무한 강퇴 핑퐁을 한다.
      try {
        existing.socket.send(
          JSON.stringify({
            t: "error",
            code: "replaced",
            message: "다른 탭이 이 캐릭터를 가져갔습니다.",
            reconnect: false,
          }),
        );
        existing.socket.close();
      } catch {
        /* 이미 닫힌 소켓 — 무시 */
      }
    }
    // 에폭을 올린다. 이 한 줄이 옛 소켓의 늦은 close 와 진행 중이던
    // Phase B 를 전부 무효화한다.
    existing.connId = connId;
    existing.socket = socket;
    existing.lastSeq = 0;
    existing.awaitingPong = 0;
    existing.brief = { id: playerId, name };
    if (displaced) ctx.reg.reposition(existing, pos);
    existing.seen = seen;
    // 살아 있는 소켓 교체든 유예 입양이든, 관찰자는 그가 떠났다는 말을 들은
    // 적이 없다. 그래서 돌아왔다는 말도 필요 없다 — 둘 다 조용하다.
    return { session: existing, token, displaced, adopted: true };
  }

  const session: Session = {
    playerId,
    connId,
    socket,
    brief: { id: playerId, name },
    pos,
    seen,
    hp,
    maxHp,
    lastSeq: 0,
    logN: 1,
    chain: Promise.resolve(),
    linger: null,
    actionTokens: LIMITS.actionsPerSec,
    resyncTokens: LIMITS.resyncPerSec,
    frameTokens: LIMITS.framesPerSec,
    lastRefill: now,
    awaitingPong: 0,
  };
  ctx.reg.add(session);
  return { session, token, displaced, adopted: false };
}

/** hello 직후의 Phase A: welcome -> snapshot -> 안내/이송 로그. */
export function sendConnectBurst(ctx: Ctx, s: Session, token: string, displaced: boolean): void {
  ctx.emit.send(s, {
    t: "welcome",
    pv: PROTOCOL_VERSION,
    self: s.brief,
    token,
    serverTime: ctx.clock(),
    limits: LIMITS,
  });
  ctx.emit.send(s, ctx.presence.snapshotFor(s, "connect", 0));
  ctx.emit.log(s, "sys", lines.welcome);
  if (displaced) ctx.emit.log(s, "sys", lines.displaced);
  ctx.presence.sendRoster(s, roomIdOf(s.pos));
  enqueueRoomText(ctx, s, roomIdOf(s.pos));
}

/* ------------------------------------------------------------------ */
/* action                                                              */
/* ------------------------------------------------------------------ */

function refill(s: Session, now: number): void {
  const dt = (now - s.lastRefill) / 1000;
  if (dt <= 0) return;
  s.lastRefill = now;
  s.actionTokens = Math.min(LIMITS.actionsPerSec, s.actionTokens + dt * LIMITS.actionsPerSec);
  s.resyncTokens = Math.min(LIMITS.resyncPerSec, s.resyncTokens + dt * LIMITS.resyncPerSec);
  s.frameTokens = Math.min(LIMITS.framesPerSec, s.frameTokens + dt * LIMITS.framesPerSec);
}

const reject = (ctx: Ctx, s: Session, seq: number, reason: RejectReason): void => {
  ctx.emit.send(s, { t: "ack", seq, ok: false, reason, pos: s.pos });
};

/** 봉투는 이미 검증되어 seq 를 확보한 상태로 들어온다.
 *  여기서 나가는 모든 응답은 ack 다 — 절대 error 가 아니다. */
export function handleAction(
  ctx: Ctx,
  s: Session,
  seq: number,
  raw: { type: string } & Record<string, unknown>,
): void {
  const now = ctx.clock();
  refill(s, now);

  if (s.actionTokens < 1) return reject(ctx, s, seq, "rate_limited");
  s.actionTokens -= 1;

  // 2단계 파싱: variant 별 엄격 검증
  let action: Action;
  switch (raw.type) {
    case "move": {
      const p = SCHEMAS.move.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    case "look": {
      const p = SCHEMAS.look.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    case "say": {
      const p = SCHEMAS.say.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    case "unparsed": {
      const p = SCHEMAS.unparsed.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    case "resync": {
      const p = SCHEMAS.resync.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    default:
      // 이 서버가 구현하지 않은 variant. 옛 서버가 새 클라이언트를 만나는
      // 경우가 정확히 이것이고, 크래시가 아니라 거절이어야 한다.
      return reject(ctx, s, seq, "unknown_action");
  }

  switch (action.type) {
    case "move":
      return doMove(ctx, s, seq, action.dir);
    case "look":
      return doLook(ctx, s, seq);
    case "say":
      return doSay(ctx, s, seq, action.text);
    case "unparsed":
      return doUnparsed(ctx, s, seq, action.raw);
    case "resync":
      return doResync(ctx, s, seq);
  }
}

function doMove(ctx: Ctx, s: Session, seq: number, dir: Dir): void {
  const from = s.pos;
  const result = resolveMove(from, dir);

  if (!result.ok) {
    // 벽은 엔진이 계산한 정상적 결정론 결과, 즉 '세계의 진실' 이지
    // 클라이언트 계약 위반이 아니다 (규칙 1). 그래서 error 가 아니라 ack 다.
    ctx.emit.send(s, { t: "ack", seq, ok: false, reason: "blocked", pos: s.pos });
    ctx.emit.log(s, "sys", lines.blocked);
    return;
  }

  const to = result.to;
  const newRoom = roomIdOf(to);
  const isNewlySeen = !s.seen.has(newRoom);
  const nextSeen = isNewlySeen ? new Set(s.seen).add(newRoom) : s.seen;

  // ★ DB 커밋이 먼저, 메모리 갱신이 나중.
  //   반대 순서면 "DB 와 메모리는 절대 어긋나지 않는다"에 보상 경로가 없다.
  try {
    ctx.q.commitMove.run({
      region: to.region,
      x: to.x,
      y: to.y,
      seen: JSON.stringify([...nextSeen]),
      now: ctx.clock(),
      id: s.playerId,
    });
  } catch (err) {
    console.error("[commitMove]", err);
    // 액션에 귀속 가능한 실패이므로 error 가 아니라 ack 다 —
    // 그래야 클라이언트 pending 큐가 비워진다.
    return reject(ctx, s, seq, "internal");
  }

  ctx.reg.reposition(s, to);
  s.seen = nextSeen;

  // ── Phase A: await 없음 ────────────────────────────────────────────
  ctx.emit.send(s, { t: "ack", seq, ok: true, reason: null, pos: to });
  if (isNewlySeen) ctx.emit.send(s, { t: "self.patch", seen: [...nextSeen] });
  ctx.presence.announceMove(s, from, to, dir);

  // ── Phase B ────────────────────────────────────────────────────────
  enqueueRoomText(ctx, s, newRoom);
}

function doLook(ctx: Ctx, s: Session, seq: number): void {
  ctx.emit.send(s, { t: "ack", seq, ok: true, reason: null, pos: s.pos });
  ctx.emit.send(s, { t: "room.describe", room: ctx.presence.roomView(s.pos, s) });
  ctx.presence.sendRoster(s, roomIdOf(s.pos));
  enqueueRoomText(ctx, s, roomIdOf(s.pos));
}

function doSay(ctx: Ctx, s: Session, seq: number, rawText: string): void {
  const text = sanitize(rawText);
  if (!text) {
    reject(ctx, s, seq, "empty");
    ctx.emit.log(s, "sys", lines.sayEmpty);
    return;
  }
  if (text.length > LIMITS.sayMaxLen) {
    // 자르지 않고 거절한다. 자르면 의도가 조용히 바뀐다.
    reject(ctx, s, seq, "too_long");
    ctx.emit.log(s, "sys", lines.sayTooLong);
    return;
  }
  ctx.emit.send(s, { t: "ack", seq, ok: true, reason: null, pos: s.pos });
  const roomId = roomIdOf(s.pos);
  // 자기 자신을 포함해 방 전체에. speaker 가 구조화 필드로 분리되어 있으므로
  // say 로 presence 줄을 위조할 수 없다.
  for (const o of ctx.reg.inRoom(roomId)) {
    ctx.emit.log(o, "say", text, { speaker: s.brief });
  }
}

function doUnparsed(ctx: Ctx, s: Session, seq: number, rawInput: string): void {
  const raw = sanitize(rawInput);
  if (!raw) {
    reject(ctx, s, seq, "empty");
    return;
  }
  if (raw.length > LIMITS.unparsedMaxLen) {
    reject(ctx, s, seq, "too_long");
    return;
  }
  ctx.emit.send(s, { t: "ack", seq, ok: true, reason: null, pos: s.pos });
  // 1단계는 고정 문장으로 답한다. 미래에 LLM 의도 추출을 붙이더라도 그 결과는
  // 사람에게 '제안' 으로 표시되고 사람이 재제출해야 엔진에 닿는다 —
  // 모델이 고른 targetId 가 그대로 엔진에 들어가면 규칙 1이 깨진다.
  ctx.emit.log(s, "sys", lines.unparsed(raw));
}

function doResync(ctx: Ctx, s: Session, seq: number): void {
  // resync 는 응답 크기가 유일하게 비유계인 액션이라 별도 예산을 쓴다.
  if (s.resyncTokens < 1) return reject(ctx, s, seq, "rate_limited");
  s.resyncTokens -= 1;
  ctx.emit.send(s, { t: "ack", seq, ok: true, reason: null, pos: s.pos });
  const snap: Snapshot = ctx.presence.snapshotFor(s, "resync", seq);
  ctx.emit.send(s, snap);
}

/* ------------------------------------------------------------------ */
/* 종료                                                                */
/* ------------------------------------------------------------------ */

/** 소켓 종료. 아무것도 방출하지 않고 유예를 건다 (사용자 선택: 조용한 새로고침). */
export function handleClose(ctx: Ctx, s: Session, epoch: number): void {
  // ★ 에폭 가드. 이 한 줄이 없으면 새로고침이 옛 소켓의 늦은 close 를 통해
  //   '새' 세션을 지워 상대 미니맵에서 영구히 사라진다.
  if (s.connId !== epoch || !ctx.reg.isCurrent(s)) return;
  if (s.socket === null) return; // 이미 유예 중

  s.socket = null;
  ctx.q.touchPlayer.run(ctx.clock(), s.playerId);

  s.linger = setTimeout(() => {
    // 유예 만료. 다시 한 번 에폭을 확인한다 — 그 사이 입양됐을 수 있다.
    if (s.connId !== epoch || !ctx.reg.isCurrent(s) || s.socket !== null) return;
    s.linger = null;
    ctx.presence.announceDeparture(s);
    ctx.reg.remove(s.playerId);
  }, GRACE_MS);
}
