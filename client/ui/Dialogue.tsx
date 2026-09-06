/* 대화 패널. JRPG 커맨드 윈도우의 축소판이다 (5단계에서 이 모양이 확장된다).
 *
 * ★ 이 파일에는 게임 문장이 하나도 없다. 버튼의 라벨은 서버가 보낸
 *   TopicView.label 이고, 대사는 log{kind:"npc"} 로만 온다 —
 *   프로토콜 불변식 (1): 문장을 나르는 메시지는 log 뿐이다.
 *   ("말 걸기" 같은 UI 크롬은 Status.tsx 와 같은 예외다: 세계의 문장이
 *   아니라 조작 장치의 이름이다.)
 *
 * ★ 여기 보이는 주제 목록은 '안내' 이지 권한이 아니다. 잠긴 주제가 목록에
 *   없는 것은 스포일러 방지이고, 설령 devtools 로 ask 를 보내도
 *   world/dialogue.ts 가 다시 판정한다. */

import type { DialogueView, NpcBrief, RoomView } from "../../shared/protocol";
import { C, FONT, win } from "../theme";

type TalkAction = { type: "talk"; npcId: string } | { type: "ask"; npcId: string; topic: string };

const button = (active: boolean): React.CSSProperties => ({
  background: active ? C.gold : C.winHi,
  border: `2px solid ${active ? C.gold : C.line}`,
  color: active ? C.ink : C.text,
  padding: "8px 12px",
  fontFamily: FONT,
  fontSize: 13,
  cursor: "pointer",
  touchAction: "manipulation",
});

export function Dialogue(props: {
  room: RoomView;
  dialogue: DialogueView | null;
  act: (a: TalkAction) => void;
}) {
  const { room, dialogue, act } = props;
  const npcs: NpcBrief[] = room.npcs;
  if (!npcs.length) return null;

  return (
    <div style={{ ...win, marginBottom: 12, borderColor: C.npc }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 13, color: C.npc, marginRight: 2 }}>人</span>
        {npcs.map((n) => (
          <button
            key={n.id}
            onClick={() => act({ type: "talk", npcId: n.id })}
            style={button(dialogue?.npc.id === n.id)}
          >
            {n.name}
          </button>
        ))}
      </div>

      {/* 주제는 말을 건 뒤에만 보인다. 열려 있는 것만 서버가 준다. */}
      {dialogue && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {dialogue.topics.length === 0 ? (
            <span style={{ fontSize: 12, color: C.dim }}>— 더 물을 것이 없다 —</span>
          ) : (
            dialogue.topics.map((t) => (
              <button
                key={t.id}
                onClick={() => act({ type: "ask", npcId: dialogue.npc.id, topic: t.id })}
                style={button(false)}
              >
                {t.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
