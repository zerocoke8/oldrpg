import React, { useState, useEffect, useRef, useCallback } from "react";

/* ------------------------------------------------------------------
   던전 구조 — 엔진이 소유하는 "진실". LLM은 여기에 손대지 않는다.
   # 벽 / . 통로 / S 시작 / T 보물 / E 적
------------------------------------------------------------------ */
const MAP = [
  "#######",
  "#..T..#",
  "#.###.#",
  "#..S..#",
  "#.###.#",
  "#..E..#",
  "#######",
];

const W = 7;
const H = 7;

/* 각 칸의 "씨앗". 엔진이 정하고, LLM은 이걸 문장으로 부풀린다. */
const SEEDS = {
  "1,1": "무너진 서고의 서쪽 끝. 쓰러진 책장이 길을 반쯤 막고 있다",
  "2,1": "곰팡이 핀 책 더미 사이의 좁은 통로",
  "3,1": "낮은 제단 위에 낡은 상자가 놓여 있다",
  "4,1": "벽에 그을린 손자국이 줄지어 나 있다",
  "5,1": "갈라진 동쪽 벽에서 찬 바람이 새어든다",
  "1,2": "이끼로 미끄러운 계단참",
  "5,2": "녹슨 쇠창살이 반쯤 열린 채 굳어 있다",
  "1,3": "물이 발목까지 고인 서쪽 회랑",
  "2,3": "천장에서 물방울이 규칙적으로 떨어진다",
  "3,3": "네 방향으로 통로가 뻗은 석조 교차로",
  "4,3": "부서진 갑옷 조각이 바닥에 흩어져 있다",
  "5,3": "동쪽 벽에 알아볼 수 없는 문자가 새겨져 있다",
  "1,4": "좁고 가파른 내리막",
  "5,4": "벽 틈에서 희미한 붉은 빛이 스며나온다",
  "1,5": "천장이 낮아 몸을 숙여야 하는 굴",
  "2,5": "바닥에 마른 핏자국이 길게 이어진다",
  "3,5": "기둥이 늘어선 넓은 홀. 어둠 속에서 무언가 움직인다",
  "4,5": "부서진 기둥들이 늘어선 폐허",
  "5,5": "막다른 곳. 벽에 봉인된 문이 있다",
};

/* 이벤트에 반응하는 방과, 반응할 플래그를 명시적으로 선언한다.
   이걸 좁혀두지 않으면 방 하나가 가질 수 있는 상태가 지수적으로 늘어난다. */
const SENSITIVE = {
  "1,4": ["guardianSlain"],
  "5,4": ["guardianSlain"],
  "1,5": ["guardianSlain"],
  "2,5": ["guardianSlain"],
  "3,5": ["guardianSlain"],
  "4,5": ["guardianSlain"],
  "5,5": ["guardianSlain"],
};

/* 플래그가 켜졌을 때 LLM에게 넘길 톤 지시. 씨앗은 절대 안 바뀐다. */
const FLAG_MOOD = {
  guardianSlain:
    "이 구역을 지키던 그림자 파수꾼은 방금 쓰러졌다. 위협이 사라진 직후의 " +
    "느슨한 정적을 담아라. 공기가 가벼워지고, 어둠이 덜 적대적으로 느껴진다.",
};

/* 그 방이 신경 쓰는 플래그만 해시한다. 이게 캐시 키가 된다. */
const stateHash = (k, flags) =>
  (SENSITIVE[k] || []).map((f) => (flags[f] ? "1" : "0")).join("") || "0";
const cacheKey = (k, flags) => `${k}#${stateHash(k, flags)}`;
const moodFor = (k, flags) =>
  (SENSITIVE[k] || [])
    .filter((f) => flags[f])
    .map((f) => FLAG_MOOD[f])
    .join(" ");

const C = {
  ink: "#0b1020",
  win: "#16204a",
  winHi: "#26346f",
  line: "#e6e9f5",
  text: "#eef1fa",
  dim: "#8f9ec4",
  gold: "#e3b23c",
  red: "#c2483f",
  green: "#5fa85f",
};

const FONT =
  "'Pretendard', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif";

const tileAt = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return "#";
  return MAP[y][x];
};
const walkable = (x, y) => tileAt(x, y) !== "#";
const key = (x, y) => `${x},${y}`;
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

