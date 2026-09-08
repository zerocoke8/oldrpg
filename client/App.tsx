/* 앱 조립. 모든 입력이 하나의 act(Action) 로 수렴하는 것이 여기서 보인다.
 *
 * 5단계의 화면은 역할이 셋으로 갈린다:
 *   로그      = 세계의 문장 (log 만이 문장을 나른다 — 프로토콜 불변식 1)
 *   상태창    = 구조화된 지금 (좌표·HP·적)
 *   커맨드 창 = 할 수 있는 일 '전부'
 *
 * 그리고 입력 어댑터가 다섯이다 — 키보드, D패드, 자유 텍스트, 커맨드 창,
 * 스와이프. 다섯 모두 act(Action) 하나로 들어오고, 그 아래로는 '입력 방식'
 * 이라는 개념이 존재하지 않는다 (charter 79-80줄). 5단계에 서버는 한 줄도
 * 바뀌지 않았다 — 그것이 이 구조가 실제로 값을 했다는 증거다. */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Action } from "../shared/protocol";
import { HANDLED_KEYS, intentForKey, type Mode } from "./input/keyboard";
import { moveCursor, resolve, rootItems } from "./input/menu";
import { parse } from "./input/parse";
import { makeSwipe } from "./input/touch";
import { connect, type Socket } from "./net/socket";
import { Reconciler } from "./net/reconcile";
import { initialState, reduce } from "./state/store";
import { Combat } from "./ui/Combat";
import { CommandWindow } from "./ui/CommandWindow";
import { Dpad } from "./ui/Dpad";
import { Log } from "./ui/Log";
import { Minimap } from "./ui/Minimap";
import { Status } from "./ui/Status";
import { TextInput } from "./ui/TextInput";
import {
  C, FONT, applyPalette, loadPalette, savePalette, win, type PaletteId,
} from "./theme";
import { Settings } from "./ui/Settings";
import { AUTO_SKILL_MS, loadAutoSkill, nextAutoSkill, saveAutoSkill } from "./state/prefs";

