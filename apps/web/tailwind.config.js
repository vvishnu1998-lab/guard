/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        structure: '#1A1A2E',
        surface:   '#242436',
        border:    '#2E2E48',
        muted:     '#6B7280',
        // Brand source of truth (M1b) — usage migration happens in M2
        navy: '#0B1526',
        cyan: '#00C8FF',
        gold: '#C9A84C',
      },
    },
  },
  plugins: [],
};
