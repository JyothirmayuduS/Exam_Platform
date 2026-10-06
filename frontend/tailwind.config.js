/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Paper palette — exam blue book aesthetic
        paper:   "#F7F5F0",
        raised:  "#EDEAE2",
        raised2: "#E3E0D6",
        ink:     "#1A1814",
        soft:    "#6E6B63",
        line:    "#C8C3B8",
        // Brand
        maroon:  "#7A1F2B",
        "maroon-soft": "#9B4450",
        forest:  "#284B34",
        "forest-soft": "#3D6B4B",
        amber:   "#B7791F",
        alert:   "#9B2C2C",
        success: "#2F6844",
      },
      fontFamily: {
        serif: ["'Source Serif 4'", "Georgia", "serif"],
        sans:  ["Inter", "system-ui", "sans-serif"],
        mono:  ["'IBM Plex Mono'", "monospace"],
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
