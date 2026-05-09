/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx}', './components/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0d12',
        surface: '#11141b',
        border: '#1c2230',
        muted: '#8c93a3',
        accent: '#7dd3fc',
        win: '#10b981',
        loss: '#ef4444',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
