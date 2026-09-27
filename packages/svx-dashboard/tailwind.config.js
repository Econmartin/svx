/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{js,ts,jsx,tsx}', './components/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Apple dark-mode system palette (HIG): pure-black base, graphite
        // elevated surfaces, and the system accent colours. Green stays the
        // brand accent — it is Apple's systemGreen now, not a neon.
        bg: '#000000',
        surface: '#1c1c1e',
        'surface-elevated': '#2c2c2e',
        'surface-hover': '#3a3a3c',
        // Hairlines, not outlines — translucent white reads as an edge on
        // any material, the way macOS draws window and card borders.
        border: 'rgba(255, 255, 255, 0.08)',
        'border-strong': 'rgba(255, 255, 255, 0.16)',
        muted: '#8e8e93',
        'muted-strong': '#c7c7cc',
        fg: '#f5f5f7',
        accent: '#30d158',
        'accent-strong': '#3ae066',
        'accent-soft': '#30d15824',
        win: '#30d158',
        loss: '#ff453a',
        warn: '#ff9f0a',
        info: '#0a84ff',
      },
      fontFamily: {
        // Apple devices render the system face (SF Pro / SF Mono) from the
        // viewer's own OS — nothing of Apple's is hosted or shipped here, as
        // the SF font licence requires. Everyone else gets Geist.
        // `font-mono` marks NUMERIC content: the sans face with tabular
        // figures (see globals.css). Real code/identifiers use `font-code`.
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Geist', 'system-ui', 'sans-serif'],
        mono: ['-apple-system', 'BlinkMacSystemFont', 'Geist', 'system-ui', 'sans-serif'],
        code: ['ui-monospace', 'SF Mono', 'Geist Mono', 'Menlo', 'monospace'],
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
        card: 'inset 0 0.5px 0 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.4), 0 16px 40px -20px rgba(0,0,0,0.8)',
        pop: 'inset 0 0.5px 0 0 rgba(255,255,255,0.12), 0 0 0 0.5px rgba(255,255,255,0.08), 0 24px 64px -16px rgba(0,0,0,0.85)',
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
        // Menus and tooltips: a quick scale-in from their anchor, like AppKit.
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.96) translateY(-2px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgb(48 209 88 / 0.4)' },
          '50%': { boxShadow: '0 0 0 4px rgb(48 209 88 / 0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 2s linear infinite',
        'fade-in': 'fade-in 0.2s ease-out',
        'pop-in': 'pop-in 0.14s cubic-bezier(0.2, 0.9, 0.3, 1.2)',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      },
      backgroundImage: {
        'glow-corner-tl':
          'radial-gradient(circle at 0% 0%, rgba(48,209,88,0.10) 0%, rgba(48,209,88,0) 50%)',
        'glow-corner-br':
          'radial-gradient(circle at 100% 100%, rgba(48,209,88,0.06) 0%, rgba(48,209,88,0) 60%)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
