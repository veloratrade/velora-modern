/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.VELORA_API_ORIGIN || 'http://127.0.0.1:8080';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Legacy pages are served at /<route>/ (trailing slash). Preserve URL shape.
  trailingSlash: true,
  async rewrites() {
    // Development/same-origin proxy only. The Fastify backend keeps its own
    // security headers and authentication contract; nothing is re-implemented here.
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
