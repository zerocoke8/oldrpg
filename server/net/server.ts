/* WebSocket 수명주기: 프레임 검증, 하트비트, 폭주 방지, 연결당 정확히 한 번의 hello.
 *
 * 여기서 나가는 error 는 '전부' 연결을 끊는다. 그래서 클라이언트의 pending 큐가
 * 살아남을 수 없고, ErrorEvent 에 seq 필드가 없어도 재조정이 완전하다. */

import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { makeStaticHandler } from "./static";
import type { ErrorCode } from "../../shared/protocol";
import { zEnvelope } from "../../shared/validators";
import type { Emit } from "./emit";
import type { Presence } from "./presence";
import type { Registry, Session } from "./session";
import { resolveAuth } from "./accounts";
import { lines } from "../narration/lines";
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
  /** hello 를 받고 계정 검증(scrypt)을 기다리는 중. 그 사이에 온 프레임은
   *  조용히 버린다 — 세션이 아직 없어서 ack 를 보낼 대상이 없고, 연결을
   *  끊으면 정상적인 클라이언트가 경합으로 죽는다. */
  helloPending: boolean;
  epoch: number;
  frameTokens: number;
  lastRefill: number;
  /** fatal() 이 호출됐다. WebSocket close 는 핸드셰이크라 즉시 닫히지 않으므로,
   *  이 플래그가 없으면 계약을 어긴 클라이언트가 error 를 받은 뒤에도
   *  ws 의 closeTimeout(30초) 동안 계속 액션을 보낼 수 있다. */
  dead: boolean;
}

/** ws 업그레이드를 받는 경로. 나머지는 전부 정적 파일이다. */
export const WS_PATH = "/ws";

/** 프로세스 전체 동시 접속 상한. 인증이 없는 서버를 공개하는 이상,
 *  IP 단위 상한만으로는 부족하다 (IP 는 얼마든지 바뀐다). */
const MAX_SOCKETS = Number(process.env.MUD_MAX_SOCKETS ?? 200);

/** 신뢰하는 프록시 홉 수. 0 이면 X-Forwarded-For 를 아예 보지 않는다.
 *
 *  ★ 기본이 0 이어야 한다. XFF 는 클라이언트가 마음대로 보낼 수 있으므로,
 *    무조건 믿으면 IP 단위 예산이 통째로 우회된다.
 *  ★ 그리고 '가장 왼쪽' 이 아니라 '오른쪽에서 n번째' 를 쓴다. 프록시는 자기가
 *    실제로 본 주소를 뒤에 덧붙이므로, 클라이언트가 위조해 보낸 값은 왼쪽에
 *    남고 우리 프록시가 본 진짜 주소가 맨 뒤에 붙는다. */
const TRUST_PROXY = Number(process.env.MUD_TRUST_PROXY ?? 0);

export interface Listening {
  wss: WebSocketServer;
  close(): Promise<void>;
}

