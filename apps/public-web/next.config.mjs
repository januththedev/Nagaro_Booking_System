const apiTarget = (process.env.API_PROXY_TARGET || process.env.API_ORIGIN || "http://127.0.0.1:4173").replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiTarget}/api/:path*` },
      { source: "/assets/:path*", destination: `${apiTarget}/assets/:path*` },
      { source: "/media/:path*", destination: `${apiTarget}/media/:path*` },
      { source: "/admin/:path*", destination: `${apiTarget}/admin/:path*` },
    ];
  },
};

export default nextConfig;
