/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './public/css/*.{html,js}',
    './public/**/*.{html,js}',
  ],
  theme: {
    extend: {},
  },
  plugins: [
    require('daisyui'),
  ],
  daisyui: {
    themes: [
      "light",
      "dark",
      "cupcake",
      "nord",
      "sunset",
    ],
  },
}

