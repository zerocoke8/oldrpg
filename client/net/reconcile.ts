/* 클라이언트 재조정. 이 파일에 롤백 분기가 '없다'는 것이 요점이다.
 *
 * ack 가 성공이든 거절이든 '항상' 권위 pos 를 싣기 때문에, 화면 위치는 언제나
 * 순수 함수 replay(confirmed, pending) 이다. if (ok) 분기도, 되감기도 없다.
 *
 * pending 이 영원히 남을 수 있는 경로가 하나도 없다는 것도 계약이다:
 *   - 액션에 귀속 가능한 모든 실패는 ack 로 온다 (rate_limited 포함)
 *   - error 는 '항상' 연결을 끊으므로 pending 이 연결과 함께 사라진다 */

import type { Dir, Pos } from "../../shared/ids";
import { step } from "../../shared/ids";
import type { Ack, Snapshot } from "../../shared/protocol";

export class Reconciler {
  private confirmed: Pos = { region: "b1", x: 3, y: 3 };
  private pending: { seq: number; dir: Dir }[] = [];
  /** 발신 카운터. 연결 단위이고 '절대 되감지 않는다'. */
  private outSeq = 0;

  /** seq 발급의 유일한 지점. 모든 액션이 여기를 쓴다 —
   *  move 만 예측 큐에 들어가지만 seq 는 하나의 수열이어야 한다. */
  next(): number {
    return ++this.outSeq;
  }

  /** 예측 큐에 넣는다. maxPending 을 넘으면 넣지 않는다 (서버가 어차피 거절한다). */
  predictMove(seq: number, dir: Dir, maxPending: number): boolean {
    if (this.pending.length >= maxPending) return false;
    this.pending.push({ seq, dir });
    return true;
  }

  onAck(a: Ack): void {
    this.confirmed = a.pos; // ok 도 reason 도 읽지 않는다
    while (this.pending.length && this.pending[0]!.seq <= a.seq) this.pending.shift();
  }

  onSnapshot(s: Snapshot): void {
    this.confirmed = s.self.pos;
    this.pending = [];
    // ★ Math.max 로만 전진. ackSeq 로 대입하면 자기 발신 카운터가 되감겨
    //   이미 보낸 seq 를 재사용하고 서버가 bad_seq 로 연결을 끊는다.
    this.outSeq = Math.max(this.outSeq, s.ackSeq);
  }

  /** 연결이 새로 열렸다. seq 는 연결 단위이므로 여기서만 0으로 리셋한다. */
  onReconnect(): void {
    this.outSeq = 0;
    this.pending = [];
  }

  /** 화면에 그릴 위치. 확정 위치에 미확정 이동을 재생한 것. */
  view(): Pos {
    return this.pending.reduce((p, m) => step(p, m.dir), this.confirmed);
  }
}
