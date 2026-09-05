/* 사람이 쓴 문자열이 와이어를 타기 전에 통과하는 유일한 관문.
   이름 · say · unparsed 가 전부 여기를 지난다. */

/* C0/C1 제어문자와 유니코드 bidi 오버라이드(RTL 스푸핑)를 제거한다.
   제거하지 않으면 U+202E 하나로 로그 한 줄의 표시 순서를 뒤집어
   "○○ 님이 들어왔다" 처럼 보이는 발화를 위조할 수 있다. */
// eslint-disable-next-line no-control-regex -- 제어문자를 "제거" 하는 것이 이 정규식의 목적이다. 이 줄이 없으면 다른 모든 곳에서 위험해진다.
const STRIP = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** 제어문자 제거 -> 공백류 축약 -> trim. 자르지 않는다 —
 *  길이 초과는 호출자가 '거절'한다. 자르면 의도가 조용히 바뀐다. */
export function sanitize(raw: string): string {
  return raw.replace(STRIP, "").replace(/\s+/g, " ").trim();
}

/** 이름만은 예외적으로 클램프한다: 거절할 곳이 없기 때문이다
 *  (hello 의 name 은 힌트일 뿐이고, 확정 이름은 서버가 welcome 으로 돌려준다). */
export function sanitizeName(raw: string | null, maxLen: number): string | null {
  if (raw == null) return null;
  const s = sanitize(raw).slice(0, maxLen);
  return s.length > 0 ? s : null;
}
