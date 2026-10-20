import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiTarget = (process.env.API_PROXY_TARGET || process.env.API_ORIGIN || "http://127.0.0.1:4173").replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: resolve(here, "../.."),
  async rewrites() {
    if (process.env.VERCEL) return [];
    return [
      { source: "/api/:path*", destination: `${apiTarget}/api/:path*` },
      { source: "/assets/:path*", destination: `${apiTarget}/assets/:path*` },
      { source: "/media/:path*", destination: `${apiTarget}/media/:path*` },
      { source: "/admin/:path*", destination: `${apiTarget}/admin/:path*` },
    ];
  },
};

export default nextConfig;
