/* 서술 로그. 화면에 문장이 올라오는 유일한 곳이다.
 *
 * ★ 배열 인덱스가 아니라 line.id 를 key 로 쓴다. 그것이 log.replace 의
 *   전제이고, 나중에 바꾸려면 이 컴포넌트를 통째로 갈아야 한다. */

import { useEffect, useRef } from "react";
import type { LogLine } from "../state/store";
import { C, logColor, win } from "../theme";

export function Log({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={ref}
      style={{ ...win, height: 260, overflowY: "auto", marginBottom: 12, lineHeight: 1.75, fontSize: 15 }}
    >
      {lines.map((l) => (
        <p key={l.id} style={{ margin: "0 0 10px", color: logColor(l.kind) }}>
          {/* 프로토타입의 "새로 생성됨" 뱃지. 1단계는 전부 fallback 이라 뜨지
              않지만, 2단계에 서버가 source:'llm' 을 보내는 순간 저절로 켜진다. */}
          {l.source === "llm" && (
            <span style={{ color: C.gold, fontSize: 11, marginRight: 6 }}>새로 생성됨</span>
          )}
          {l.speaker && (
            <span style={{ color: C.dim, marginRight: 6 }}>{l.speaker.name}:</span>
          )}
          {l.text}
        </p>
      ))}
    </div>
  );
}
