/* global Response, Headers */
// Inert stand-in for `next/server`, so a route handler can be executed from plain Node.
// `NextResponse` is a `Response` with the one static the routes use.
export class NextResponse extends Response {
  static json(body, init) {
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { ...init, headers });
  }
}
