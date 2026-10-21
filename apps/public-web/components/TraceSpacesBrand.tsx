type TraceSpacesBrandProps = {
  className?: string;
  size?: "header" | "footer";
};

/** The official user-supplied TRACE artwork, cleaned to transparency and paired with SPACES. */
export function TraceSpacesBrand({
  className = "",
  size = "header",
}: TraceSpacesBrandProps) {
  return (
    <span
      aria-hidden="true"
      className={`trace-spaces-brand trace-spaces-brand--${size} ${className}`.trim()}
    >
      <img
        className="trace-spaces-brand__art"
        src="/trace-media/brand/trace-logo-transparent.png"
        alt=""
        width="184"
        height="113"
      />
      <span className="trace-spaces-brand__descriptor">SPACES</span>
    </span>
  );
}
