/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Receiving uploads phone photos of case stickers through server actions (default limit is 1 MB).
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
};
export default nextConfig;
