import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "client",
  /* ★ root 가 client/ 라 vite 는 기본적으로 client/.env 를 찾는다. 저장소 루트의
     .env(서버가 읽는 그 파일)를 함께 보게 한다 — 안 그러면 VITE_MUD_WS 같은
     스위치가 '있는데 안 읽히는' 상태가 된다. */
  envDir: __dirname,
  plugins: [react()],
  /* ★ root 가 client/ 라 vite 의 기본 outDir 은 client/dist 다. 서버는 저장소
     루트의 dist/ 를 서빙하므로 그대로 두면 배포된 서버가 빈손이 된다
     (빌드 로그의 "dist/index.html" 은 root 기준 상대경로라 눈으로는 안 보인다).
     산출물은 저장소 루트에 둔다 — Dockerfile 이 복사할 곳도 거기다. */
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    /* 개발 중에는 클라이언트가 5173, 서버가 8787 로 갈라져 있다. /ws 를 프록시하면
       클라이언트 코드가 개발·운영에서 똑같이 '같은 오리진의 /ws' 를 쓸 수 있다.
       분기를 클라이언트에 두지 않는 것이 요점이다. */
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${process.env.MUD_PORT ?? 8787}`, ws: true },
    },
  },
});
