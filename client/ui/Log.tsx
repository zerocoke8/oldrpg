/* 서술 로그. 화면에 문장이 올라오는 유일한 곳이다.
 *
 * ★ 배열 인덱스가 아니라 line.id 를 key 로 쓴다. 그것이 log.replace 의
 *   전제이고, 나중에 바꾸려면 이 컴포넌트를 통째로 갈아야 한다.
 *
 * ★ 실시간 전투는 0.5초마다 줄을 만든다. 18초 전투면 50~70줄이라
 *   방 묘사가 순식간에 위로 사라진다. 그래서 '연속된' kind:"combat" 줄만
 *   한 줄로 접는다 — 누르면 펼쳐진다.
 *
 *   접히는 것은 combat 뿐이다. 스킬·치명타·사망은 서버가 good/bad 로
 *   보내므로 접힌 덩어리를 끊고 밖으로 드러난다. 그게 이 설계의 요점이다:
 *   '무엇을 접을지' 를 클라이언트가 추측하지 않고 서버가 kind 로 말해 준다. */

import { useEffect, useRef, useState } from "react";
import type { LogLine } from "../state/store";
import { C, logColor, win } from "../theme";

/** 연속된 combat 줄을 하나로 묶는다. */
type Row = { kind: "line"; line: LogLine } | { kind: "fold"; id: string; lines: LogLine[] };

function fold(lines: LogLine[]): Row[] {
  const rows: Row[] = [];
  let run: LogLine[] = [];
  const flush = () => {
    if (!run.length) return;
    // 두 줄 이하면 접는 게 오히려 손해다.
    if (run.length <= 2) for (const l of run) rows.push({ kind: "line", line: l });
    else rows.push({ kind: "fold", id: run[0]!.id, lines: run });
    run = [];
  };
  for (const l of lines) {
    if (l.kind === "combat") run.push(l);
    else {
      flush();
      rows.push({ kind: "line", line: l });
    }
  }
  flush();
  return rows;
}

function Line({ l }: { l: LogLine }) {
  return (
    <p style={{ margin: "0 0 10px", color: logColor(l.kind) }}>
      {/* 프로토타입의 "새로 생성됨" 뱃지. 서버가 source:'llm' 을 보내면 켜진다. */}
      {l.source === "llm" && (
        <span style={{ color: C.gold, fontSize: 11, marginRight: 6 }}>새로 생성됨</span>
      )}
      {l.speaker && <span style={{ color: C.dim, marginRight: 6 }}>{l.speaker.name}:</span>}
      {l.text}
    </p>
  );
}

function Fold({ lines }: { lines: LogLine[] }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <div style={{ borderLeft: `2px solid ${C.winHi}`, paddingLeft: 8, margin: "0 0 10px" }}>
        {lines.map((l) => (
          <p key={l.id} style={{ margin: "0 0 4px", color: C.dim, fontSize: 13 }}>
            {l.text}
          </p>
        ))}
        <button
          onClick={() => setOpen(false)}
          style={{
            background: "none",
            border: "none",
            color: C.dim,
            fontSize: 11,
            cursor: "pointer",
            padding: 0,
          }}
        >
          접기
        </button>
      </div>
    );
  }
  return (
    <p
      onClick={() => setOpen(true)}
      style={{ margin: "0 0 10px", color: C.dim, fontSize: 13, cursor: "pointer" }}
    >
      <span style={{ color: C.winHi }}>▸</span> 공방이 오갔다 · {lines.length}회{" "}
      <span style={{ opacity: 0.7 }}>— {lines[lines.length - 1]!.text}</span>
    </p>
  );
}

export function Log({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  /* 아래에 붙어 있을 때만 자동 스크롤한다. 전투 중에 위로 올려 읽는 사람을
     0.5초마다 아래로 끌어내리면 로그를 읽을 수가 없다. */
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const rows = fold(lines);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      style={{
        ...win,
        height: 260,
        overflowY: "auto",
        marginBottom: 12,
        lineHeight: 1.75,
        fontSize: 15,
      }}
    >
      {rows.map((r) =>
        r.kind === "line" ? (
          <Line key={r.line.id} l={r.line} />
        ) : (
          <Fold key={r.id} lines={r.lines} />
        ),
      )}
    </div>
  );
}
