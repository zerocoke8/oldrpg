/* 앱 조립. 모든 입력이 하나의 act(Action) 로 수렴하는 것이 여기서 보인다. */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Action } from "../shared/protocol";
import { actionForKey, HANDLED_KEYS } from "./input/keyboard";
import { connect, type Socket } from "./net/socket";
import { Reconciler } from "./net/reconcile";
import { initialState, reduce } from "./state/store";
import { Dpad } from "./ui/Dpad";
import { Log } from "./ui/Log";
import { Minimap } from "./ui/Minimap";
import { Status } from "./ui/Status";
import { C, FONT, win } from "./theme";

export default function App() {
  const [st, dispatch] = useReducer(reduce, undefined, initialState);
  const recon = useRef(new Reconciler()).current;
  // Reconciler 는 React 상태 밖에 산다(핫패스). 렌더를 깨우기 위한 tick.
  const [, bump] = useState(0);
  const sock = useRef<Socket | null>(null);

  useEffect(() => {
    const s = connect({
      onOpen: () => recon.onReconnect(),
      onMessage: (m) => {
        // 위치는 Reconciler 가, 나머지는 store 가 소유한다.
        if (m.t === "ack") recon.onAck(m);
        if (m.t === "snapshot") recon.onSnapshot(m);
        dispatch(m);
        if (m.t === "ack" || m.t === "snapshot") bump((n) => n + 1);
      },
      onClose: () => bump((n) => n + 1),
    });
    sock.current = s;
    return () => s.close();
  }, [recon]);

  /** ★ 키보드 · D패드 · (5단계의) 자유 텍스트가 전부 여기로 수렴한다.
   *  서버로 가기 전의 마지막 공통 지점이고, 여기 아래로는 입력 방식이라는
   *  개념이 존재하지 않는다. */
  const act = useCallback(
    (a: Action) => {
      const seq = recon.next();
      if (a.type === "move") {
        // 낙관적 예측. 서버가 거절하면 ack.pos 가 확정 위치를 되돌려주고,
        // view() 가 순수 함수라 롤백 코드 없이 화면이 맞춰진다.
        recon.predictMove(seq, a.dir, st.limits?.maxPending ?? 8);
        bump((n) => n + 1);
      }
      sock.current?.send({ t: "action", seq, action: a });
    },
    [recon, st.limits],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!HANDLED_KEYS.includes(e.key)) return;
      e.preventDefault();
      const a = actionForKey(e.key);
      if (a) act(a);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  /* ★ 메모이즈하지 않는다. reduce() 는 ack 에 대해 '같은 상태 객체' 를 돌려주므로
     (위치는 Reconciler 가 소유한다는 결정 때문에) st 를 의존성으로 둔 useMemo 는
     ack 이 도착해도 무효화되지 않는다. 그러면 낙관적 예측도, 거절 후 보정도
     뒤이어 오는 다른 메시지가 st 를 바꿔줄 때까지 화면에 반영되지 않는다.
     recon.view() 는 pending(최대 8) 을 접는 것이라 매 렌더 호출해도 공짜다. */
  const at = recon.view();
  const others = useMemo(() => [...st.others.values()], [st.others]);

  const shell: React.CSSProperties = {
    background: C.ink,
    color: C.text,
    fontFamily: FONT,
    minHeight: "100vh",
    padding: 14,
    maxWidth: 560,
    margin: "0 auto",
  };

  if (!st.self || !st.region) {
    return (
      <div style={shell}>
        <div style={{ ...win, color: C.dim }}>
          {st.notice ?? "어둠에 눈이 익어간다…"}
        </div>
      </div>
    );
  }

  return (
    <div style={shell}>
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <Minimap region={st.region} self={st.self} at={at} others={others} />
        <Status
          self={st.self}
          region={st.region}
          room={st.room}
          at={at}
          connected={st.status === "live"}
        />
      </div>

      <Log lines={st.log} />

      {/* error{} 는 계약 위반이므로 서사 로그가 아니라 여기에 뜬다. */}
      {st.notice && (
        <div style={{ ...win, color: C.red, marginBottom: 12, fontSize: 13 }}>{st.notice}</div>
      )}

      <Dpad act={act} />
    </div>
  );
}
