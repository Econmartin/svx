/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{js,ts,jsx,tsx}', './components/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Terminal-trader palette — near-black with a vibrant green primary.
        // Reference aesthetic: modern crypto perp trader (Hyperliquid, dYdX,
        // BlockTrade), not Bloomberg amber.
        bg: '#06090a',
        surface: '#0c1110',
        'surface-elevated': '#121916',
        'surface-hover': '#172220',
        border: '#1a2520',
        'border-strong': '#28342e',
        muted: '#7a8579',
        'muted-strong': '#a8b3a5',
        fg: '#e6efe8',
        accent: '#1eff8a',
        'accent-strong': '#10ff7d',
        'accent-soft': '#1eff8a14',
        win: '#1eff8a',
        // Softened from pure web-red #ef4444 — pure red fights green at
        // small sizes and reads as generic. Slight orange shift settles
        // it into the green/black palette without losing semantic clarity.
        loss: '#ff5a5f',
        warn: '#ffb648',
      },
      fontFamily: {
        // Geist Mono for all numerics — taste-skill priority swap (was
        // Inter + JetBrains Mono, the universal AI default stack).
        mono: ['Geist Mono', 'ui-monospace', 'JetBrains Mono', 'Menlo', 'monospace'],
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgb(30 255 138 / 0.4)' },
          '50%': { boxShadow: '0 0 0 4px rgb(30 255 138 / 0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 2s linear infinite',
        'fade-in': 'fade-in 0.2s ease-out',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      },
      backgroundImage: {
        'glow-corner-tl':
          'radial-gradient(circle at 0% 0%, rgba(30,255,138,0.10) 0%, rgba(30,255,138,0) 50%)',
        'glow-corner-br':
          'radial-gradient(circle at 100% 100%, rgba(30,255,138,0.06) 0%, rgba(30,255,138,0) 60%)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
