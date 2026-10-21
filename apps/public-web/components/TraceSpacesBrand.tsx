type TraceSpacesBrandProps = {
  className?: string;
  size?: "header" | "footer";
};

/**
 * TRACE's angular orbit, redrawn as a resolution-independent brand lockup.
 * The mark inherits `currentColor` so the supplied blue identity can use an
 * accessible one-colour reverse treatment on dark photography and chrome.
 */
export function TraceSpacesBrand({
  className = "",
  size = "header",
}: TraceSpacesBrandProps) {
  return (
    <span
      aria-hidden="true"
      className={`trace-spaces-brand trace-spaces-brand--${size} ${className}`.trim()}
    >
      <span className="trace-spaces-brand__name">TRACE</span>
      <svg
        className="trace-spaces-brand__orbit"
        viewBox="0 0 72 72"
        fill="none"
        focusable="false"
      >
        <path d="M34 5 50 12 64 25 62 44 52 58 35 66 18 58 8 43 11 25 24 12 34 5Z" />
        <path d="M22 8 41 9 58 18 66 35 58 52 43 63 24 61 10 50 7 33 15 17 22 8Z" />
      </svg>
      <span className="trace-spaces-brand__descriptor">SPACES</span>
    </span>
  );
}
