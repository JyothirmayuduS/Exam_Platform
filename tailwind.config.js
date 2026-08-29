/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#FAF9F6",
        "paper-raised": "#F1EEE7",
        ink: "#1C1C1A",
        "ink-soft": "#5B5952",
        line: "#D8D5CE",
        "line-strong": "#B8B4AA",
        maroon: {
          DEFAULT: "#7A1F2B",
          dark: "#5C1620",
          light: "#9B4450",
        },
        forest: {
          DEFAULT: "#284B34",
          light: "#3D6B4B",
        },
        amber: "#B7791F",
        alert: "#9B2C2C",
        success: "#2F6844",
      },
      fontFamily: {
        serif: ["'Source Serif 4'", "Georgia", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "monospace"],
      },
      borderRadius: {
        DEFAULT: "2px",
        sm: "1px",
        md: "3px",
        lg: "4px",
      },
    },
  },
  plugins: [],
};
