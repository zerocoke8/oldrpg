/* 백그라운드 생성 큐. charter 의 디렉터리 표에서 큐는 narration/ 소유다.
 *
 * 순수하게 '스케줄러' 다 — 중복 제거, 동시 실행 제한, 실패 쿨다운. DB 핸들도
 * 소켓도 없고, 무엇을 하는 작업인지도 모른다. 그래서 narration/ 이 db/ 를
 * import 하지 않는다는 규칙을 어기지 않고도 charter 의 배치를 지킬 수 있다.
 * 실제 배선(조회·기록·교체 통지)은 world/upgrade.ts 가 한다.
 *
 * ★ 중복 제거 키가 곧 charter 21줄의 '좌표 단위 생성 락' 이다:
 *   같은 (방, 상태) 에 두 명이 동시에 진입해도 작업은 하나만 돈다.
 *   프로세스를 넘는 정확성은 DB 의 PRIMARY KEY + ON CONFLICT DO NOTHING 이
 *   따로 쥐고 있다 (world/roomText.ts). 이건 '비용' 보증이다. */

export interface QueueOptions {
  /** 동시에 도는 작업 수. LLM 호출이라 크게 잡을 이유가 없다. */
  concurrency?: number;
  /** 실패한 키를 다시 시도하기까지 기다리는 시간(ms). */
  cooldownMs?: number;
  /** 이 횟수만큼 실패하면 그 키는 포기한다 (프로세스가 살아 있는 동안). */
  maxAttempts?: number;
  /** 대기열 상한. 넘으면 새 요청을 조용히 버린다 — 방이 19개인 지금은
   *  닿을 일이 없지만, 상한 없는 큐는 언젠가 메모리 사고가 된다. */
  maxPending?: number;
  clock?: () => number;
}

export interface QueueStats {
  pending: number;
  running: number;
  done: number;
  failed: number;
  givenUp: number;
}

export function makeQueue(run: (key: string) => Promise<void>, opts: QueueOptions = {}) {
  const concurrency = opts.concurrency ?? 2;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxPending = opts.maxPending ?? 500;
  const clock = opts.clock ?? (() => Date.now());

  const queued = new Set<string>(); // 대기 중 (순서 보존)
  const running = new Set<string>();
  const attempts = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();
  const givenUp = new Set<string>();
  let done = 0;
  let failed = 0;
  /** 큐가 완전히 빌 때를 기다리는 프라미스들 (테스트와 우아한 종료용). */
  let idleWaiters: (() => void)[] = [];
  let stopped = false;

  function settleIdle() {
    if (queued.size || running.size) return;
    const ws = idleWaiters;
    idleWaiters = [];
    for (const w of ws) w();
  }

  function pump(): void {
    if (stopped) return;
    while (running.size < concurrency && queued.size) {
      const key = queued.values().next().value as string;
      queued.delete(key);
      running.add(key);
      void run(key)
        .then(() => {
          done++;
          attempts.delete(key);
          cooldownUntil.delete(key);
        })
        .catch((err: unknown) => {
          failed++;
          const n = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, n);
          if (n >= maxAttempts) {
            givenUp.add(key);
            console.warn(`[queue] 포기 ${key} (${n}회 실패)`, err);
          } else {
            // 쿨다운. 계속 실패하는 방이 큐를 점유하지 않게 한다.
            cooldownUntil.set(key, clock() + cooldownMs);
          }
        })
        .finally(() => {
          running.delete(key);
          pump();
          settleIdle();
        });
    }
    settleIdle();
  }

  return {
    /** 이미 대기/실행 중이거나, 쿨다운 중이거나, 포기한 키는 무시한다.
     *  반환값은 '이 호출로 새로 큐에 들어갔는가'. */
    push(key: string): boolean {
      if (stopped) return false;
      if (queued.has(key) || running.has(key) || givenUp.has(key)) return false;
      const until = cooldownUntil.get(key);
      if (until !== undefined) {
        if (clock() < until) return false;
        cooldownUntil.delete(key);
      }
      if (queued.size >= maxPending) return false;
      queued.add(key);
      pump();
      return true;
    },

    /** 이 키의 작업이 지금 대기 중이거나 도는 중인가. */
    active(key: string): boolean {
      return queued.has(key) || running.has(key);
    },

    /** 큐가 빌 때까지. 테스트와 우아한 종료용. */
    idle(): Promise<void> {
      if (!queued.size && !running.size) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },

    /** 더 받지 않는다. 이미 도는 작업은 끝날 때까지 둔다. */
    stop(): void {
      stopped = true;
      queued.clear();
      settleIdle();
    },

    stats(): QueueStats {
      return { pending: queued.size, running: running.size, done, failed, givenUp: givenUp.size };
    },
  };
}

export type Queue = ReturnType<typeof makeQueue>;