export function startServer(ctx: Ctx, port: number, tx: (fn: () => void) => void): Listening {
  const serveStatic = makeStaticHandler({ root: process.env.MUD_STATIC ?? "dist" });
  const http = createServer(serveStatic);
  /* noServer: 업그레이드를 우리가 직접 받는다. 같은 포트에서 정적 파일과
     ws 를 함께 다루기 위한 유일한 방법이다. */
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });

  http.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  /* 포트를 못 잡으면 스택 트레이스가 아니라 사람이 읽을 문장으로 죽는다.
     배포에서 가장 흔한 첫 실패가 이것이고, 처리하지 않으면 unhandled 'error'
     이벤트로 프로세스가 통째로 터진다. */
  http.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[mud] 포트 ${port} 가 이미 쓰이고 있다. MUD_PORT 로 바꾸거나 그 프로세스를 끌 것.`);
    } else {
      console.error("[mud] 서버를 열 수 없다:", err.message);
    }
    process.exit(1);
  });
  http.listen(port);

  /** 요청을 보낸 쪽의 주소. 프록시 뒤에서는 remoteAddress 가 프록시 것이라
   *  '전원이 한 버킷' 이 되어 서로를 flooding 으로 밀어낸다. */
  function clientIp(req: IncomingMessage): string {
    if (TRUST_PROXY > 0) {
      const xff = req.headers["x-forwarded-for"];
      const list = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((v) => v.trim());
      const hop = list[list.length - TRUST_PROXY];
      if (hop) return hop;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  const socketsPerIp = new Map<string, number>();
  const newCharsPerIp = new Map<string, number[]>();

  function fatal(conn: Conn, code: ErrorCode, message: string, reconnect: boolean): void {
    conn.dead = true; // 이 뒤로 이 연결의 인바운드는 전부 버린다
    try {
      conn.socket.send(JSON.stringify({ t: "error", code, message, reconnect }));
    } catch {
      /* 이미 닫힘 */
    }
    conn.socket.close();
    // 상대가 close 핸드셰이크를 무시하면 ws 는 30초를 기다린다. 계약을 어긴
    // 연결에 그만큼 자원을 내줄 이유가 없다.
    setTimeout(() => conn.socket.terminate(), 1000).unref?.();
  }

  /** '실제로 새 캐릭터를 만드는' 순간 호출된다. 통과하면 그 자리에서 예산을 쓴다.
   *  "token 이 null 인가" 에 물리면 형식만 맞는 아무 64자리 hex 토큰으로 우회된다 —
   *  알 수 없는 토큰은 (오라클이 되지 않으려고) 신규 생성으로 흡수되기 때문이다. */
  function mayCreateCharacter(ip: string): boolean {
    const now = ctx.clock();
    const hits = (newCharsPerIp.get(ip) ?? []).filter((t) => now - t < NEW_CHAR_WINDOW_MS);
    if (hits.length >= NEW_CHARS_PER_IP) {
      if (hits.length) newCharsPerIp.set(ip, hits);
      else newCharsPerIp.delete(ip);
      return false;
    }
    hits.push(now);
    newCharsPerIp.set(ip, hits);
    return true;
  }

  wss.on("connection", (socket, req: IncomingMessage) => {
    const ip = clientIp(req);
    const open = (socketsPerIp.get(ip) ?? 0) + 1;
    socketsPerIp.set(ip, open);

    /* ★ 감소를 '지금' 등록한다. 예전에는 상한 검사에서 return 한 뒤 한참 아래에서
       close 리스너를 달았는데, 그러면 거절된 연결이 카운터를 영구히 +1 한다.
       프록시 뒤에서는 모두가 한 버킷이므로 누적 거절이 상한에 닿는 순간
       서버가 '모두를' 영영 거부하고, 시도할 때마다 더 나빠진다. */
    socket.on("close", () => {
      const left = Math.max(0, (socketsPerIp.get(ip) ?? 1) - 1);
      // 0이면 키를 지운다. 안 지우면 IP 마다 항목이 영원히 쌓인다.
      if (left) socketsPerIp.set(ip, left);
      else socketsPerIp.delete(ip);
    });

    const conn: Conn = {
      socket,
      ip,
      session: null,
      helloPending: false,
      epoch: 0,
      frameTokens: LIMITS.framesPerSec,
      lastRefill: ctx.clock(),
      dead: false,
    };

    if (open > MAX_SOCKETS_PER_IP || wss.clients.size > MAX_SOCKETS) {
      fatal(conn, "flooding", "동시 연결이 너무 많습니다.", true);
      return;
    }

    socket.on("message", (data) => {
      if (conn.dead) return; // error 를 이미 보냈다. 소켓이 실제로 닫힐 때까지 버린다.
      const now = ctx.clock();
      // 프레임 예산: hello/pong 을 포함한 '모든' 인바운드 프레임이 여기를 지난다.
      // 액션 버킷만 있으면 hello 폭주나 pong 폭주를 막지 못한다.
      // Date.now() 는 단조가 아니다. 음수 dt 를 그대로 쓰면 토큰이 음수가 되어
      // 시계가 뒤로 튄 순간 모든 클라이언트가 flooding 으로 끊긴다.
      const dt = Math.max(0, (now - conn.lastRefill) / 1000);
      conn.lastRefill = now;
      conn.frameTokens = Math.min(LIMITS.framesPerSec, conn.frameTokens + dt * LIMITS.framesPerSec);
      if (conn.frameTokens < 1) {
        fatal(conn, "flooding", "메시지가 너무 빠릅니다.", true);
        return;
      }
      conn.frameTokens -= 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        fatal(conn, "bad_message", "JSON 파싱 실패", true);
        return;
      }

      // ── 1단계 파싱: 봉투. 여기서 실패하는 프레임만이 error 자격이 있다. ──
      const env = zEnvelope.safeParse(parsed);
      if (!env.success) {
        fatal(conn, "bad_message", "알 수 없는 메시지 형식", true);
        return;
      }

      if (env.data.t === "hello") {
        if (conn.session || conn.helloPending) {
          // 연결당 정확히 한 번. 두 번째 hello 는 계약 위반이다.
          fatal(conn, "bad_message", "hello 는 연결당 한 번만 보냅니다.", false);
          return;
        }
        const hello = env.data;
        /* ★ 계정이 붙으면서 이 갈래가 비동기가 됐다 (scrypt 는 이벤트 루프를
           막으면 안 된다 — 동기로 여덟 번이면 705ms 다). 그동안 conn.session
           은 여전히 null 이므로 helloPending 이 그 창을 든다. */
        conn.helloPending = true;
        void (async () => {
          const auth = hello.auth
            ? await resolveAuth(
                ctx.q,
                tx,
                hello.auth,
                hello.token,
                ctx.clock(),
                {
                  badName: lines.authBadName,
                  badPassword: lines.authBadPassword,
                  taken: lines.authTaken,
                  refused: lines.authRefused,
                },
              )
            : null;
          if (conn.dead) return;
          if (auth && !auth.ok) {
            conn.helloPending = false;
            /* reconnect:false — 자격이 틀린 채로 재접속하면 같은 실패를
               무한히 반복한다. 사람이 고쳐서 다시 눌러야 한다. */
            fatal(conn, "auth_failed", auth.message, false);
            return;
          }
          const out = handleHello(
            ctx,
            socket,
            hello,
            () => mayCreateCharacter(ip),
            auth?.ok ? auth.resolved : undefined,
          );
          conn.helloPending = false;
          if ("error" in out) {
            if (out.error === "flooding") {
              // 거절 모양이 token:null 경로와 '동일' 해야 한다 — 다르면
              // "그 토큰이 존재하는가" 를 묻는 오라클이 된다.
              fatal(conn, "flooding", "새 캐릭터를 너무 자주 만들고 있습니다.", false);
            } else {
              fatal(conn, "protocol_version", "클라이언트가 낡았습니다. 새로고침하세요.", false);
            }
            return;
          }
          conn.session = out.session;
          conn.epoch = out.session.connId;
          sendConnectBurst(ctx, out.session, out.token, out.displaced, out.revived);
          // 도착 방출은 '신규' 일 때만. 입양이면 아무도 그가 떠났다는 말을
          // 들은 적이 없으므로 돌아왔다는 말도 필요 없다.
          if (!out.adopted) ctx.presence.announceArrival(out.session);
        })().catch((err: unknown) => {
          conn.helloPending = false;
          console.error("[net] hello", err);
          if (!conn.dead) fatal(conn, "internal", "접속 처리에 실패했습니다.", true);
        });
        return;
      }

      // 계정 검증을 기다리는 동안 온 프레임. 조용히 버린다 (위 주석 참조).
      if (conn.helloPending) return;

      if (!conn.session) {
        // hello 전에 온 action/pong. 액션이면 seq 가 있으므로 ack 로 답하는 것이
        // 원칙이지만, 세션이 없으면 보낼 대상 Session 이 없다. 연결을 끊는 쪽이
        // 정직하고, 클라이언트는 재접속하면 된다 (pending 은 연결과 함께 사라진다).
        fatal(conn, "bad_message", "hello 를 먼저 보내야 합니다.", true);
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
        fatal(conn, "bad_seq", "seq 가 역행했습니다.", true);
        return;
      }
      conn.session.lastSeq = env.data.seq;

      // ── 2단계 파싱은 handleAction 안에서. 여기부터는 전부 ack 로 답한다. ──
      handleAction(ctx, conn.session, env.data.seq, env.data.action as { type: string });
    });

    socket.on("close", () => {
      // 소켓 카운터의 감소는 위에서 이미 등록했다 (거절된 연결도 반드시 돌려준다).
      if (conn.session) handleClose(ctx, conn.session, conn.epoch);
    });

    socket.on("error", () => {
      /* close 가 뒤따른다 */
    });
  });

  /* 하트비트. 노트북 덮개를 닫은 소켓은 close 를 발화하지 않아,
     이게 없으면 상대 미니맵에 유령 점이 영원히 남는다. */
  const beat = setInterval(() => {
    // 창이 지난 IP 항목을 청소한다 (무한 성장 방지).
    const cutoff = ctx.clock() - NEW_CHAR_WINDOW_MS;
    for (const [ip, hits] of newCharsPerIp) {
      const live = hits.filter((t) => t >= cutoff);
      if (live.length) newCharsPerIp.set(ip, live);
      else newCharsPerIp.delete(ip);
    }
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
  return {
    wss,
    /** ws 와 http 를 함께 닫는다. wss.close() 는 붙어 있는 http 서버를
     *  닫지 않는다 — noServer 모드에서는 우리가 소유자다. */
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

export type { Ctx, Registry, Emit, Presence };
