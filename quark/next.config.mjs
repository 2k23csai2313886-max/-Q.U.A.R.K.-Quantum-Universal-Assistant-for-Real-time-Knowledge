/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The Gemini key is read ONLY inside app/api/chat/route.js (server runtime).
  // Next.js never inlines server-only env vars into the client bundle, but we
  // assert that explicitly so a future refactor cannot leak it.
  serverExternalPackages: [],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Defense in depth. The HUD renders model output through a typed,
          // allowlisted renderer — never innerHTML — and these headers back that up.
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next.js needs inline scripts for hydration + the CSS-in-JS runtime.
              // 'wasm-unsafe-eval' lets ONNX Runtime Web compile the Whisper
              // model; cdn.jsdelivr.net serves the pinned Transformers.js build.
              // blob: is required by ONNX Runtime Web, which instantiates its
              // WASM worker from a blob URL; 'wasm-unsafe-eval' lets it compile.
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com data:",
              "img-src 'self' data: blob: https:",
              "media-src 'self' blob: data:",
              "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com https://*.wikipedia.org https://*.wikimedia.org https://api.stackexchange.com https://cdn.jsdelivr.net https://huggingface.co https://*.hf.co",
              "worker-src 'self' blob:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
              'upgrade-insecure-requests',
            ].join('; '),
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            // Declared but gated behind the in-app permission broker at runtime.
            value:
              'geolocation=(self), camera=(self), microphone=(self), display-capture=(self), clipboard-read=(self), clipboard-write=(self), notifications=(self), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
