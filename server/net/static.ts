/* 빌드된 클라이언트를 서빙한다. 의존성 없이 node:http 로.
 *
 * ★ 왜 게임 서버가 정적 파일을 주는가: 같은 오리진이어야 하기 때문이다.
 *   ws 를 별도 포트에 두면 (1) HTTPS 페이지에서 ws:// 가 mixed content 로
 *   차단되고 (2) 포트를 둘 열어야 하고 (3) CORS 를 신경 써야 한다.
 *   한 포트에서 정적 + 업그레이드를 처리하면 셋 다 사라진다.
 *
 * express 를 넣지 않은 이유: 필요한 것이 '파일 하나 읽어서 준다' 뿐이고,
 * 이 저장소의 런타임 의존성은 지금 넷이다. 하나를 더할 값이 아니다. */

import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticOptions {
  /** 없으면 안내 문구를 준다 (개발 중에는 vite 가 클라이언트를 서빙한다). */
  root: string;
}

export function makeStaticHandler({ root }: StaticOptions) {
  const dist = resolve(root);
  const indexPath = join(dist, "index.html");

  const send = (
    res: ServerResponse,
    status: number,
    body: string,
    type = "text/plain; charset=utf-8",
  ): void => {
    res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
    res.end(body);
  };

  function file(res: ServerResponse, path: string, immutable: boolean): void {
    const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      // 해시가 박힌 자산만 영구 캐시한다. index.html 은 절대 캐시하지 않는다 —
      // 캐시되면 배포해도 옛 번들을 계속 불러온다.
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(path)
      .on("error", () => res.destroy())
      .pipe(res);
  }

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "GET only");

    // 헬스체크. 배포 플랫폼이 이걸 보고 살아 있는지 판단한다.
    if (req.url === "/healthz") return send(res, 200, "ok");

    if (!existsSync(indexPath)) {
      return send(
        res,
        503,
        "클라이언트가 빌드되지 않았다. `npm run build` 를 먼저 돌릴 것.\n" +
          "(개발 중이라면 vite 개발 서버(5173)로 접속한다.)",
      );
    }

    // ★ 경로 탈출 방지. '..' 은 normalize 로 접히고, 그래도 dist 밖을 가리키면 거절한다.
    const url = (req.url ?? "/").split("?")[0]!;
    const decoded = (() => {
      try {
        return decodeURIComponent(url);
      } catch {
        return null; // 깨진 퍼센트 인코딩
      }
    })();
    if (decoded === null || decoded.includes("\0")) return send(res, 400, "bad path");

    const target = resolve(join(dist, normalize(decoded)));
    if (target !== dist && !target.startsWith(dist + sep)) return send(res, 403, "forbidden");

    if (target !== dist && existsSync(target) && statSync(target).isFile()) {
      // vite 는 해시가 박힌 파일을 assets/ 아래에 낸다.
      return file(res, target, target.startsWith(join(dist, "assets") + sep));
    }
    /* 나머지는 전부 index.html. 지금은 라우터가 없지만, 새로고침이 404 가 되는
       것보다 앱이 뜨는 편이 언제나 낫다. */
    return file(res, indexPath, false);
  };
}
