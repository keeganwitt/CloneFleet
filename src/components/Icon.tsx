const paths = {
  chevronLeft: "m15 5-7 7 7 7",
  chevronRight: "m9 5 7 7-7 7",
  workspace: "M3 7h6l2 2h10v10H3z",
  overview: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  repos: "M7 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M8 3v18 M11 7h6",
  cleanup: "m3 15 11-11 7 7-10 10H9z M8 10l7 7 M6 18l3-3",
  attention: "M12 3 2.5 20h19z M12 9v4 M12 16h.01",
  work: "M7 8v8 M17 8c0 5-10 2-10 8 M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M17 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M7 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  activity: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 7v5l3 2",
  settings:
    "M10 3h4l.6 3 1.5.9L19 6l2 3-2.3 2v2l2.3 2-2 3-2.9-.9-1.5.9-.6 3h-4l-.6-3-1.5-.9L5 18l-2-3 2.3-2v-2L3 9l2-3 2.9.9 1.5-.9z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
};

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="app-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
