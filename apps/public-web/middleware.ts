import { NextResponse, type NextRequest } from "next/server";

const BACKEND_FORM_POSTS = new Set([
  "/book",
  "/book/cancel",
  "/booking-request",
  "/booking-request/withdraw",
]);

export function middleware(request: NextRequest) {
  if (request.method === "POST" && (BACKEND_FORM_POSTS.has(request.nextUrl.pathname) || /^\/spaces\/[^/]+\/book$/.test(request.nextUrl.pathname))) {
    const destination = request.nextUrl.clone();
    destination.pathname = "/api/index";
    destination.search = "";
    const headers = new Headers(request.headers);
    headers.set("x-nagaro-original-url", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.rewrite(destination, { request: { headers } });
  }

  const response = NextResponse.next();
  if (
    request.nextUrl.pathname === "/book/confirmed" ||
    request.nextUrl.pathname === "/book/manage" ||
    request.nextUrl.pathname === "/booking-request/received" ||
    request.nextUrl.pathname === "/booking-request/withdraw"
  ) {
    response.headers.set("Cache-Control", "no-store, private");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return response;
}

export const config = {
  matcher: [
    "/book",
    "/book/cancel",
    "/book/confirmed",
    "/book/manage",
    "/booking-request",
    "/booking-request/received",
    "/booking-request/withdraw",
    "/spaces/:path*/book",
  ],
};
