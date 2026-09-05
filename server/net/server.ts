/* WebSocket 수명주기: 프레임 검증, 하트비트, 폭주 방지, 연결당 정확히 한 번의 hello.
 *
 * 여기서 나가는 error 는 '전부' 연결을 끊는다. 그래서 클라이언트의 pending 큐가
 * 살아남을 수 없고, ErrorEvent 에 seq 필드가 없어도 재조정이 완전하다. */

import { WebSocketServer, type WebSocket } from "ws";
import type { ErrorCode } from "../../shared/protocol";
import { zEnvelope } from "../../shared/validators";
import type { Emit } from "./emit";
import type { Presence } from "./presence";
import type { Registry, Session } from "./session";
import {
  handleAction,
  handleClose,
  handleHello,
  LIMITS,
  sendConnectBurst,
  type Ctx,
} from "./handlers";

/** 인증이 없으므로 캐릭터 생성은 예산 안에서만. IP 당 10분에 5개.
 *  'hello 마다 players 행 하나' 는 인증 없는 서버에서 무제한 쓰기 경로다. */
const NEW_CHARS_PER_IP = 5;
const NEW_CHAR_WINDOW_MS = 10 * 60 * 1000;
const MAX_SOCKETS_PER_IP = 20;

interface Conn {
  socket: WebSocket;
  ip: string;
  session: Session | null;
  epoch: number;
  frameTokens: number;
  lastRefill: number;
}

export function startServer(ctx: Ctx, port: number): WebSocketServer {
  const wss = new WebSocketServer({
    port,
    // 오버사이즈 프레임은 JSON.parse 이전에 ws 가 버린다.
    maxPayload: LIMITS.maxFrameBytes,
  });

  const socketsPerIp = new Map<string, number>();
  const newCharsPerIp = new Map<string, number[]>();

  function fatal(socket: WebSocket, code: ErrorCode, message: string, reconnect: boolean): void {
    try {
      socket.send(JSON.stringify({ t: "error", code, message, reconnect }));
    } catch {
      /* 이미 닫힘 */
    }
    socket.close();
  }

  function ipBudgetOk(ip: string): boolean {
    const now = ctx.clock();
    const hits = (newCharsPerIp.get(ip) ?? []).filter((t) => now - t < NEW_CHAR_WINDOW_MS);
    newCharsPerIp.set(ip, hits);
    return hits.length < NEW_CHARS_PER_IP;
  }

  wss.on("connection", (socket, req) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    const open = (socketsPerIp.get(ip) ?? 0) + 1;
    socketsPerIp.set(ip, open);
    if (open > MAX_SOCKETS_PER_IP) {
      socketsPerIp.set(ip, open - 1);
      fatal(socket, "flooding", "동시 연결이 너무 많습니다.", true);
      return;
    }

    const conn: Conn = {
      socket,
      ip,
      session: null,
      epoch: 0,
      frameTokens: LIMITS.framesPerSec,
      lastRefill: ctx.clock(),
    };

    socket.on("message", (data) => {
      const now = ctx.clock();
      // 프레임 예산: hello/pong 을 포함한 '모든' 인바운드 프레임이 여기를 지난다.
      // 액션 버킷만 있으면 hello 폭주나 pong 폭주를 막지 못한다.
      const dt = (now - conn.lastRefill) / 1000;
      conn.lastRefill = now;
      conn.frameTokens = Math.min(LIMITS.framesPerSec, conn.frameTokens + dt * LIMITS.framesPerSec);
      if (conn.frameTokens < 1) {
        fatal(socket, "flooding", "메시지가 너무 빠릅니다.", true);
        return;
      }
      conn.frameTokens -= 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        fatal(socket, "bad_message", "JSON 파싱 실패", true);
        return;
      }

      // ── 1단계 파싱: 봉투. 여기서 실패하는 프레임만이 error 자격이 있다. ──
      const env = zEnvelope.safeParse(parsed);
      if (!env.success) {
        fatal(socket, "bad_message", "알 수 없는 메시지 형식", true);
        return;
      }

      if (env.data.t === "hello") {
        if (conn.session) {
          // 연결당 정확히 한 번. 두 번째 hello 는 계약 위반이다.
          fatal(socket, "bad_message", "hello 는 연결당 한 번만 보냅니다.", false);
          return;
        }
        if (!env.data.token && !ipBudgetOk(ip)) {
          fatal(socket, "flooding", "새 캐릭터를 너무 자주 만들고 있습니다.", false);
          return;
        }
        const out = handleHello(ctx, socket, env.data);
        if ("error" in out) {
          fatal(socket, "protocol_version", "클라이언트가 낡았습니다. 새로고침하세요.", false);
          return;
        }
        if (!env.data.token) {
          const hits = newCharsPerIp.get(ip);
          if (hits) hits.push(now);
          else newCharsPerIp.set(ip, [now]);
        }
        conn.session = out.session;
        conn.epoch = out.session.connId;
        sendConnectBurst(ctx, out.session, out.token, out.displaced);
        // 도착 방출은 '신규' 일 때만. 입양이면 아무도 그가 떠났다는 말을
        // 들은 적이 없으므로 돌아왔다는 말도 필요 없다.
        if (!out.adopted) ctx.presence.announceArrival(out.session);
        return;
      }

      if (!conn.session) {
        // hello 전에 온 action/pong. 액션이면 seq 가 있으므로 ack 로 답하는 것이
        // 원칙이지만, 세션이 없으면 보낼 대상 Session 이 없다. 연결을 끊는 쪽이
        // 정직하고, 클라이언트는 재접속하면 된다 (pending 은 연결과 함께 사라진다).
        fatal(socket, "bad_message", "hello 를 먼저 보내야 합니다.", true);
        return;
      }

      // 옛 에폭의 소켓에서 온 메시지는 무시한다 (교체된 탭의 늦은 프레임).
      if (conn.session.connId !== conn.epoch) return;

      if (env.data.t === "pong") {
        conn.session.awaitingPong = 0;
        return;
      }

      // ── seq 단조 검사 ────────────────────────────────────────────────
      if (env.data.seq <= conn.session.lastSeq) {
        // 역행/중복. 연결을 끊으므로 pending 이 desync 를 남길 수 없다.
        fatal(socket, "bad_seq", "seq 가 역행했습니다.", true);
        return;
      }
      conn.session.lastSeq = env.data.seq;

      // ── 2단계 파싱은 handleAction 안에서. 여기부터는 전부 ack 로 답한다. ──
      handleAction(ctx, conn.session, env.data.seq, env.data.action as { type: string });
    });

    socket.on("close", () => {
      socketsPerIp.set(ip, Math.max(0, (socketsPerIp.get(ip) ?? 1) - 1));
      if (conn.session) handleClose(ctx, conn.session, conn.epoch);
    });

    socket.on("error", () => {
      /* close 가 뒤따른다 */
    });
  });

  /* 하트비트. 노트북 덮개를 닫은 소켓은 close 를 발화하지 않아,
     이게 없으면 상대 미니맵에 유령 점이 영원히 남는다. */
  const beat = setInterval(() => {
    let nonce = 0;
    for (const s of ctx.reg.all()) {
      if (!s.socket) continue; // 유예 중
      if (s.awaitingPong >= 2) {
        s.socket.terminate(); // -> close -> 유예 시작
        continue;
      }
      s.awaitingPong += 1;
      ctx.emit.send(s, { t: "ping", nonce: ++nonce });
    }
  }, LIMITS.pingIntervalMs);
  beat.unref?.();

  wss.on("close", () => clearInterval(beat));
  return wss;
}

export type { Ctx, Registry, Emit, Presence };
