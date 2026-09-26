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
        // Hairlines, not outlines: a translucent white edge reads as depth on
        // any surface (the way macOS draws window and card edges) instead of
        // a green-tinted stroke competing with the accent.
        border: 'rgba(255, 255, 255, 0.075)',
        'border-strong': 'rgba(255, 255, 255, 0.14)',
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
        // `font-mono` marks NUMERIC content across the app. It now renders in
        // the sans face with tabular figures (see globals.css) — columns still
        // align, but numbers read like a native finance app rather than a
        // terminal. Real code/identifiers use `font-code`.
        mono: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        code: ['Geist Mono', 'ui-monospace', 'JetBrains Mono', 'Menlo', 'monospace'],
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      // Softer, more generous corners everywhere the app already asks for
      // rounding — one change instead of a hundred class edits.
      borderRadius: {
        md: '10px',
        lg: '14px',
        xl: '18px',
        '2xl': '22px',
      },
      boxShadow: {
        // Top inner highlight + long soft drop: the card lifts off the page.
        card: 'inset 0 1px 0 0 rgba(255,255,255,0.045), 0 1px 2px rgba(0,0,0,0.35), 0 12px 32px -16px rgba(0,0,0,0.7)',
        pop: 'inset 0 1px 0 0 rgba(255,255,255,0.06), 0 24px 60px -20px rgba(0,0,0,0.8)',
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
