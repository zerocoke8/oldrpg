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
import type { GameMap } from "../engine/map";
import { resolveMove } from "../engine/move";
import type { World } from "../engine/world";
import type { Queries } from "../db/queries";
import { defaultName, lines } from "../narration/lines";
import type { RoomTextService } from "../world/roomText";
import type { UpgradeService } from "../world/upgrade";
import type { CombatService } from "../world/combat";
import type { DialogueService } from "../world/dialogue";
import type { InventoryService } from "../world/inventory";
import type { GuildService } from "../world/guild";
import { rankName } from "../engine/guild";
import type { Balance } from "../engine/enemies";
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
  /** 세계의 구조. content/world/ 에서 읽어 검증된 것이 index.ts 에서 여기로 온다. */
  map: GameMap;
  world: World;
  q: Queries;
  roomText: RoomTextService;
  upgrades: UpgradeService;
  combat: CombatService;
  dialogue: DialogueService;
  inventory: InventoryService;
  guild: GuildService;
  balance: Balance;
  clock: () => number;
  /** 종료 중인가. true 면 handleClose 가 아무 일도 하지 않는다 —
   *  db.close() 뒤에 도착하는 소켓 close 이벤트가 닫힌 핸들에 쓰는 것을 막는다. */
  isShuttingDown: () => boolean;
}

/* ------------------------------------------------------------------ */
/* Phase B                                                             */
/* ------------------------------------------------------------------ */

/** 그 방에 살아 있는 적이 있으면 알린다. Phase A 다 — 구조화 상태에서
 *  순수 파생되므로 await 가 필요 없다. */
export function noticeEnemy(ctx: Ctx, s: Session, roomId: RoomId): void {
  const def = ctx.combat.enemyIn(roomId);
  if (def) ctx.emit.log(s, "bad", lines.enemyHere(def.name));
}

/** 이 방에 NPC 가 있으면 '있다' 고만 알린다. Phase A 다 — 구조화 상태에서
 *  순수 파생되므로 await 가 없다.
 *
 *  ★ 자동으로 말을 걸지 않는다. 두 가지 이유가 있고 둘 다 charter 다:
 *    - 지나가기만 하는 방에서 대사 생성이 도는 것은 순수한 낭비다 (규칙 2의
 *      "생성은 딱 한 번" 은 비용 이야기이기도 하다).
 *    - 방에 들어서자마자 대사가 쏟아지면 방 묘사(Phase B)가 그 밑에 묻힌다. */
export function noticeNpcs(ctx: Ctx, s: Session, roomId: RoomId): void {
  for (const npc of ctx.dialogue.npcsIn(roomId)) ctx.emit.log(s, "npc", lines.npcHere(npc.name));
}

