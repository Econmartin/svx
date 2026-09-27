import type { MetadataRoute } from 'next';

/** The public showcase pages stay indexable; the trading desk does not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/fade-spike'] },
  };
}
