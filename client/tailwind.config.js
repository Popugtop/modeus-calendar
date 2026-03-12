/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#151412',
        surface: '#222120',
        'input-bg': '#1a1917',
        border: '#333028',
        'border-focus': '#d97757',
        primary: '#ece8df',
        muted: '#9e9589',
        accent: '#d97757',
        'accent-hover': '#c96a46',
        'accent-light': 'rgba(217, 119, 87, 0.12)',
        error: '#e05555',
        success: '#4aad6f',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        'glow-accent': '0 0 0 3px rgba(217, 119, 87, 0.25)',
        'card': '0 1px 3px rgba(0,0,0,0.4), 0 8px 32px rgba(0,0,0,0.3)',
      },
    },
  },
  plugins: [],
};
