/* 소켓 수명주기와 토큰 슬롯.
 *
 * ★ 토큰 슬롯이 인수 테스트를 각주 없이 성립시킨다:
 *   localStorage["mud.token." + (?as ?? "a")] 이므로
 *   ?as=a 탭과 ?as=b 탭이 곧 서로 다른 두 캐릭터다.
 *   같은 브라우저의 탭 두 개로 멀티플레이가 확인된다.
 *
 * ★ 재접속 루프는 error.reconnect 만 읽는다. code 로 switch 하지 않으므로
 *   서버가 새 ErrorCode 를 추가해도 이 파일은 그대로다. */

import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from "../../shared/protocol";

const slot = (): string => new URLSearchParams(location.search).get("as") ?? "a";
const tokenKey = (): string => `mud.token.${slot()}`;

export const loadToken = (): string | null => {
  try {
    return localStorage.getItem(tokenKey());
  } catch {
    return null; // 프라이빗 모드 등. 토큰 없이 새 캐릭터가 된다.
  }
};
const saveToken = (t: string): void => {
  try {
    localStorage.setItem(tokenKey(), t);
  } catch {
    /* 저장 못 해도 이 세션 동안은 논다 */
  }
};

const WS_URL =
  (import.meta.env?.VITE_MUD_WS as string | undefined) ??
  `ws://${location.hostname}:8787`;

export interface Socket {
  send(msg: ClientMsg): void;
  close(): void;
}

export function connect(handlers: {
  onMessage(m: ServerMsg): void;
  onOpen(): void;
  onClose(willRetry: boolean): void;
}): Socket {
  let ws: WebSocket | null = null;
  let retry = 0;
  let closedByUs = false;
  /** error{reconnect:false} 를 받았으면 재접속하지 않는다.
   *  replaced 에 재접속하면 같은 탭 두 개가 무한 강퇴 핑퐁을 한다. */
  let allowRetry = true;

  const open = (): void => {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      retry = 0;
      handlers.onOpen();
      ws?.send(
        JSON.stringify({
          t: "hello",
          pv: PROTOCOL_VERSION,
          token: loadToken(),
          name: null,
        } satisfies ClientMsg),
      );
    };

    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return; // 서버가 보낸 쓰레기 — 무시한다. 우리가 끊을 일이 아니다.
      }
      if (m.t === "welcome") saveToken(m.token);
      if (m.t === "ping") {
        ws?.send(JSON.stringify({ t: "pong", nonce: m.nonce } satisfies ClientMsg));
        return;
      }
      if (m.t === "error") allowRetry = m.reconnect;
      handlers.onMessage(m);
    };

    ws.onclose = () => {
      const willRetry = allowRetry && !closedByUs;
      handlers.onClose(willRetry);
      if (!willRetry) return;
      retry += 1;
      const delay = Math.min(8000, 250 * 2 ** (retry - 1));
      setTimeout(open, delay);
    };

    ws.onerror = () => {
      /* onclose 가 뒤따른다 */
    };
  };

  open();

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closedByUs = true;
      ws?.close();
    },
  };
}
