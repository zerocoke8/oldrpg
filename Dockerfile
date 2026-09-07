# 이 저장소의 배포 단위는 '항상 켜져 있는 프로세스 하나 + 디스크 하나' 다.
#
# ★ 왜 서버리스가 아닌가: 권위 상태가 메모리에 있다 (세션 레지스트리, 0.5초
#   전투 틱, 리스폰 대기, 유예 타이머, 승급 큐). 요청 단위로 뜨고 지는 런타임
#   에서는 인스턴스 두 개가 곧 세계 두 개다. better-sqlite3 가 네이티브
#   애드온인 것은 그 다음 이유다.
#
# ★ 그래서 이 이미지는 '한 개만' 돌려야 한다. 수평 확장은 지금 구조에서
#   정답이 아니다 (지역별로 프로세스를 나누는 날 다시 생각한다).

# ── 빌드 ────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
# better-sqlite3 는 프리빌드가 없으면 여기서 컴파일된다.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# tsc --noEmit && vite build -> 저장소 루트의 dist/
RUN npm run build
# vite·playwright 같은 개발 의존성을 턴다. tsx 는 운영 진입점이라 남는다.
RUN npm prune --omit=dev

# ── 실행 ────────────────────────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    MUD_PORT=8787 \
    MUD_DB=/data/mud.db
# 서버는 TS 를 그대로 돈다(tsx). 빌드 산출물과 소스가 갈라지지 않는 것이
# 이 규모에서는 이득이 크다.
#
# ★ 런타임이 fs 로 읽는 뿌리는 여섯이고, 그중 둘은 server/ 밖에 있다:
#     server/db/schema.sql            migrate.ts
#     server/db/migrations/           migrate.ts
#     server/narration/prompts/       prompts.ts (.md — 프롬프트·톤·무드·목소리)
#     dist/                           net/static.ts (MUD_STATIC 기본값)
#     content/world/                  content/world.ts   ← server/ 밖
#     content/balance/                content/balance.ts ← server/ 밖
#   한때 이 목록이 "프롬프트와 스키마도 server/ 아래에 있다" 였고, 정확히
#   content/ 만 빼고 맞는 문장이었다. 그래서 이 이미지는 100% 시작 실패했다 —
#   boot() 이 DB 를 열기도 전에 loadBalance()/loadWorld() 를 부른다.
#   목록이 바뀌면 test/deploy.ts ⓪-c 가 빨개진다:
#     grep -rn "readFileSync\|readdirSync\|createReadStream" server/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/content ./content
COPY --from=build /app/package.json ./
# SQLite 파일이 사는 곳. 볼륨을 여기 붙인다.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MUD_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# ★ npx 나 npm 을 통해 띄우지 말 것. 그것들은 래퍼 프로세스라 컨테이너의
#   PID 1 이 되고, SIGTERM 이 실제 서버 프로세스에 닿지 않는다 — 우아한 종료가
#   조용히 사라진다 (여기서 실제로 그렇게 동작하는 것을 확인했다).
#   node 를 직접 띄우고 tsx 는 로더로 붙인다.
CMD ["node", "--import", "tsx", "server/index.ts"]
