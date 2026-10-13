/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // The catalog pages and mystery boxes are retired: shoppers find things by asking in the chat.
  async redirects() {
    return ["/search", "/shop", "/boxes", "/boxes/:slug*"].map((source) => ({ source, destination: "/", permanent: false }));
  },
};
export default nextConfig;
