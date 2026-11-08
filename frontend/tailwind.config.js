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
        background: "#09090b",
        surface: "#121215",
        "surface-card": "#18181b",
        "surface-hover": "#222226",
        border: "#27272a",
        "border-hover": "#3f3f46",
        primary: {
          DEFAULT: "#6366f1",
          hover: "#4f46e5",
          light: "#818cf8",
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