/** 방 묘사를 세션별 체인에 얹는다. 이 체인 밖에서 log{narr} 을 보내는 곳은 없다. */
export function enqueueRoomText(ctx: Ctx, s: Session, roomId: RoomId): void {
  const epoch = s.connId; // 해소 시점에 비교할 에폭을 '지금' 붙잡는다
  s.chain = s.chain
    .then(async () => {
      if (s.connId !== epoch || !ctx.reg.isCurrent(s)) return;
      const { text, source, stateHash } = await ctx.roomText.get(roomId);
      // 해소 시점 재확인: 같은 에폭이고 '여전히 그 방'일 때만 방출한다.
      // 여기 도는 렌더러는 결정론적 폴백이라 사실상 즉시 해소되지만,
      // 이 가드가 없으면 낡은 줄이 화면에 찍힐 수 있다.
      if (s.connId !== epoch || !ctx.reg.isCurrent(s)) return;
      if (roomIdOf(s.pos) !== roomId) return;
      const logId = ctx.emit.log(s, "narr", text, { roomId, source });
      // ★ 규칙 4: 플레이어는 방금 문장을 받았다. 그게 아직 폴백이면
      //   여기서 백그라운드 승급을 걸고, 준비되면 log.replace 로 조용히
      //   갈아끼운다. 플레이어는 한 순간도 모델을 기다리지 않는다.
      ctx.upgrades.watch({ kind: "room", roomId, stateHash }, source, s, logId);
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
  /** hp<=0 인 채로 돌아와서 여기서 일으켰는가 (부활 타이머를 잃은 경우). */
  revived: boolean;
  /** 기존 세션을 이어받았는가. 이어받았으면 관찰자 입장에서 그 플레이어는
   *  한 번도 사라진 적이 없으므로, 도착을 방출하지 '않는다'. */
  adopted: boolean;
}

export function handleHello(
  ctx: Ctx,
  socket: WebSocket,
  env: Extract<Envelope, { t: "hello" }>,
  /** '실제로 새 캐릭터를 만들려는 순간' 에 호출된다. false 면 만들지 않는다.
   *  예산을 "token 이 null 인가" 가 아니라 "행을 만드는가" 에 물리는 것이 요점이다 —
   *  전자는 형식만 맞는 아무 64자리 hex 토큰으로 우회된다(알 수 없는 토큰은
   *  신규 생성으로 흡수되므로). 거절 모양은 두 경로가 동일해서
   *  "그 토큰이 존재하는가" 를 묻는 오라클이 되지 않는다. */
  mayCreate: () => boolean,
): HelloOutcome | { error: "protocol_version" | "flooding" } {
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
  let rank: number;
  let maxHp: number;
  let displaced = false;
  let revived = false;

  if (row) {
    playerId = row.id;
    name = row.name;
    token = env.token!;
    pos = { region: row.region, x: row.x, y: row.y };
    // 저장된 좌표가 벽 안이면(맵이 바뀌었으면) 스폰으로 이송한다.
    // 메모리 권위 위치가 '처음 확립되는' 지점이 여기라, 검증도 여기가 맞다.
    if (!ctx.map.walkableAt(pos)) {
      pos = ctx.map.spawn;
      displaced = true;
    }
    hp = row.hp;
    rank = row.rank;
    maxHp = row.max_hp;
    /* ★ 저장된 vitals 도 좌표와 같은 이유로 여기서 검사한다.
     *
     * 부활은 world/combat.ts 의 메모리 setTimeout 하나뿐이고, 그것을 잃는
     * 경로가 둘 있다: (a) 프로세스가 그 5초 안에 죽는다(tsx watch 재시작이
     * 정확히 이 창이다), (b) 끊긴 뒤 3~8초 사이에 링크데드로 죽으면 유예
     * 만료(8초)가 부활(사망+5초)보다 먼저 와서 세션이 지워지고 콜백이
     * !cur 로 빠져나간다. 그러면 hp=0 이 DB 에 남는데, HP 를 올리는 경로가
     * 전투 안(mend)에만 있고 전투는 hp<=0 을 거절하므로 캐릭터가 영구히
     * 굳는다 — 토큰을 버리는 것 말고 탈출구가 없다.
     *
     * 그래서 '메모리 타이머' 가 아니라 '재개 경로' 가 부활의 최종 보증이다.
     * 여기는 DB 가 진실인 유일한 지점이고, 타이머와 달리 유실되지 않는다.
     * 이중 부활은 나지 않는다: hp>0 이면 여기가 아무 일도 하지 않고,
     * 아래에서 connId 를 새 에폭으로 올리므로 아직 살아 있던 옛 타이머는
     * cur.connId !== s.connId 로 빠져나간다. */
    if (hp <= 0) {
      pos = ctx.map.spawn;
      hp = Math.max(1, Math.floor(maxHp / 2)); // combat.ts 의 부활과 같은 값
      revived = true;
    }
    seen = new Set(JSON.parse(row.seen) as RoomId[]);
    seen.add(roomIdOf(pos));
    if (displaced || revived) {
      ctx.q.commitMoveSeen.run({ ...pos, seen: JSON.stringify([...seen]), now, id: playerId });
      if (revived) ctx.q.setPlayerHp.run(hp, now, playerId);
    } else {
      ctx.q.touchPlayer.run(now, playerId);
    }
  } else {
    if (!mayCreate()) return { error: "flooding" };
    playerId = randomUUID();
    name = sanitizeName(env.name, LIMITS.nameMaxLen) ?? defaultName(playerId);
    token = randomBytes(32).toString("hex");
    pos = ctx.map.spawn;
    seen = new Set([roomIdOf(ctx.map.spawn)]);
    hp = ctx.balance.player.maxHp;
    rank = 0; // 미등록. 길드 접수원에게 신청해야 오른다
    maxHp = ctx.balance.player.maxHp;
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
    if (displaced || revived) ctx.reg.reposition(existing, pos);
    // 유예 중인 세션을 입양하는 경우, 메모리의 hp 도 DB 와 같아야 한다.
    existing.hp = hp;
    existing.maxHp = maxHp;
    existing.rank = rank;
    existing.seen = seen;
    // 살아 있는 소켓 교체든 유예 입양이든, 관찰자는 그가 떠났다는 말을 들은
    // 적이 없다. 그래서 돌아왔다는 말도 필요 없다 — 둘 다 조용하다.
    return { session: existing, token, displaced, revived, adopted: true };
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
    rank,
    lastSeq: 0,
    logPrefix: randomBytes(4).toString("hex"),
    logN: 1,
    chain: Promise.resolve(),
    linger: null,
    actionTokens: LIMITS.actionsPerSec,
    resyncTokens: LIMITS.resyncPerSec,
    lastRefill: now,
    awaitingPong: 0,
  };
  ctx.reg.add(session);
  return { session, token, displaced, revived, adopted: false };
}

/** hello 직후의 Phase A: welcome -> snapshot -> 안내/이송 로그. */
export function sendConnectBurst(
  ctx: Ctx,
  s: Session,
  token: string,
  displaced: boolean,
  revived: boolean,
): void {
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
  // 문장은 combat.ts 의 부활과 같은 것을 쓴다 — 플레이어에게는 같은 사건이다.
  if (revived) ctx.emit.log(s, "sys", lines.respawn);
  ctx.presence.sendRoster(s, roomIdOf(s.pos));
  noticeEnemy(ctx, s, roomIdOf(s.pos));
  noticeNpcs(ctx, s, roomIdOf(s.pos));
  enqueueRoomText(ctx, s, roomIdOf(s.pos));
}

/* ------------------------------------------------------------------ */
/* action                                                              */
/* ------------------------------------------------------------------ */

function refill(s: Session, now: number): void {
  // Date.now() 는 단조가 아니다 (NTP 보정, 수동 시계 변경). 음수 dt 를 그대로
  // 쓰면 토큰이 음수가 되어 모든 클라이언트가 rate_limited 로 잠긴다.
  const dt = Math.max(0, (now - s.lastRefill) / 1000);
  s.lastRefill = now;
  if (dt === 0) return;
  s.actionTokens = Math.min(LIMITS.actionsPerSec, s.actionTokens + dt * LIMITS.actionsPerSec);
  s.resyncTokens = Math.min(LIMITS.resyncPerSec, s.resyncTokens + dt * LIMITS.resyncPerSec);
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
    case "attack": {
      const p = SCHEMAS.attack.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    case "skill": {
      const p = SCHEMAS.skill.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    case "stop": {
      const p = SCHEMAS.stop.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    case "talk": {
      const p = SCHEMAS.talk.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    case "ask": {
      const p = SCHEMAS.ask.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    case "use_item": {
      const p = SCHEMAS.use_item.safeParse(raw);
      if (!p.success) return reject(ctx, s, seq, "bad_args");
      action = p.data;
      break;
    }
    case "promote": {
      const p = SCHEMAS.promote.safeParse(raw);
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
    case "attack":
      return doWorldCommand(ctx, s, seq, () => ctx.combat.attack(s));
    case "skill":
      return doWorldCommand(ctx, s, seq, () => ctx.combat.skill(s, action.skillId));
    case "stop":
      return doWorldCommand(ctx, s, seq, () => ctx.combat.stop(s));
    /* 대화도 전투와 같은 모양이다: "그런 이는 여기에 없다" 는 계약 위반이
       아니라 엔진이 계산한 세계의 진실이므로 거절이 아니라 문장으로 답한다. */
    case "talk":
      return doWorldCommand(ctx, s, seq, () => ctx.dialogue.talk(s, action.npcId));
    case "ask":
      return doWorldCommand(ctx, s, seq, () => ctx.dialogue.ask(s, action.npcId, action.topic));
    /* 전투 중이면 다음 스윙에 예약된다 — 그 판정은 combat 이 소유한다.
       "가지고 있지 않다" 도 거절이 아니라 문장이다 (벽 부딪힘과 같은 부류). */
    case "use_item":
      return doWorldCommand(ctx, s, seq, () => ctx.combat.useItem(s, action.itemId));
    case "promote":
      return doWorldCommand(ctx, s, seq, () => ctx.guild.promote(s, action.npcId));
  }
}

/** 전투와 대화 명령은 전부 같은 모양이다: 서비스가 실패 문장을 돌려주거나 null.
 *
 *  ★ 실패도 ack{ok:true} 다. "여기엔 적이 없다" / "그런 이는 여기에 없다" 는
 *    계약 위반이 아니라 엔진이 계산한 '세계의 진실' 이고, 벽 부딪힘과 정확히
 *    같은 부류다. (거절 이유가 아니라 문장으로 답하는 것이 요점이다.) */
function doWorldCommand(
  ctx: Ctx,
  s: Session,
  seq: number,
  run: () => string | null,
): void {
  ctx.emit.send(s, { t: "ack", seq, ok: true, reason: null, pos: s.pos });
  let refusal: string | null;
  try {
    refusal = run();
  } catch (err) {
    console.error("[worldCommand]", err);
    ctx.emit.log(s, "sys", "무언가 잘못됐다.");
    return;
  }
  if (refusal) ctx.emit.log(s, "sys", refusal);
}

function doMove(ctx: Ctx, s: Session, seq: number, dir: Dir): void {
  const from = s.pos;
  /* 봉인된 문이 열렸는지는 DB 가 아는 사실이다. 엔진은 db/ 를 모르므로
     읽는 함수를 넘긴다 — 난수·시계·밸런스와 같은 주입 방식이다. */
  const result = resolveMove(ctx.map, from, dir, {
    isFlagOn: (key: string) => ctx.world.flagValue(key) === true,
    rank: s.rank,
  });

  if (!result.ok) {
    /* 벽은 엔진이 계산한 정상적 결정론 결과, 즉 '세계의 진실' 이지
       클라이언트 계약 위반이 아니다 (규칙 1). 그래서 error 가 아니라 ack 다.

       ★ 이유는 둘 다 "blocked" 하나로 나간다. 와이어에서 벽과 잠긴 문을
         구별할 수 있으면, 클라이언트가 사방으로 이동을 찔러 보는 것만으로
         지도에 없는 문의 위치를 전부 알아낼 수 있다. 차이는 문장에만 있다. */
    ctx.emit.send(s, { t: "ack", seq, ok: false, reason: "blocked", pos: s.pos });
    /* 벽·봉인·등급이 전부 같은 reason 으로 나가고 문장만 다르다. 다만 등급은
       예외적으로 '무엇이 필요한지' 를 말해 준다 — 자격 문제는 감출 이유가
       없고, 감추면 플레이어가 할 일을 알 수 없다. */
    ctx.emit.log(
      s,
      "sys",
      result.reason === "sealed"
        ? lines.sealed
        : result.reason === "rank"
          ? lines.needRank(rankName(result.need, ctx.balance) ?? `${result.need}등급`)
          : lines.blocked,
    );
    return;
  }

  const to = result.to;
  const newRoom = roomIdOf(to);
  const isNewlySeen = !s.seen.has(newRoom);
  const nextSeen = isNewlySeen ? new Set(s.seen).add(newRoom) : s.seen;

  // ★ DB 커밋이 먼저, 메모리 갱신이 나중.
  //   반대 순서면 "DB 와 메모리는 절대 어긋나지 않는다"에 보상 경로가 없다.
  try {
    const now = ctx.clock();
    // 처음 밟는 칸일 때만 seen 을 직렬화한다. 대부분의 걸음은 이미 아는 칸이고,
    // 거기서 배열 전체를 다시 쓰는 것은 방 수에 비례하는 낭비다.
    if (isNewlySeen) {
      ctx.q.commitMoveSeen.run({
        region: to.region,
        x: to.x,
        y: to.y,
        seen: JSON.stringify([...nextSeen]),
        now,
        id: s.playerId,
      });
    } else {
      ctx.q.commitMove.run({ region: to.region, x: to.x, y: to.y, now, id: s.playerId });
    }
  } catch (err) {
    console.error("[commitMove]", err);
    // 액션에 귀속 가능한 실패이므로 error 가 아니라 ack 다 —
    // 그래야 클라이언트 pending 큐가 비워진다.
    return reject(ctx, s, seq, "internal");
  }

  ctx.reg.reposition(s, to);
  s.seen = nextSeen;
  // 방을 벗어나면 교전이 끊긴다. 별도의 '도망' 동사를 두지 않는 이유다 —
  // 실시간에서는 걸어 나가는 것이 곧 도망이다.
  ctx.combat.leave(s.playerId, "left");

  // ── Phase A: await 없음 ────────────────────────────────────────────
  ctx.emit.send(s, { t: "ack", seq, ok: true, reason: null, pos: to });
  if (isNewlySeen) ctx.emit.send(s, { t: "self.patch", seen: [...nextSeen] });
  ctx.presence.announceMove(s, from, to, dir);
  noticeEnemy(ctx, s, newRoom);
  noticeNpcs(ctx, s, newRoom);

  // ── Phase B ────────────────────────────────────────────────────────
  enqueueRoomText(ctx, s, newRoom);
}

function doLook(ctx: Ctx, s: Session, seq: number): void {
  ctx.emit.send(s, { t: "ack", seq, ok: true, reason: null, pos: s.pos });
  ctx.emit.send(s, { t: "room.describe", room: ctx.presence.roomView(s.pos, s) });
  ctx.presence.sendRoster(s, roomIdOf(s.pos));
  noticeEnemy(ctx, s, roomIdOf(s.pos));
  noticeNpcs(ctx, s, roomIdOf(s.pos));
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
  if (ctx.isShuttingDown()) return; // db 는 이미 닫혔거나 닫히는 중이다
  if (s.connId !== epoch || !ctx.reg.isCurrent(s)) return;
  if (s.socket === null) return; // 이미 유예 중

  s.socket = null;
  try {
    ctx.q.touchPlayer.run(ctx.clock(), s.playerId);
  } catch (err) {
    // 여기서 던지면 ws 의 'close' 리스너 안이라 uncaughtException 이 되고,
    // 그 전에 s.socket=null 을 해 둔 탓에 유예 타이머도 안 걸려 세션이 영구히 남는다.
    console.error("[handleClose] touchPlayer", err);
  }

  s.linger = setTimeout(() => {
    // 유예 만료. 다시 한 번 에폭을 확인한다 — 그 사이 입양됐을 수 있다.
    if (s.connId !== epoch || !ctx.reg.isCurrent(s) || s.socket !== null) return;
    s.linger = null;
    // 유예가 만료될 때까지는 전투가 이어진다 (링크데드 상태로 계속 맞는다).
    // 세션이 사라지는 지금이 전투에서도 빠질 때다.
    ctx.combat.leave(s.playerId, "gone");
    ctx.presence.announceDeparture(s);
    ctx.reg.remove(s.playerId);
  }, GRACE_MS);
  // 유예 타이머가 프로세스를 붙잡아 두지 않게 한다.
  s.linger.unref?.();
}
