/** @type {import('next').NextConfig} */

const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },

  images: {
    unoptimized: true,
  },

  allowedDevOrigins: [
    "marilyn-ports-went-guests.trycloudflare.com",
  ],
}

export default nextConfig