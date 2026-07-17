// SPDX-License-Identifier: AGPL-3.0-or-later
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  // The register's flag colour picker and swatches use template-literal
  // class names (`bg-${c}-500`, `border-${c}-600`, `text-${c}-500`) so
  // Tailwind's static scanner never sees them. Safelist keeps them in
  // the emitted bundle.
  safelist: [
    ...["red", "orange", "amber", "emerald", "sky", "violet", "rose"].flatMap(c => [
      `bg-${c}-500`, `bg-${c}-600`, `border-${c}-500`, `border-${c}-600`,
      `text-${c}-500`, `hover:bg-${c}-600`,
    ]),
  ],
  theme: { extend: {} },
  plugins: [],
};