export default function App() {
  const [st, dispatch] = useReducer(reduce, undefined, initialState);
  const recon = useRef(new Reconciler()).current;
  // Reconciler 는 React 상태 밖에 산다(핫패스). 렌더를 깨우기 위한 tick.
  const [, bump] = useState(0);
  const sock = useRef<Socket | null>(null);

  /* 커맨드 창의 상태. 서버는 이걸 전혀 모른다 — 순수한 화면 상태다. */
  const [mode, setMode] = useState<Mode>("field");
  /** 설정 창이 열려 있는가. 메뉴에서 켜고 창이 스스로 끈다. */
  const [showSettings, setShowSettings] = useState(false);
  /* 색과 자동전투는 **이 브라우저의 것**이다. 서버로 보내지 않는다 —
     색이 서버로 가면 지역화와 레이아웃이 서버에 묶인다(불변식 1 의 주석이
     HUD 크롬을 클라이언트에 둔 이유로 정확히 그것을 적었다). */
  const [palette, setPalette] = useState<PaletteId>(loadPalette);
  const [autoSkill, setAutoSkill] = useState(loadAutoSkill);
  const [path, setPath] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [cmd, setCmd] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
      onClose: (willRetry) =>
        // 이걸 버리면 화면은 계속 "연결됨" 이라고 말하면서 플레이어는
        // 아무에게도 보이지 않는 유령 점을 걷게 된다.
        dispatch({
          t: "__conn",
          status: willRetry ? "connecting" : "closed",
          notice: willRetry ? "연결이 끊겼다. 다시 잇는 중…" : "연결이 끊겼다.",
        }),
    });
    sock.current = s;
    return () => s.close();
  }, [recon]);

  /** ★ 다섯 어댑터가 전부 여기로 수렴한다. 서버로 가기 전의 마지막 공통
   *  지점이고, 여기 아래로는 입력 방식이라는 개념이 존재하지 않는다. */
  const act = useCallback(
    (a: Action) => {
      const seq = recon.next();
      const sent = sock.current?.send({ t: "action", seq, action: a }) ?? false;
      // ★ 나가지 않은 프레임은 예측하지 않는다. 소켓이 끊긴 동안 방향키를
      //   누르면 서버가 영영 볼 수 없는 이동이 pending 에 쌓여, 재접속 전까지
      //   화면의 나만 엉뚱한 칸을 걷는다. (seq 에 구멍이 나는 것은 무해하다 —
      //   서버는 '엄격 증가' 만 요구한다.)
      if (!sent) return;
      if (a.type === "move") {
        // 낙관적 예측. 서버가 거절하면 ack.pos 가 확정 위치를 되돌려주고,
        // view() 가 순수 함수라 롤백 코드 없이 화면이 맞춰진다.
        recon.predictMove(seq, a.dir, st.limits?.maxPending ?? 8);
        bump((n) => n + 1);
      }
    },
    [recon, st.limits],
  );

  /* ── 커맨드 창 ──────────────────────────────────────────────────────
     메뉴는 저장하지 않고 매 렌더 상태에서 다시 세운다. 적이 죽거나 NPC 의
     방을 벗어나면 그 가지가 저절로 사라지고, 서 있던 경로는 최상위로
     되돌아간다 (구조화 사실에서 파생 — 서버가 "닫아라" 를 보내지 않는다). */
  const root = rootItems(st);
  const view = resolve(root, path);
  const menu = view ?? { items: root, trail: [] };
  useEffect(() => {
    if (!resolve(rootItems(st), path)) {
      setPath([]);
      setCursor(0);
    }
  }, [st, path]);
  const cur = Math.min(cursor, Math.max(0, menu.items.length - 1));

  /* ── 자동전투 ────────────────────────────────────────────────────────
     규칙은 한 줄이다: **교전 중이고 예약 자리가 비어 있으면, combat.skills 를
     주어진 순서대로 훑어 쿨다운이 아닌 첫 번째를 예약한다.**

     ★ 판단이 없다. "지금은 치유가 맞다" 를 고르기 시작하면 그건 입력 자동화가
       아니라 클라이언트가 전투를 판정하는 것이고, 규칙 1 이 걸린다. 순서는
       서버가 준 순서 그대로이고 여기서 정렬도 점수도 매기지 않는다.
       (쓰고 나면 그 스킬이 쿨다운으로 빠지므로 다음번엔 자연히 그다음 것이
        나간다 — 순환은 규칙에서 저절로 따라 나오지 별도 상태가 아니다.)

     ★ 사람과 싸우지 않는다. queuedSkill/queuedItem 이 차 있으면 건너뛴다 —
       예약 자리는 하나뿐이고 나중 입력이 이기므로, 안 그러면 사람이 고른 것을
       자동이 덮어쓴다.

     ★ 대상은 언제나 자기 자신이다 (targetId 를 생략한다). 남에게 걸 사람을
       고르는 것이 바로 위에서 배제한 그 판단이다.

     ★ 새 권한이 하나도 없다. 여기서 나가는 것은 사람이 커맨드 창에서 누를 수
       있었던 것과 **글자 그대로 같은 액션**이고, 서버는 소지·쿨다운·대상·
       같은 방인지를 전부 다시 판정한다.

     ★ 상태를 ref 로 읽는 이유: combat 은 0.5초마다 갱신된다. 그것을 의존성에
       넣으면 타이머가 매번 헐리고 새로 서서 영영 안 터진다. */
  const live = useRef(st);
  live.current = st;
  useEffect(() => {
    if (!autoSkill) return;
    const id = setInterval(() => {
      const skillId = nextAutoSkill(live.current.combat);
      if (skillId) act({ type: "skill", skillId });
    }, AUTO_SKILL_MS);
    return () => clearInterval(id);
  }, [autoSkill, act]);

  const activate = useCallback(
    (i: number) => {
      const it = menu.items[i];
      if (!it || it.disabled) return;
      setCursor(i);
      if (it.action) act(it.action);
      if (it.items) {
        setPath((p) => [...p, it.id]);
        setCursor(0);
      } else if (it.panel === "settings") {
        /* 커맨드 창을 닫고 창에 조종을 넘긴다 — 입력창으로 갈 때와 같은
           이유다. 창 위에서 화살표가 여전히 메뉴 커서면 사람은 자기가 어느
           모드에 있는지 알 수 없다. */
        setShowSettings(true);
        setMode("field");
      } else if (it.focus !== undefined) {
        /* 입력창에 조종을 넘기고 메뉴는 닫는다. 커맨드 모드로 남겨 두면
           타이핑을 마치고 입력창을 나왔을 때 화살표가 여전히 커서라서,
           사람은 자기가 어느 모드에 있는지 알 수 없다. */
        setCmd(it.focus);
        setMode("field");
        inputRef.current?.focus();
      }
    },
    [menu, act],
  );

  const back = useCallback(() => {
    setCursor(0);
    if (path.length) setPath((p) => p.slice(0, -1));
    else setMode("field");
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!HANDLED_KEYS.includes(e.key)) return;
      const el = e.target;
      // 타이핑 중에는 아무것도 가로채지 않는다.
      if (el instanceof HTMLElement && el.closest("input, textarea, select")) return;
      // 포커스된 버튼의 Enter/Space 는 브라우저에 맡긴다 — 안 그러면
      // D패드와 커맨드 창을 키보드로 누를 수 없다 (접근성).
      if (
        (e.key === "Enter" || e.key === " ") &&
        el instanceof HTMLElement &&
        el.closest("button, a[href]")
      )
        return;
      const intent = intentForKey(e.key, mode);
      if (!intent) return;
      e.preventDefault();
      if (intent.kind === "action") {
        act(intent.action);
        return;
      }
      switch (intent.op) {
        case "open":
          setMode("menu");
          setPath([]);
          setCursor(0);
          break;
        case "back":
          back();
          break;
        case "up":
          setCursor((c) => moveCursor(menu.items, c, -1));
          break;
        case "down":
          setCursor((c) => moveCursor(menu.items, c, 1));
          break;
        case "enter":
          activate(cur);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, mode, menu, cur, activate, back]);

  /* 스와이프: 로그 창을 쓸면 그 방향으로 한 칸. D패드와 같은 Action 이다. */
  const swipe = useMemo(() => makeSwipe((dir) => act({ type: "move", dir })), [act]);

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
    /* dvh: 모바일 브라우저의 주소창이 접혔다 펴져도 레이아웃이 튀지 않는다.
       ★ min-height 가 아니라 height 다. min 이면 내용이 뷰포트를 넘길 때
         껍데기가 통째로 자라고, 그러면 아래쪽 D패드와 커맨드 창이 화면 밖으로
         밀려 내려간다 — 전투 패널이나 알림이 위에 하나 뜰 때마다 조작부가
         움직인다는 뜻이다. 높이를 뷰포트에 못 박으면 그 차이를 로그가 흡수하고
         (Log 의 flex: 1 1 0px), 조작부는 늘 같은 자리에 있다. */
    height: "100dvh",
    overflow: "hidden",
    maxWidth: 560,
    margin: "0 auto",
    padding: "12px 12px calc(12px + env(safe-area-inset-bottom))",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  };

  const accountPanel = showSettings ? (
    <Settings
      account={st.self?.account ?? null}
      nameMaxLen={st.limits?.accountNameMaxLen ?? 24}
      passwordMinLen={st.limits?.passwordMinLen ?? 8}
      palette={palette}
      onPalette={(p) => {
        setPalette(p);
        applyPalette(p);
        savePalette(p);
      }}
      autoSkill={autoSkill}
      onAutoSkill={(on) => {
        setAutoSkill(on);
        saveAutoSkill(on);
      }}
      onClose={() => setShowSettings(false)}
      onSubmit={(kind, name, password) => {
        setShowSettings(false);
        /* 계정은 hello 의 일부라, '로그인' 은 곧 자격을 들고 다시 붙는 것이다.
           비밀번호는 여기서 소켓으로만 가고 어디에도 저장되지 않는다. */
        sock.current?.authenticate({ kind, name, password });
      }}
    />
  ) : null;

  if (!st.self || !st.region) {
    return (
      <div style={shell}>
        <div style={{ ...win, color: C.dim }}>{st.notice ?? "어둠에 눈이 익어간다…"}</div>
        {accountPanel}
      </div>
    );
  }

  return (
    <div style={shell}>
      <div style={{ display: "flex", gap: 10 }}>
        <Minimap region={st.region} at={at} others={others} act={act} />
        <Status
          self={st.self}
          region={st.region}
          room={st.room}
          at={at}
          connected={st.status === "live"}
          world={[...st.world.values()]}
        />
      </div>

      {st.combat && <Combat combat={st.combat} selfId={st.self.id} />}

      <Log lines={st.log} swipe={swipe} />

      {/* error{} 는 계약 위반이므로 서사 로그가 아니라 여기에 뜬다.
          계정 실패도 이 자리로 온다 — 문장은 전부 서버가 만든 것이다. */}
      {st.notice && <div style={{ ...win, color: C.red, fontSize: 13 }}>{st.notice}</div>}

      {accountPanel}

      {/* ★ 아래를 기준점으로 정렬한다. stretch 였을 때는 커맨드 창의 높이가
          그 줄의 높이를 정하고 D패드는 그 줄의 '위' 에 붙었다 — 전투가 시작돼
          스킬 버튼이 생기면 창이 높아지고 D패드가 통째로 위로 올라갔다
          (실측 99px). 아래로 붙이면 창이 몇 줄이든 D패드의 밑변은 껍데기의
          밑변이라 움직이지 않는다. */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <Dpad act={act} />
        <CommandWindow
          items={menu.items}
          trail={menu.trail.map((t) => t.label)}
          cursor={cur}
          active={mode === "menu"}
          onActivate={activate}
          onHover={setCursor}
          onBack={back}
          onOpen={() => setMode("menu")}
        />
      </div>

      <TextInput
        ref={inputRef}
        value={cmd}
        onValue={setCmd}
        onSubmit={() => {
          const raw = cmd.trim();
          if (!raw) return;
          setCmd("");
          act(parse(raw));
        }}
      />
    </div>
  );
}
