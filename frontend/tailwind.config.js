/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--canvas)",
        surface: "var(--inset)",
        "surface-card": "var(--panel)",
        "surface-hover": "var(--raised-hover)",
        border: "var(--line)",
        "border-hover": "var(--line-strong)",
        primary: {
          DEFAULT: "var(--accent-fill)",
          hover: "var(--accent-hover)",
          light: "var(--accent)",
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}

