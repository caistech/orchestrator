import type { NextConfig } from 'next';

// Security headers. The tester found only HSTS present, on a page whose primary control sends email
// to a real customer — so clickjacking here is not theoretical: an invisible frame over "Approve and
// send" is a one-click outbound send by someone who never saw the queue.
const securityHeaders = [
  // Belt and braces: frame-ancestors is the modern rule, X-Frame-Options covers older browsers.
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Full URLs of an internal tool should not travel to third parties in a Referer header.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nothing here needs a camera, microphone or location; say so rather than leaving it open.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const config: NextConfig = {
  serverExternalPackages: ['@supabase/supabase-js'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
