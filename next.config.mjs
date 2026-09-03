/** @type {import('next').NextConfig} */

const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },

  images: {
    unoptimized: true,
  },

  allowedDevOrigins: [
    "*.trycloudflare.com",
    "cubic-governments-positions-axis.trycloudflare.com",
  ],
}

export default nextConfig