/* ------------------------------------------------------------------
   LLM 서술 레이어. 엔진이 확정한 결과만 문장으로 옮긴다.
   실제 서비스에서는 이 함수가 서버에 있어야 하고,
   결과는 좌표 단위로 DB에 영구 저장된다.
------------------------------------------------------------------ */
async function narrateRoom(seed, mood) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content:
            "당신은 텍스트 머드 게임의 서술자입니다. 아래 씨앗을 한국어 2~3문장으로 확장해 " +
            "방 묘사를 쓰세요. 2인칭 현재형. 어둡고 축축한 지하 던전 톤.\n\n" +
            "규칙: 새로운 출구·아이템·적·NPC를 만들어내지 마세요. 분위기와 감각만 묘사합니다. " +
            "따옴표나 머리말 없이 묘사문만 출력하세요.\n\n씨앗: " +
            seed +
            (mood ? "\n\n현재 월드 상태: " + mood : ""),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error("api");
  const data = await res.json();
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/* ------------------------------------------------------------------ */

export default function MudPrototype() {
  const [pos, setPos] = useState({ x: 3, y: 3 });
  const [rooms, setRooms] = useState({}); // 좌표 -> 확정된 묘사 (캐시)
  const [seen, setSeen] = useState({ "3,3": true });
  const [log, setLog] = useState([
    { k: "sys", t: "화살표로 이동, Enter로 메뉴, Esc로 취소." },
  ]);
  const [mode, setMode] = useState("explore"); // explore | menu | combat | item
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [calls, setCalls] = useState(0);

  const [hp, setHp] = useState(40);
  const [items, setItems] = useState([{ name: "치유의 물약", n: 2 }]);
  const [enemy, setEnemy] = useState(null);
  const [cleared, setCleared] = useState({});
  const [flags, setFlags] = useState({ guardianSlain: false });
  const [regen, setRegen] = useState(null); // {done, total}

  const logRef = useRef(null);
  const MAXHP = 40;

  const push = useCallback((t, k = "narr") => {
    setLog((L) => [...L, { k, t }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log, busy]);

  /* 방 진입: 캐시에 있으면 즉시, 없으면 1회 생성 후 고정 */
  const enterRoom = useCallback(
    async (x, y) => {
      const k = key(x, y);
      const ck = cacheKey(k, flags);
      if (rooms[ck]) {
        push(rooms[ck], "cached");
        return;
      }
      setBusy(true);
      const seed = SEEDS[k] || "특징 없는 돌 통로";
      let text;
      try {
        text = await narrateRoom(seed, moodFor(k, flags));
        setCalls((c) => c + 1);
      } catch {
        text = seed + ". 발소리가 축축한 벽에 둔하게 부딪힌다.";
      }
      setRooms((R) => ({ ...R, [ck]: text }));
      setBusy(false);
      push(text, "fresh");
    },
    [rooms, flags, push]
  );

  /* 이벤트 발생 → 영향받는 방만 백그라운드로 다시 렌더링.
     플레이어를 여기서 기다리게 하지 않는 것이 핵심이다. */
  const rerenderRegion = useCallback(
    async (nextFlags, changedFlag) => {
      const targets = Object.keys(SENSITIVE).filter((k) =>
        SENSITIVE[k].includes(changedFlag)
      );
      const todo = targets.filter((k) => !rooms[cacheKey(k, nextFlags)]);
      if (!todo.length) return;
      setRegen({ done: 0, total: todo.length });
      for (let i = 0; i < todo.length; i++) {
        const k = todo[i];
        const seed = SEEDS[k] || "특징 없는 돌 통로";
        let text;
        try {
          text = await narrateRoom(seed, moodFor(k, nextFlags));
          setCalls((c) => c + 1);
        } catch {
          text = seed + ". 이제는 조용하다.";
        }
        setRooms((R) => ({ ...R, [cacheKey(k, nextFlags)]: text }));
        setRegen({ done: i + 1, total: todo.length });
      }
      setRegen(null);
      push("주변의 공기가 달라졌다. 지나온 길이 예전 같지 않을 것이다.", "good");
    },
    [rooms, push]
  );

  const move = useCallback(
    (dx, dy) => {
      if (busy || mode !== "explore") return;
      const nx = pos.x + dx;
      const ny = pos.y + dy;
      if (!walkable(nx, ny)) {
        push("단단한 벽이 앞을 막는다.", "sys");
        return;
      }
      setPos({ x: nx, y: ny });
      setSeen((S) => ({ ...S, [key(nx, ny)]: true }));

      const t = tileAt(nx, ny);
      const k = key(nx, ny);

      if (t === "E" && !cleared[k]) {
        setEnemy({ name: "그림자 파수꾼", hp: 30, max: 30 });
        setMode("combat");
        setCursor(0);
        push("그림자 파수꾼이 기둥 뒤에서 걸어 나온다!", "bad");
        return;
      }
      if (t === "T" && !cleared[k]) {
        setCleared((c) => ({ ...c, [k]: true }));
        setItems((I) =>
          I.map((it) =>
            it.name === "치유의 물약" ? { ...it, n: it.n + 2 } : it
          )
        );
        push("상자를 열었다. 치유의 물약 2개를 얻었다.", "good");
      }
      enterRoom(nx, ny);
    },
    [pos, busy, mode, cleared, enterRoom, push]
  );

  /* 전투 — 판정은 전부 여기서. LLM은 결과를 받아 문장만 쓴다. */
  const enemyTurn = useCallback(
    (guard) => {
      setEnemy((E) => {
        if (!E || E.hp <= 0) return E;
        let dmg = rnd(4, 9);
        if (guard) dmg = Math.floor(dmg / 2);
        setHp((h) => {
          const nh = Math.max(0, h - dmg);
          push(
            `그림자 파수꾼의 일격. ${dmg}의 피해를 입었다.` +
              (guard ? " (방어로 절반 감소)" : ""),
            "bad"
          );
          if (nh === 0) push("시야가 어두워진다... 당신은 쓰러졌다.", "bad");
          return nh;
        });
        return E;
      });
    },
    [push]
  );

  const combatAct = useCallback(
    (idx) => {
      if (!enemy) return;
      if (idx === 0) {
        const dmg = rnd(6, 12);
        const left = Math.max(0, enemy.hp - dmg);
        push(`검을 내리쳤다. ${dmg}의 피해를 주었다.`, "good");
        if (left === 0) {
          setEnemy(null);
          setMode("explore");
          setCleared((c) => ({ ...c, [key(pos.x, pos.y)]: true }));
          // 즉시 보여줄 문장은 미리 써둔 것. LLM을 기다리지 않는다.
          push("그림자 파수꾼이 연기처럼 흩어진다. 공기가 가벼워진다.", "good");
          const next = { ...flags, guardianSlain: true };
          setFlags(next);
          rerenderRegion(next, "guardianSlain");
          return;
        }
        setEnemy({ ...enemy, hp: left });
        setTimeout(() => enemyTurn(false), 350);
      } else if (idx === 1) {
        push("자세를 낮추고 방패를 들었다.", "sys");
        setTimeout(() => enemyTurn(true), 350);
      } else if (idx === 2) {
        setMode("item");
        setCursor(0);
      } else {
        if (Math.random() < 0.5) {
          setEnemy(null);
          setMode("explore");
          push("등을 돌려 어둠 속으로 물러났다.", "sys");
        } else {
          push("퇴로가 막혔다!", "bad");
          setTimeout(() => enemyTurn(false), 350);
        }
      }
    },
    [enemy, pos, push, enemyTurn, flags, rerenderRegion]
  );

  const useItem = useCallback(() => {
    const pot = items.find((i) => i.name === "치유의 물약");
    if (!pot || pot.n <= 0) {
      push("물약이 없다.", "sys");
      return;
    }
    const heal = Math.min(18, MAXHP - hp);
    setHp((h) => Math.min(MAXHP, h + 18));
    setItems((I) =>
      I.map((i) => (i.name === "치유의 물약" ? { ...i, n: i.n - 1 } : i))
    );
    push(`물약을 마셨다. 체력이 ${heal} 회복되었다.`, "good");
    if (enemy) {
      setMode("combat");
      setCursor(0);
      setTimeout(() => enemyTurn(false), 350);
    } else {
      setMode("explore");
    }
  }, [items, hp, enemy, push, enemyTurn]);

  const exploreMenu = ["살펴보기", "아이템", "휴식", "닫기"];
  const combatMenu = ["공격", "방어", "아이템", "도망"];
  const currentMenu =
    mode === "combat" ? combatMenu : mode === "menu" ? exploreMenu : null;

  const confirm = useCallback(() => {
    if (busy || hp <= 0) return;
    if (mode === "explore") {
      setMode("menu");
      setCursor(0);
      return;
    }
    if (mode === "combat") {
      combatAct(cursor);
      return;
    }
    if (mode === "item") {
      useItem();
      return;
    }
    if (mode === "menu") {
      if (cursor === 0) {
        const k = cacheKey(key(pos.x, pos.y), flags);
        push(rooms[k] || "아직 눈이 어둠에 익지 않았다.", "cached");
        setMode("explore");
      } else if (cursor === 1) {
        setMode("item");
        setCursor(0);
      } else if (cursor === 2) {
        setHp((h) => Math.min(MAXHP, h + 6));
        push("잠시 벽에 기대어 숨을 골랐다. 체력이 조금 회복된다.", "good");
        setMode("explore");
      } else {
        setMode("explore");
      }
    }
  }, [mode, cursor, busy, hp, combatAct, useItem, pos, rooms, flags, push]);

  const cancel = useCallback(() => {
    if (mode === "item") {
      setMode(enemy ? "combat" : "menu");
      setCursor(0);
    } else if (mode === "menu") {
      setMode("explore");
    }
  }, [mode, enemy]);

  /* 입력 → 액션. 키보드든 화면 버튼이든 여기로 수렴한다. */
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key;
      if (
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", " "].includes(k)
      )
        e.preventDefault();
      if (hp <= 0) return;

      if (mode === "explore") {
        if (k === "ArrowUp") move(0, -1);
        else if (k === "ArrowDown") move(0, 1);
        else if (k === "ArrowLeft") move(-1, 0);
        else if (k === "ArrowRight") move(1, 0);
        else if (k === "Enter" || k === " ") confirm();
      } else {
        const len = mode === "item" ? Math.max(1, items.length) : currentMenu.length;
        if (k === "ArrowUp") setCursor((c) => (c - 1 + len) % len);
        else if (k === "ArrowDown") setCursor((c) => (c + 1) % len);
        else if (k === "Enter" || k === " ") confirm();
        else if (k === "Escape") cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, move, confirm, cancel, currentMenu, items, hp]);

  /* ---------------- 렌더 ---------------- */

  const win = {
    background: C.win,
    border: `2px solid ${C.line}`,
    boxShadow: `inset 0 0 0 2px ${C.win}, inset 0 0 0 3px rgba(230,233,245,.35)`,
    padding: "10px 12px",
  };

  const cellColor = (x, y) => {
    const k = key(x, y);
    if (x === pos.x && y === pos.y) return C.gold;
    if (!seen[k]) return "transparent";
    if (!walkable(x, y)) return "#2b3563";
    if (tileAt(x, y) === "E" && !cleared[k]) return C.red;
    if (tileAt(x, y) === "T" && !cleared[k]) return "#4a7fb5";
    return "#5b6bab";
  };

  const logColor = { sys: C.dim, good: C.green, bad: C.red, fresh: C.text, cached: C.text };

  const Dpad = () => {
    const btn = (label, onClick, style) => (
      <button
        onClick={onClick}
        style={{
          background: C.winHi,
          border: `2px solid ${C.line}`,
          color: C.text,
          fontSize: 18,
          fontFamily: FONT,
          cursor: "pointer",
          ...style,
        }}
      >
        {label}
      </button>
    );
    return (
      <div style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "40px 40px 40px",
            gridTemplateRows: "40px 40px 40px",
            gap: 3,
          }}
        >
          <div />
          {btn("↑", () => move(0, -1))}
          <div />
          {btn("←", () => move(-1, 0))}
          <div style={{ background: "transparent" }} />
          {btn("→", () => move(1, 0))}
          <div />
          {btn("↓", () => move(0, 1))}
          <div />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {btn("메뉴", confirm, { padding: "10px 18px", fontSize: 14 })}
          {btn("취소", cancel, { padding: "10px 18px", fontSize: 14, opacity: 0.6 })}
        </div>
      </div>
    );
  };

  const MenuWin = () => {
    const list =
      mode === "item"
        ? items.length
          ? items.map((i) => `${i.name}  ×${i.n}`)
          : ["(비어 있음)"]
        : currentMenu;
    return (
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{ ...win, flex: 1 }}>
          {list.map((label, i) => (
            <div
              key={i}
              onClick={() => {
                setCursor(i);
                setTimeout(confirm, 0);
              }}
              style={{
                display: "flex",
                gap: 8,
                padding: "6px 4px",
                cursor: "pointer",
                color: cursor === i ? C.gold : C.text,
                fontSize: 15,
              }}
            >
              <span style={{ width: 14 }}>{cursor === i ? "▶" : ""}</span>
              {label}
            </div>
          ))}
        </div>
        <button
          onClick={cancel}
          style={{
            background: C.winHi,
            border: `2px solid ${C.line}`,
            color: C.text,
            padding: "10px 14px",
            fontFamily: FONT,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Esc
        </button>
      </div>
    );
  };

  return (
    <div
      style={{
        background: C.ink,
        color: C.text,
        fontFamily: FONT,
        minHeight: "100vh",
        padding: 14,
        maxWidth: 560,
        margin: "0 auto",
      }}
    >
      {/* 상단: 미니맵 + 상태 */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <div style={{ ...win, padding: 8 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${W}, 13px)`,
              gap: 2,
            }}
          >
            {Array.from({ length: H }).map((_, y) =>
              Array.from({ length: W }).map((_, x) => (
                <div
                  key={`${x}-${y}`}
                  style={{
                    width: 13,
                    height: 13,
                    background: cellColor(x, y),
                    borderRadius: 1,
                  }}
                />
              ))
            )}
          </div>
        </div>

        <div style={{ ...win, flex: 1 }}>
          <div style={{ fontSize: 13, color: C.dim, marginBottom: 6 }}>
            지하 1층 · {pos.x},{pos.y}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: C.dim, width: 24 }}>HP</span>
            <div style={{ flex: 1, height: 10, background: "#0a0f2a", border: `1px solid ${C.dim}` }}>
              <div
                style={{
                  width: `${(hp / MAXHP) * 100}%`,
                  height: "100%",
                  background: hp / MAXHP > 0.3 ? C.green : C.red,
                  transition: "width .25s",
                }}
              />
            </div>
            <span style={{ fontSize: 13, width: 46, textAlign: "right" }}>
              {hp}/{MAXHP}
            </span>
          </div>
          {enemy && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              <span style={{ fontSize: 13, color: C.red, width: 24 }}>敵</span>
              <div style={{ flex: 1, height: 10, background: "#0a0f2a", border: `1px solid ${C.dim}` }}>
                <div
                  style={{
                    width: `${(enemy.hp / enemy.max) * 100}%`,
                    height: "100%",
                    background: C.red,
                    transition: "width .25s",
                  }}
                />
              </div>
              <span style={{ fontSize: 13, width: 46, textAlign: "right" }}>
                {enemy.hp}/{enemy.max}
              </span>
            </div>
          )}
          <div style={{ fontSize: 11, color: C.dim, marginTop: 8 }}>
            LLM 호출 {calls}회 · 캐시 {Object.keys(rooms).length}건
            {flags.guardianSlain && " · 파수꾼 처치됨"}
          </div>
          {regen && (
            <div style={{ fontSize: 11, color: C.gold, marginTop: 4 }}>
              배경에서 주변 지역 갱신 중 {regen.done}/{regen.total}
            </div>
          )}
        </div>
      </div>

      {/* 서술 로그 */}
      <div
        ref={logRef}
        style={{
          ...win,
          height: 250,
          overflowY: "auto",
          marginBottom: 12,
          lineHeight: 1.75,
          fontSize: 15,
        }}
      >
        {log.map((l, i) => (
          <p key={i} style={{ margin: "0 0 10px", color: logColor[l.k] }}>
            {l.k === "fresh" && (
              <span style={{ color: C.gold, fontSize: 11, marginRight: 6 }}>새로 생성됨</span>
            )}
            {l.t}
          </p>
        ))}
        {busy && <p style={{ color: C.gold, margin: 0 }}>어둠에 눈이 익어간다…</p>}
      </div>

      {/* 조작부 */}
      {hp <= 0 ? (
        <div style={{ ...win, textAlign: "center", color: C.red }}>
          당신은 쓰러졌다.
        </div>
      ) : mode === "explore" ? (
        <Dpad />
      ) : (
        <MenuWin />
      )}
    </div>
  );
}
